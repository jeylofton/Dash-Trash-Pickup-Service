/* ============================================================
   Task 8: the public wizard sends `plan: "Introductory"` and never
   sends a couponCode (see scripts.js). This file proves enrol()
   resolves that request into a promotion on the Monthly plan,
   decided entirely server-side from introCoupon() - never trusting
   a client-supplied coupon code to grant the promotional price.
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

// Exactly what the public wizard posts to /api/checkout: `plan:
// "Introductory"`, no couponCode at all (see scripts.js goToSignup()).
const base = {
  plan: 'Introductory', firstName: 'Pat', lastName: 'Wizard', phone: '7065550111',
  password: 'CorrectHorse9', street: '10 Example St', unit: 'Unit 1',
  community: 'Riverstone', zip: '31901', startDate: '2026-10-01',
};

test('1: a successful public introductory signup bills Monthly + the promotion, atomically', async () => {
  const r = await enrol({ ...base, email: 'wiz-a@test.local', outcome: 'success' });
  assert.equal(r.ok, true);
  assert.equal(r.introApplied, true);

  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId);
  assert.equal(sub.locked_price_cents, 2800, 'the standard Monthly price is what is locked');
  assert.equal(sub.promo_price_cents, 1800);
  assert.equal(sub.promo_periods_remaining, 12);

  assert.equal(one(`SELECT COUNT(*) n FROM coupon_redemptions WHERE subscription_id = ?`,
    r.subscriptionId).n, 1, 'exactly one redemption row');

  const cust = one(`SELECT * FROM customers WHERE id = ?`, r.customerId);
  assert.equal(cust.is_intro, 1);
});

test('2: /api/intro-spots\' own source (introCoupon().used) increases by exactly 1 after that signup', async () => {
  const before = introCoupon().used;
  const r = await enrol({ ...base, email: 'wiz-b@test.local', outcome: 'success' });
  assert.equal(r.ok, true);
  assert.equal(introCoupon().used, before + 1);
});

test('3: a failed public introductory signup increases the spot count by 0', async () => {
  const before = introCoupon().used;
  const r = await enrol({ ...base, email: 'wiz-c@test.local', outcome: 'failed' });
  assert.equal(r.ok, false);
  assert.equal(introCoupon().used, before);
});

test('4: at the coupon limit, an introductory signup succeeds at the standard price with no redemption', async () => {
  db.prepare(`UPDATE coupons SET max_redemptions = ? WHERE code = 'DASHLAUNCH'`).run(introCoupon().used);
  assert.equal(introCoupon().status, 'limit_reached');

  const r = await enrol({ ...base, email: 'wiz-d@test.local', outcome: 'success' });
  assert.equal(r.ok, true);
  assert.equal(r.introApplied, false);
  assert.equal(r.amountCents, 2800,
    'the server must charge (and report charging) the standard rate once the promotion is exhausted');

  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId);
  assert.equal(sub.locked_price_cents, 2800);
  assert.equal(sub.promo_price_cents, null);
  assert.equal(sub.promo_periods_remaining, null);
  assert.equal(one(`SELECT COUNT(*) n FROM coupon_redemptions WHERE subscription_id = ?`,
    r.subscriptionId).n, 0);

  // restore room for the remaining tests
  db.exec(`UPDATE coupons SET max_redemptions = 100 WHERE code = 'DASHLAUNCH'`);
});

test('5: a client-supplied coupon code cannot grant the promo price once it is exhausted', async () => {
  db.prepare(`UPDATE coupons SET max_redemptions = ? WHERE code = 'DASHLAUNCH'`).run(introCoupon().used);
  assert.equal(introCoupon().status, 'limit_reached');

  // A malicious or stale client names the code directly, on top of the
  // "Introductory" plan the wizard already sends.
  const r = await enrol({
    ...base, email: 'wiz-e@test.local', outcome: 'success', couponCode: 'DASHLAUNCH',
  });
  assert.equal(r.ok, true);
  assert.equal(r.introApplied, false, 'the client-named code must not override the server decision');

  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId);
  assert.equal(sub.locked_price_cents, 2800);
  assert.equal(sub.promo_price_cents, null);

  const pay = one(`SELECT * FROM payments WHERE id = ?`, r.paymentId);
  assert.equal(pay.amount_cents, 2800, 'the client cannot buy the $18 rate by merely naming the code');

  db.exec(`UPDATE coupons SET max_redemptions = 100 WHERE code = 'DASHLAUNCH'`);
});

test('6: the Introductory plan row is inactive, and naming it directly never bills its 1800 plan price', async () => {
  const planRow = one(`SELECT * FROM plans WHERE code = 'Introductory'`);
  assert.equal(planRow, undefined, 'no Introductory plan row exists in this test DB (never seeded here)');

  // Seed it the way the real app's seed data does, then deactivate it the
  // way migrate() now does, to prove the deactivated row can no longer be
  // selected as a billable plan.
  db.exec(`INSERT INTO plans (code,name,interval_months,price_cents,is_intro,active)
           VALUES ('Introductory','Introductory Rate',1,1800,1,0)`);

  const r = await enrol({ ...base, email: 'wiz-f@test.local', outcome: 'success' });
  // The public path always resolves "Introductory" to the Monthly plan
  // server-side, so this still succeeds - but never at the deactivated
  // plan's 1800 price.
  assert.equal(r.ok, true);
  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId);
  assert.equal(sub.locked_price_cents, 2800, 'never billed the inactive plan\'s own price');
  assert.notEqual(sub.plan_id, one(`SELECT id FROM plans WHERE code = 'Introductory'`).id,
    'the subscription must reference the Monthly plan, not the deactivated Introductory row');
});
