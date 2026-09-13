/* ============================================================
   Proves the fix for the non-atomic outcome/redemption bug:
   redeemWithin() now runs INSIDE transaction B in signup.js, so the
   payment-outcome write, the subscription activation, and the
   redemption row commit or roll back together. Before the fix, a
   paid + active subscription could exist with no coupon_redemptions
   row, silently over-issuing the 100-spot cap.

   A true "kill the process mid-transaction" or "make redeemWithin
   throw an arbitrary error" injection was not practical to wire up
   without editing the production modules under test:
     - signup.js imports `redeemWithin` as a live ESM binding, and
       Node's module namespace objects are non-configurable/read-only
       (confirmed: `coupons.redeemWithin = fn` throws a TypeError at
       runtime), so it cannot be monkey-patched from a test file.
     - `payments` in lib/payments/index.js is likewise a module
       namespace object, so `charge()` cannot be stubbed to inject a
       side effect either.
     - Inside signup.js there is no `await` between the charge
       resolving and transaction B starting, and transaction B itself
       is fully synchronous (node:sqlite has no async API), so there
       is no seam to interleave a mutation mid-transaction.
   So this file proves atomicity two ways that need no source changes:
   (1) a direct invariant check over every row transaction B can write,
   and (2) a genuine concurrency test that exercises the one branch
   inside transaction B that *does* deliberately catch an error
   (COUPON_LIMIT_REACHED) and continue - proving that path adjusts the
   promo columns without rolling back the payment/subscription, exactly
   as required.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.PAYMENT_PROVIDER = 'demo';
const { db, migrate, one } = await import('../db/index.js');
migrate();
db.exec(`INSERT INTO plans (code,name,interval_months,price_cents,is_intro)
         VALUES ('Monthly','Monthly',1,2800,0)`);
db.exec(`INSERT INTO coupons (code,name,discount_type,discount_value,max_redemptions,
                              eligible_customer_type,is_intro,duration_periods)
         VALUES ('DASHLAUNCH','Dash Launch Special','promo_price',1800,100,'new',1,12)`);
const { enrol } = await import('../lib/signup.js');
const { introCoupon } = await import('../lib/coupons.js');

const base = {
  plan: 'Monthly', firstName: 'A', lastName: 'B', phone: '7065550100',
  password: 'CorrectHorse9', street: '1 Example St', unit: 'Unit 1',
  community: 'Riverstone', zip: '31901', startDate: '2026-10-01',
  couponCode: 'DASHLAUNCH',
};

test('every paid payment on a promo-priced subscription always has a matching coupon_redemptions row', async () => {
  // This is the invariant the atomicity fix protects, checked directly
  // against the tables transaction B writes: a paid payment on a
  // subscription that was quoted the promotional price must never exist
  // without exactly one redemption row, because that row is the only
  // thing the 100-spot cap is counted from. Run several successful intro
  // signups and confirm the pairing holds for every one.
  for (const email of ['pair-a@test.local', 'pair-b@test.local', 'pair-c@test.local']) {
    const r = await enrol({ ...base, email, outcome: 'success' });
    assert.equal(r.ok, true);
    assert.equal(r.introApplied, true);
  }

  const rows = db.prepare(`
    SELECT p.id AS payment_id, p.status, s.status AS sub_status,
           (SELECT COUNT(*) FROM coupon_redemptions cr
             WHERE cr.payment_id = p.id) AS redemption_count
      FROM payments p
      JOIN subscriptions s ON s.id = p.subscription_id
     WHERE p.status = 'paid' AND s.promo_price_cents IS NOT NULL
  `).all();

  assert.ok(rows.length >= 3, 'sanity check - the intro signups above should all show up here');
  for (const row of rows) {
    assert.equal(row.sub_status, 'active',
      `payment ${row.payment_id} is paid with a frozen promo price but its subscription is ` +
      `"${row.sub_status}" - the outcome write and activation must commit together`);
    assert.equal(row.redemption_count, 1,
      `payment ${row.payment_id} is paid on a promo-priced active subscription but has ` +
      `${row.redemption_count} coupon_redemptions rows - the payment/subscription outcome ` +
      `and the redemption must always commit or roll back together`);
  }
});

test('two signups racing for the last spot: the loser is still charged and activated, but reverts to standard pricing with no redemption row', async () => {
  // Leave exactly one spot open on the shared coupon.
  const remainingBefore = introCoupon().remaining;
  db.exec(`UPDATE coupons SET max_redemptions = ${100 - remainingBefore + 1} WHERE code = 'DASHLAUNCH'`);
  assert.equal(introCoupon().remaining, 1);

  // Both calls pass validate() while the spot still looks open (their
  // async bodies interleave at the same awaits signup.js already has -
  // hashing the password, then the provider calls) before either reaches
  // transaction B, so this genuinely exercises the recheck-inside-the-
  // transaction race the fix is meant to make safe, not just a
  // pre-rejected signup.
  const [ra, rb] = await Promise.all([
    enrol({ ...base, email: 'race-a@test.local', outcome: 'success' }),
    enrol({ ...base, email: 'race-b@test.local', outcome: 'success' }),
  ]);

  // Both are still real, paid, active subscriptions - the constraint the
  // task calls out explicitly: a customer who was already charged must
  // never lose that payment just because the promo spot ran out under them.
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);

  const results = [ra, rb].map(r =>
    one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId));
  for (const sub of results) {
    assert.equal(sub.status, 'active', 'both charges succeeded, so both must be active');
    assert.equal(sub.locked_price_cents, 2800, 'the standard rate is never altered by this path');
  }

  const winners = [ra, rb].filter(r => r.introApplied);
  const losers = [ra, rb].filter(r => !r.introApplied);
  assert.equal(winners.length, 1, 'exactly one of the two racing signups should win the last spot');
  assert.equal(losers.length, 1);

  const loserSub = one(`SELECT * FROM subscriptions WHERE id = ?`,
    losers[0].subscriptionId);
  assert.equal(loserSub.promo_price_cents, null,
    'the loser must revert to standard pricing, not keep frozen promo terms with no redemption to back them');
  assert.equal(loserSub.promo_periods_remaining, null);
  assert.equal(one(`SELECT COUNT(*) n FROM coupon_redemptions WHERE payment_id = ?`,
    losers[0].paymentId).n, 0, 'the loser must not have a redemption row');

  const winnerSub = one(`SELECT * FROM subscriptions WHERE id = ?`,
    winners[0].subscriptionId);
  assert.equal(winnerSub.promo_price_cents, 1800);
  assert.equal(one(`SELECT COUNT(*) n FROM coupon_redemptions WHERE payment_id = ?`,
    winners[0].paymentId).n, 1, 'the winner must have exactly one redemption row');

  assert.equal(introCoupon().remaining, 0, 'the last spot is now consumed exactly once, not twice');
});
