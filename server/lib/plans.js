/* ============================================================
   Plan data access: create / edit / duplicate, deletability, and
   the effective-dated price-change engine.

   Price rule: a plan's advertised price_cents changes immediately
   (new customers pay it at signup). Existing subscribers keep their
   locked_price_cents until a scheduled change's effective_date
   (default: change date + grace days) falls due — then, and only for
   'existing_and_new' changes, their locked price switches. Historical
   payments are never touched.
   ============================================================ */

import { one, all, run, tx } from '../db/index.js';
import { slugCode } from './billing.js';
import { setting } from './permissions.js';

/** A code not already used by another plan. */
export function uniqueCode(base) {
  const root = slugCode(base);
  if (!one(`SELECT id FROM plans WHERE code = ? COLLATE NOCASE`, root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}${n}`;
    if (!one(`SELECT id FROM plans WHERE code = ? COLLATE NOCASE`, candidate)) return candidate;
  }
}

export function createPlan(input, userId) {
  const {
    name, description = null, internalNotes = null, priceCents,
    intervalUnit, intervalCount, customerAvailable = 0, status = 'draft',
    displayOrder = null, label = null, currency = 'USD', code = null,
  } = input;
  const order = displayOrder ?? ((one(`SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM plans`).n) || 1);
  const id = run(`
    INSERT INTO plans (code, name, description, internal_notes, price_cents, currency,
                       interval_unit, interval_count, customer_available, status,
                       display_order, label, provider_plan_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo')`,
    code || uniqueCode(name), name, description, internalNotes, priceCents, currency,
    intervalUnit, intervalCount, customerAvailable ? 1 : 0, status, order, label).lastInsertRowid;
  return { id };
}

export function updatePlan(id, input, userId) {
  const cur = one(`SELECT * FROM plans WHERE id = ?`, id);
  if (!cur) throw Object.assign(new Error('Plan not found.'), { status: 404 });
  const v = {
    name: input.name ?? cur.name,
    description: input.description ?? cur.description,
    internal_notes: input.internalNotes ?? cur.internal_notes,
    price_cents: input.priceCents ?? cur.price_cents,
    currency: input.currency ?? cur.currency,
    interval_unit: input.intervalUnit ?? cur.interval_unit,
    interval_count: input.intervalCount ?? cur.interval_count,
    customer_available: input.customerAvailable === undefined
      ? cur.customer_available : (input.customerAvailable ? 1 : 0),
    display_order: input.displayOrder ?? cur.display_order,
    label: input.label === undefined ? cur.label : input.label,
  };
  run(`UPDATE plans SET name=?, description=?, internal_notes=?, price_cents=?, currency=?,
          interval_unit=?, interval_count=?, customer_available=?, display_order=?, label=?,
          updated_at=datetime('now')
        WHERE id=?`,
    v.name, v.description, v.internal_notes, v.price_cents, v.currency,
    v.interval_unit, v.interval_count, v.customer_available, v.display_order, v.label, id);
}

export function duplicatePlan(id, userId) {
  const p = one(`SELECT * FROM plans WHERE id = ?`, id);
  if (!p) throw Object.assign(new Error('Plan not found.'), { status: 404 });
  return createPlan({
    name: `${p.name} (Copy)`, description: p.description, internalNotes: p.internal_notes,
    priceCents: p.price_cents, currency: p.currency, intervalUnit: p.interval_unit,
    intervalCount: p.interval_count, customerAvailable: 0, status: 'draft',
    label: p.label,
  }, userId);
}

export function planCustomerCount(id) {
  return one(`SELECT COUNT(*) AS n FROM subscriptions
               WHERE plan_id = ? AND status != 'cancelled'`, id).n;
}

/** History-safe: a plan referenced by any subscription or coupon is never deleted. */
export function planDeletability(id) {
  const subs = one(`SELECT COUNT(*) AS n FROM subscriptions WHERE plan_id = ?`, id).n;
  const coup = one(`SELECT COUNT(*) AS n FROM coupon_plans WHERE plan_id = ?`, id).n;
  if (subs > 0) return { deletable: false, reason: `${subs} subscription(s) reference this plan. Archive it instead.` };
  if (coup > 0) return { deletable: false, reason: `A coupon targets this plan. Archive it instead.` };
  const appliedChanges = one(`SELECT COUNT(*) AS n FROM plan_price_changes
                               WHERE plan_id = ? AND status = 'applied'`, id).n;
  if (appliedChanges > 0) return { deletable: false, reason: `This plan has applied price-change history. Archive it instead.` };
  return { deletable: true, reason: null };
}

/** Cancel a still-scheduled price change. No-op-safe: only 'scheduled' rows cancel. */
export function cancelPriceChange(planId, pcId) {
  const res = run(`UPDATE plan_price_changes SET status = 'cancelled'
                    WHERE id = ? AND plan_id = ? AND status = 'scheduled'`, pcId, planId);
  if (!res.changes) {
    throw Object.assign(new Error('That scheduled price change no longer exists or cannot be cancelled.'), { status: 409 });
  }
}

export function deletePlan(id) {
  const del = planDeletability(id);
  if (!del.deletable) throw Object.assign(new Error(del.reason), { status: 409 });
  run(`DELETE FROM plans WHERE id = ?`, id);
}

/** Schedule a price change. Advertised price updates immediately. */
export function schedulePriceChange(id, { newPriceCents, appliesTo, effectiveDate, reason = null }, userId) {
  const plan = one(`SELECT * FROM plans WHERE id = ?`, id);
  if (!plan) throw Object.assign(new Error('Plan not found.'), { status: 404 });
  const oldPrice = plan.price_cents;
  const grace = setting('plan.price_change_grace_days', 90);
  const effective = effectiveDate
    || new Date(Date.now() + grace * 86400000).toISOString().slice(0, 10);

  return tx(() => {
    // Advertised price changes now — this is the "new customers" effect.
    run(`UPDATE plans SET price_cents = ?, updated_at = datetime('now') WHERE id = ?`, newPriceCents, id);
    // Existing-customer switch is recorded and applied at the effective date.
    if (appliesTo === 'existing_and_new') {
      const pcId = run(`
        INSERT INTO plan_price_changes (plan_id, old_price_cents, new_price_cents,
                                        applies_to, effective_date, reason, created_by)
        VALUES (?, ?, ?, 'existing_and_new', ?, ?, ?)`,
        id, oldPrice, newPriceCents, effective, reason, userId ?? null).lastInsertRowid;
      return { id: pcId, effectiveDate: effective };
    }
    return { id: null, effectiveDate: null };
  });
}

/**
 * Apply every scheduled existing_and_new change whose effective date has
 * arrived. Idempotent: each row flips to 'applied' so a re-run is a no-op.
 * Returns the number of change rows applied.
 */
export function applyDuePriceChanges() {
  const due = all(`SELECT * FROM plan_price_changes
                    WHERE status = 'scheduled' AND applies_to = 'existing_and_new'
                      AND effective_date <= date('now')`);
  let applied = 0;
  for (const pc of due) {
    tx(() => {
      // Every live subscription on this plan moves to the new standard rate,
      // whatever price it was previously locked at (a prior 'new'-scope change
      // may have left some subscribers on an intermediate price). Matching on
      // "not already at the new price" — rather than the change's captured old
      // price — keeps those subscribers from being stranded and makes a re-run
      // a no-op. A promo subscriber keeps their frozen promo_price_cents; only
      // their reversion rate (locked_price_cents) updates, as the promo expects.
      const subs = all(`SELECT id, locked_price_cents FROM subscriptions
                         WHERE plan_id = ? AND status IN ('active','past_due','paused')
                           AND locked_price_cents != ?`,
                        pc.plan_id, pc.new_price_cents);
      for (const s of subs) {
        run(`UPDATE subscriptions SET locked_price_cents = ? WHERE id = ?`, pc.new_price_cents, s.id);
        run(`INSERT INTO audit_log (action, entity_type, entity_id, detail)
             VALUES ('subscription.reprice', 'subscription', ?, ?)`,
          s.id, JSON.stringify({ planId: pc.plan_id, from: s.locked_price_cents, to: pc.new_price_cents, priceChangeId: pc.id }));
      }
      run(`UPDATE plan_price_changes SET status = 'applied', applied_at = datetime('now') WHERE id = ?`, pc.id);
    });
    applied++;
  }
  return applied;
}
