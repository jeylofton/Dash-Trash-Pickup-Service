/* ============================================================
   Coupon validation and redemption.

   The rule that matters: checking a code changes nothing. A
   redemption row is written only by redeem(), which the checkout
   calls after payment succeeds. That is what stops a browser
   clicking the offer from consuming one of the 100 launch spots.
   ============================================================ */

import { one, all, run, tx } from '../db/index.js';
import { setting } from './permissions.js';

export const DISCOUNT_TYPES = ['fixed', 'percent', 'promo_price', 'free_period'];

/** Derived status — never stored, so it cannot go stale. */
export function couponStatus(coupon, usedCount) {
  if (coupon.disabled) return 'disabled';
  const now = new Date();
  if (coupon.starts_at && new Date(coupon.starts_at) > now) return 'scheduled';
  if (coupon.ends_at && new Date(coupon.ends_at) < now) return 'expired';
  if (coupon.max_redemptions != null && usedCount >= coupon.max_redemptions) return 'limit_reached';
  return 'active';
}

export function usedCount(couponId) {
  return one(`SELECT COUNT(*) AS n FROM coupon_redemptions
               WHERE coupon_id = ? AND status = 'completed'`, couponId).n;
}

/** Has this customer ever had an active paid subscription before now? */
export function customerType(customerId) {
  const prior = one(
    `SELECT 1 FROM payments p
      WHERE p.customer_id = ? AND p.status = 'paid'
      LIMIT 1`, customerId);
  return prior ? 'existing' : 'new';
}

export function withStatus(coupon) {
  const used = usedCount(coupon.id);
  const remaining = coupon.max_redemptions == null ? null
    : Math.max(0, coupon.max_redemptions - used);
  return { ...coupon, used, remaining, status: couponStatus(coupon, used) };
}

/** Compute the discount without recording anything. */
export function computeDiscount(coupon, priceCents) {
  const floor = setting('coupon.min_final_price_cents', 0);
  let final = priceCents;

  switch (coupon.discount_type) {
    case 'fixed':       final = priceCents - coupon.discount_value; break;
    case 'percent':     final = Math.round(priceCents * (1 - Math.min(100, coupon.discount_value) / 100)); break;
    case 'promo_price': final = coupon.discount_value; break;
    case 'free_period': final = 0; break;
  }
  // A discount may never take the price below the configured floor.
  final = Math.max(floor, Math.min(priceCents, final));
  return { originalCents: priceCents, finalCents: final, discountCents: priceCents - final };
}

/**
 * Can this customer use this code, for this plan, right now?
 * Returns { ok, reason?, coupon, quote } — and writes nothing.
 */
export function validate({ code, planId, customerId, priceCents, alreadyApplied = [] }) {
  const raw = one('SELECT * FROM coupons WHERE code = ?', String(code || '').trim());
  if (!raw) return { ok: false, reason: 'That code is not recognized.' };

  const coupon = withStatus(raw);
  if (coupon.status !== 'active') {
    const messages = {
      disabled: 'That code is no longer available.',
      scheduled: 'That promotion has not started yet.',
      expired: 'That promotion has ended.',
      limit_reached: 'That promotion has reached its limit.',
    };
    return { ok: false, reason: messages[coupon.status] || 'That code cannot be used.', coupon };
  }

  // Plan eligibility. No rows means every plan.
  const plans = all('SELECT plan_id FROM coupon_plans WHERE coupon_id = ?', coupon.id).map(r => r.plan_id);
  if (plans.length && planId && !plans.includes(Number(planId))) {
    return { ok: false, reason: 'That code does not apply to this plan.', coupon };
  }

  if (customerId) {
    const type = customerType(customerId);
    if (coupon.eligible_customer_type === 'new' && type !== 'new') {
      return { ok: false, reason: 'That promotion is for new customers only.', coupon };
    }
    if (coupon.eligible_customer_type === 'existing' && type !== 'existing') {
      return { ok: false, reason: 'That promotion is for existing customers only.', coupon };
    }

    const priorUses = all(
      `SELECT * FROM coupon_redemptions
        WHERE coupon_id = ? AND customer_id = ? AND status = 'completed'`, coupon.id, customerId);

    if (coupon.per_customer_limit === 'once' && priorUses.length) {
      return { ok: false, reason: 'You have already used that code.', coupon };
    }
    if (coupon.per_customer_limit === 'once_per_cycle') {
      const recent = priorUses.find(u =>
        (Date.now() - new Date(u.redeemed_at).getTime()) < 30 * 86400000);
      if (recent) return { ok: false, reason: 'That code can only be used once per billing cycle.', coupon };
    }
  }

  // Stacking is off unless BOTH the new coupon and every already-applied
  // coupon permit it — otherwise one permissive coupon would open the door.
  if (alreadyApplied.length) {
    const allStackable = coupon.allow_stacking
      && alreadyApplied.every(c => c.allow_stacking);
    if (!allStackable) {
      return { ok: false, reason: 'That code cannot be combined with another offer.', coupon };
    }
  }

  return { ok: true, coupon, quote: computeDiscount(coupon, priceCents) };
}

/**
 * Record a completed redemption. Call ONLY after payment succeeds.
 * Re-checks the limit inside the transaction so two simultaneous
 * checkouts cannot both take the last spot.
 */
export function redeem({ couponId, customerId, subscriptionId, paymentId, priceCents, type }) {
  return tx(() => {
    const coupon = one('SELECT * FROM coupons WHERE id = ?', couponId);
    if (!coupon) throw Object.assign(new Error('Coupon not found.'), { status: 404 });

    const used = one(`SELECT COUNT(*) AS n FROM coupon_redemptions
                       WHERE coupon_id = ? AND status = 'completed'`, couponId).n;
    if (coupon.max_redemptions != null && used >= coupon.max_redemptions) {
      throw Object.assign(new Error('That promotion just reached its limit.'),
                          { status: 409, code: 'COUPON_LIMIT_REACHED' });
    }

    const quote = computeDiscount(coupon, priceCents);
    const id = run(
      `INSERT INTO coupon_redemptions
         (coupon_id, customer_id, subscription_id, payment_id,
          original_price_cents, discount_cents, final_price_cents, customer_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      couponId, customerId, subscriptionId ?? null, paymentId ?? null,
      quote.originalCents, quote.discountCents, quote.finalCents,
      type || customerType(customerId)).lastInsertRowid;

    return { id, ...quote };
  });
}

/** The active launch promotion, if one is configured. */
export function introCoupon() {
  const raw = one(`SELECT * FROM coupons WHERE is_intro = 1 AND disabled = 0
                    ORDER BY id DESC LIMIT 1`);
  return raw ? withStatus(raw) : null;
}
