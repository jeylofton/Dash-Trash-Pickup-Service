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

test('a successful intro signup locks the 12-month term and consumes one spot', async () => {
  assert.equal(introCoupon().remaining, 100);

  const r = await enrol({ ...base, email: 'a@test.local', outcome: 'success' });
  assert.equal(r.ok, true);
  assert.equal(r.introApplied, true);

  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId);
  // The promotional price and its term are frozen on the subscription;
  // locked_price_cents holds the standard rate this customer reverts to.
  assert.equal(sub.promo_price_cents, 1800);
  assert.equal(sub.promo_periods_remaining, 12);
  assert.equal(sub.locked_price_cents, 2800,
               'the post-promotion rate is locked at signup too');

  const pay = one(`SELECT * FROM payments WHERE id = ?`, r.paymentId);
  assert.equal(pay.amount_cents, 1800, 'the first charge is the promotional price');

  assert.equal(introCoupon().remaining, 99);
  assert.equal(one(`SELECT COUNT(*) n FROM coupon_redemptions`).n, 1);
});

test('a failed payment consumes no spot', async () => {
  const before = introCoupon().remaining;
  const r = await enrol({ ...base, email: 'b@test.local', outcome: 'failed' });
  assert.equal(r.ok, false);
  assert.equal(introCoupon().remaining, before, 'a failure must not use a spot');
  assert.equal(one(`SELECT COUNT(*) n FROM coupon_redemptions`).n, 1);
});

test('a declined payment consumes no spot', async () => {
  const before = introCoupon().remaining;
  await enrol({ ...base, email: 'c@test.local', outcome: 'declined' });
  assert.equal(introCoupon().remaining, before);
});

test('the promotion closes at its limit and the next customer pays full price', async () => {
  db.exec(`UPDATE coupons SET max_redemptions = 1 WHERE code = 'DASHLAUNCH'`);
  assert.equal(introCoupon().status, 'limit_reached');

  const r = await enrol({ ...base, email: 'd@test.local', outcome: 'success' });
  assert.equal(r.ok, true);
  assert.equal(r.introApplied, false, 'the offer is closed');
  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId);
  assert.equal(sub.locked_price_cents, 2800, 'full price once the promo is exhausted');
  assert.equal(sub.promo_price_cents, null, 'no promotion was applied');
});

test('an earlier intro customer keeps the promotion after it closes', () => {
  const sub = one(`SELECT s.* FROM subscriptions s
                   JOIN customers c ON c.id = s.customer_id
                   JOIN users u ON u.id = c.user_id WHERE u.email = 'a@test.local'`);
  assert.equal(sub.promo_price_cents, 1800,
               'existing promotional pricing must never be revoked');
  assert.equal(sub.promo_periods_remaining, 12,
               'their remaining promotional months must not be shortened');
});

test('disabling the coupon does not touch an existing promotional subscription', () => {
  db.exec(`UPDATE coupons SET disabled = 1 WHERE code = 'DASHLAUNCH'`);
  const sub = one(`SELECT s.* FROM subscriptions s
                   JOIN customers c ON c.id = s.customer_id
                   JOIN users u ON u.id = c.user_id WHERE u.email = 'a@test.local'`);
  assert.equal(sub.promo_price_cents, 1800);
  assert.equal(sub.promo_periods_remaining, 12);
});
