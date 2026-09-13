/* ============================================================
   Coverage for the whole-branch final review fixes:
     - a pending charge must not clear the frozen promotional terms
       (only a truly failed/declined charge may)
     - re-signing up with an email whose previous attempt never paid
       must succeed; one that HAS a paid payment must still be rejected
     - MRR must count a promotional subscription at the promotional
       price, not the standard rate it has not reverted to yet
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

const base = {
  plan: 'Introductory', firstName: 'Pat', lastName: 'Wizard', phone: '7065550111',
  password: 'CorrectHorse9', street: '10 Example St', unit: 'Unit 1',
  community: 'Riverstone', zip: '31901', startDate: '2026-10-01',
};

test('a pending charge leaves promo_price_cents and promo_periods_remaining intact and the subscription pending', async () => {
  const r = await enrol({ ...base, email: 'pending@test.local', outcome: 'pending' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'pending');
  assert.equal(r.error, undefined, 'pending is not a failure - no error message');

  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId);
  assert.equal(sub.status, 'pending');
  assert.equal(sub.promo_price_cents, 1800,
    'a settling-later charge must not have already lost its promotional term');
  assert.equal(sub.promo_periods_remaining, 12);

  const pay = one(`SELECT * FROM payments WHERE id = ?`, r.paymentId);
  assert.equal(pay.status, 'pending');
});

test('re-signing up with an email whose previous attempt never paid succeeds', async () => {
  const first = await enrol({ ...base, email: 'retry@test.local', outcome: 'failed' });
  assert.equal(first.ok, false);

  const second = await enrol({ ...base, email: 'retry@test.local', outcome: 'success' });
  assert.equal(second.ok, true, 'an abandoned, never-paid shell must not permanently burn the email');
  assert.equal(second.introApplied, true);

  // Exactly one user row for that email now exists, and it is the new one.
  assert.equal(one(`SELECT COUNT(*) n FROM users WHERE email = ?`, 'retry@test.local').n, 1);
});

test('re-signing up with an email that HAS a paid payment is still rejected', async () => {
  const first = await enrol({ ...base, email: 'paid@test.local', outcome: 'success' });
  assert.equal(first.ok, true);

  const second = await enrol({ ...base, email: 'paid@test.local', outcome: 'success' });
  assert.equal(second.ok, false, 'a real, already-paying customer must never be silently deleted and replaced');
  assert.match(second.error, /already/i);
});

test('MRR counts a promotional subscription at the promotional price', async () => {
  const r = await enrol({ ...base, email: 'mrr@test.local', outcome: 'success' });
  assert.equal(r.ok, true);
  assert.equal(r.introApplied, true);

  const mrr = one(`
    SELECT COALESCE(SUM(
      CAST(CASE WHEN s.promo_periods_remaining > 0 THEN s.promo_price_cents ELSE s.locked_price_cents END AS REAL)
      / p.interval_months), 0) AS c
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.id = ?`, r.subscriptionId);
  assert.equal(mrr.c, 1800, 'a $18 promotional customer must contribute $18 to MRR, not $28');
});
