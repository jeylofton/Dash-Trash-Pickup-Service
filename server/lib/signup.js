/* ============================================================
   Turn a completed signup form into real local records.

   Order matters: everything is written to the database BEFORE the
   provider is called, so a charge can never exist without a row
   that explains it. The provider only ever hands back an opaque id
   and a status.
   ============================================================ */

import { payments, providerName } from './payments/index.js';
import { hashPassword, passwordProblem } from './auth.js';
import { tx, one, run } from '../db/index.js';
import { validate as validateCoupon, redeemWithin, introCoupon } from './coupons.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Reuse a unit when one already matches, so two neighbours in the same
 *  building do not create two units for the same address. */
function resolveUnit({ community, street, unit, zip }) {
  let com = one(`SELECT id FROM communities WHERE name = ? COLLATE NOCASE`, community);
  if (!com) {
    com = { id: run(`INSERT INTO communities (name, zip) VALUES (?, ?)`,
                    community, zip).lastInsertRowid };
  }
  const existing = one(
    `SELECT id FROM units WHERE community_id = ? AND label = ? COLLATE NOCASE`,
    com.id, unit);
  if (existing) return existing.id;

  return run(`INSERT INTO units (community_id, label, street, zip)
              VALUES (?, ?, ?, ?)`, com.id, unit, street, zip).lastInsertRowid;
}

export async function enrol(input) {
  const {
    plan, firstName, lastName, email, phone, password,
    street, unit, community, zip, startDate, outcome = 'success', couponCode,
  } = input;

  /* ---- validate before anything is created or charged ---- */
  const missing = Object.entries({
    plan, firstName, lastName, email, phone, password,
    street, unit, community, zip,
  }).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    return { ok: false, error: `Missing required fields: ${missing.join(', ')}` };
  }
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'That email address is not valid.' };
  if (!/^\d{5}$/.test(zip))  return { ok: false, error: 'ZIP code must be 5 digits.' };

  const pwProblem = passwordProblem(password);
  if (pwProblem) return { ok: false, error: pwProblem };

  // DESTRUCTIVE PATH, REACHABLE BY ANONYMOUS REQUESTS. Reusing an email
  // means DELETING the row that holds it, and users cascades to sessions,
  // employees and customers (schema.sql). POST /api/checkout is public and
  // unauthenticated, so anyone who can guess an email could otherwise
  // destroy the account behind it. Reuse is therefore allowed ONLY when the
  // existing row is unambiguously an abandoned customer shell: every
  // condition below must hold, and any doubt returns the duplicate error
  // and deletes nothing.
  let staleUserId = null;
  const existingUser = one(`SELECT id FROM users WHERE email = ?`, email);
  if (existingUser) {
    const reusableShell = one(
      `SELECT 1
         FROM users u
         -- (2) a customers row must exist: a user with no customer row is
         --     staff or a half-created account, never an abandoned signup.
         JOIN customers c ON c.user_id = u.id
        WHERE u.id = ?
          -- (1) never touch an admin or employee row, whatever else is
          --     true - deleting one would take their employees row and
          --     every session with it.
          AND u.role = 'customer'
          -- (3) no payment that represents money taken, owed, returned, or
          --     still in flight. 'pending' counts: a charge that may yet
          --     clear must not be discarded. Only 'failed'/'cancelled'
          --     payments (or none at all) mark a shell.
          AND NOT EXISTS (
            SELECT 1 FROM payments p
             WHERE p.customer_id = c.id
               AND p.status IN ('paid', 'pending', 'refunded', 'past_due'))
          -- (4) no live subscription. A subscription that is active,
          --     past_due or paused means a real, serviced customer no
          --     matter what the payment rows say. 'pending' is excluded
          --     because that is exactly the state transaction A leaves
          --     behind on a signup whose charge never succeeded - the
          --     shell this path exists to clear - and 'cancelled' is a
          --     closed account.
          AND NOT EXISTS (
            SELECT 1 FROM subscriptions s
             WHERE s.customer_id = c.id
               AND s.status NOT IN ('cancelled', 'pending'))
        LIMIT 1`, existingUser.id);

    if (!reusableShell) {
      return { ok: false, error: 'An account already exists for that email address.' };
    }
    staleUserId = existingUser.id;
  }

  // The introductory rate is a PROMOTION on the Monthly plan, not a plan of
  // its own — the `Introductory` plans row is kept (for old subscriptions'
  // foreign keys) but deactivated by migrate(), so it can never be looked
  // up as a billable plan again. The public wizard still sends
  // `plan: "Introductory"` (see scripts.js); resolve that here to Monthly
  // before anything else touches `plan`.
  const isIntroRequest = plan === 'Introductory';
  const planCode = isIntroRequest ? 'Monthly' : plan;

  const planRow = one(`SELECT * FROM plans WHERE code = ? AND active = 1`, planCode);
  if (!planRow) return { ok: false, error: `No active plan named "${planCode}".` };

  const passwordHash = await hashPassword(password);

  // A pre-check only — it changes nothing. The real, race-safe check
  // happens inside redeemWithin() in transaction B, after payment succeeds.
  // customerId is null here because no customer row exists yet.
  let couponQuote = null;
  if (isIntroRequest) {
    // THE SERVER DECIDES, NOT THE CLIENT: the public path resolves the
    // active launch promotion itself from introCoupon() and ignores any
    // couponCode the browser sent. A client that could name the coupon
    // could mint promotional spots past the 100-spot cap — see brief.
    // When the promotion is exhausted/expired/disabled/absent this simply
    // leaves couponQuote null, so the customer silently pays the standard
    // Monthly price instead of erroring.
    const launch = introCoupon();
    if (launch && launch.status === 'active') {
      const check = validateCoupon({
        code: launch.code, planId: planRow.id, customerId: null,
        priceCents: planRow.price_cents,
      });
      if (check.ok) couponQuote = { coupon: check.coupon, quote: check.quote };
    }
  } else if (couponCode) {
    // Not reachable from the public wizard (it never sends a plan other
    // than Introductory/Monthly/Quarterly/Annual with no couponCode).
    // Kept for admin-side/test use of enrol() with an explicit code.
    const check = validateCoupon({
      code: couponCode, planId: planRow.id, customerId: null,
      priceCents: planRow.price_cents,
    });
    if (check.ok) couponQuote = { coupon: check.coupon, quote: check.quote };
  }

  // The first charge is the promotional price when a valid intro code was
  // quoted; locked_price_cents always stays the standard plan price - the
  // rate this customer reverts to once the promotional term ends.
  const priceCents = couponQuote ? couponQuote.quote.finalCents : planRow.price_cents;

  /* ---- transaction A: every record, nothing charged yet ---- */
  const ids = tx(() => {
    // Clear the abandoned shell before reusing its email - cascades remove
    // its customer/subscription/payment rows too (see schema.sql), and
    // this must happen inside the same transaction as the new user insert
    // so a crash between the two can never leave the email unusable.
    if (staleUserId) run(`DELETE FROM users WHERE id = ?`, staleUserId);

    const unitId = resolveUnit({ community, street, unit, zip });

    const userId = run(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
       VALUES (?, ?, 'customer', ?, ?, ?)`,
      email, passwordHash, firstName, lastName, phone).lastInsertRowid;

    // 'paused', not the column default 'active': nothing has been charged
    // yet at this point. An 'active' customer is counted in the admin
    // overview and picked up by unitsForRoute() in schedule.js, which would
    // put a signup whose charge later fails or never settles onto a real
    // pickup route. Transaction B promotes this to 'active' only once the
    // charge comes back 'paid'.
    const customerId = run(
      `INSERT INTO customers (user_id, provider, status) VALUES (?, ?, 'paused')`,
      userId, providerName).lastInsertRowid;

    run(`INSERT INTO service_addresses (customer_id, unit_id, start_date)
         VALUES (?, ?, ?)`, customerId, unitId, startDate || null);

    // locked_price_cents is always the standard plan price - the rate this
    // customer reverts to once any promotional term ends - never the
    // promotional price, so a later plan-price change can never reach them.
    const subscriptionId = run(
      `INSERT INTO subscriptions (customer_id, plan_id, locked_price_cents,
                                  promo_price_cents, promo_periods_remaining,
                                  status, provider, started_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      customerId, planRow.id, planRow.price_cents,
      couponQuote ? couponQuote.quote.finalCents : null,
      couponQuote ? couponQuote.coupon.duration_periods : null,
      providerName,
      startDate || new Date().toISOString().slice(0, 10)).lastInsertRowid;

    const paymentId = run(
      `INSERT INTO payments (customer_id, subscription_id, amount_cents, status, provider)
       VALUES (?, ?, ?, 'pending', ?)`,
      customerId, subscriptionId, priceCents, providerName).lastInsertRowid;

    return { userId, customerId, subscriptionId, paymentId };
  });

  /* ---- provider: vault, then charge ---- */
  let charge;
  try {
    const cust = await payments.createCustomer({ firstName, lastName, email, phone });
    run(`UPDATE customers SET provider_customer_id = ? WHERE id = ?`,
        cust.providerCustomerId, ids.customerId);

    const method = await payments.savePaymentMethod({
      providerCustomerId: cust.providerCustomerId,
      cardholderName: `${firstName} ${lastName}`,
      billingZip: zip,
    });
    run(`INSERT INTO payment_methods (customer_id, provider, provider_customer_id,
                                      provider_method_id, brand, last_4, exp_month, exp_year)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ids.customerId, providerName, cust.providerCustomerId, method.providerMethodId,
        method.brand, method.last4, method.expMonth, method.expYear);

    charge = await payments.charge({
      amountCents: priceCents,
      providerCustomerId: cust.providerCustomerId,
      providerMethodId: method.providerMethodId,
      // Derived from the payment row, never random: a replayed request
      // returns the original charge instead of charging twice.
      idempotencyKey: `pay:${ids.paymentId}`,
      reference: `pay:${ids.paymentId}`,
      outcome,
    });
  } catch (err) {
    run(`UPDATE payments SET status = 'failed', failure_reason = ? WHERE id = ?`,
        payments.describeError(err), ids.paymentId);
    // No charge went through, so no promotion was granted - the frozen
    // promotional terms from transaction A must not survive onto a
    // subscription that never actually paid for them.
    run(`UPDATE subscriptions SET promo_price_cents = NULL,
                                  promo_periods_remaining = NULL
          WHERE id = ?`, ids.subscriptionId);
    return { ok: false, ...ids, status: 'failed', introApplied: false,
             amountCents: priceCents, error: payments.describeError(err) };
  }

  /* ---- transaction B: record the outcome, and - when paid - the
     redemption, atomically. redeemWithin() must run inside THIS
     transaction (not its own): if the process dies, or the coupon
     limit was hit, between marking the payment paid and recording the
     redemption, an uncounted promotional spot could otherwise be
     handed out past the 100-spot cap. ---- */
  let introApplied = false;
  tx(() => {
    run(`UPDATE payments SET status = ?, provider_payment_id = ?,
                             failure_reason = ?, paid_at = ?
          WHERE id = ?`,
        charge.status, charge.providerPaymentId, charge.failureReason,
        charge.status === 'paid' ? new Date().toISOString() : null,
        ids.paymentId);

    if (charge.status === 'paid') {
      const next = new Date(startDate || Date.now());
      next.setMonth(next.getMonth() + planRow.interval_months);
      run(`UPDATE subscriptions SET status = 'active', next_billing_date = ?
            WHERE id = ?`, next.toISOString().slice(0, 10), ids.subscriptionId);

      // Only a paid charge makes this a serviceable customer - this is the
      // one place customers.status becomes 'active', so an unpaid signup is
      // never counted or routed. Written inside transaction B with the
      // payment outcome so the two can never disagree.
      run(`UPDATE customers SET status = 'active' WHERE id = ?`, ids.customerId);

      if (couponQuote) {
        try {
          redeemWithin({
            couponId: couponQuote.coupon.id,
            customerId: ids.customerId,
            subscriptionId: ids.subscriptionId,
            paymentId: ids.paymentId,
            priceCents: planRow.price_cents,
            type: 'new',
          });
          run(`UPDATE customers SET is_intro = 1 WHERE id = ?`, ids.customerId);
          introApplied = true;
        } catch (err) {
          if (err.code !== 'COUPON_LIMIT_REACHED') throw err;
          // The spot was taken between validation and completion. The
          // customer was already charged the promotional amount for this
          // first period - that stands, they were quoted it - but no
          // ongoing promotion was granted, so the frozen terms come off.
          // Caught here (inside the transaction) rather than rethrown so
          // the payment/activation writes above still COMMIT - only the
          // promotional terms are reverted, not the successful charge.
          run(`UPDATE subscriptions SET promo_price_cents = NULL,
                                        promo_periods_remaining = NULL
                WHERE id = ?`, ids.subscriptionId);
        }
      }
    } else if (charge.status === 'failed') {
      // Declined/failed charge: no promotion was granted, so the frozen
      // promotional terms from transaction A must not linger.
      run(`UPDATE subscriptions SET promo_price_cents = NULL,
                                    promo_periods_remaining = NULL
            WHERE id = ?`, ids.subscriptionId);
    }
    // else: pending. Nothing settled yet either way - the subscription
    // stays 'pending' (its default from transaction A) and the frozen
    // promotional terms are left exactly as granted, so a charge that
    // later clears still honors the 12-month $18 term it was quoted.
  });

  // Informational only, read fresh after any redemption above - never used
  // to decide anything for THIS signup, which was already decided.
  const launch = introCoupon();

  return {
    ok: charge.status === 'paid',
    ...ids,
    status: charge.status,
    introApplied,
    amountCents: priceCents,
    remainingSpots: launch ? launch.remaining : null,
    // Pending is not a failure - leave error unset so callers do not show
    // it as one; only an actually failed/declined charge gets a message.
    error: charge.status === 'failed'
      ? (charge.failureReason || 'The payment did not complete.')
      : undefined,
  };
}
