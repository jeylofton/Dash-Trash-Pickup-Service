import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.PAYMENT_PROVIDER = 'demo';
const { db, migrate, one } = await import('../db/index.js');
migrate();
db.exec(`INSERT INTO plans (code,name,interval_months,price_cents,is_intro)
         VALUES ('Monthly','Monthly',1,2800,0)`);
const { enrol } = await import('../lib/signup.js');

const base = {
  plan: 'Monthly', firstName: 'Ada', lastName: 'Byron',
  email: 'ada@test.local', phone: '7065550100', password: 'CorrectHorse9',
  street: '1 Example St', unit: 'Unit 1', community: 'Riverstone',
  zip: '31901', startDate: '2026-10-01',
};

test('a successful demo payment creates every local record', async () => {
  const r = await enrol({ ...base, outcome: 'success' });
  assert.equal(r.ok, true);

  const user = one(`SELECT * FROM users WHERE email = ?`, base.email);
  assert.equal(user.role, 'customer');
  assert.notEqual(user.password_hash, base.password, 'password must be hashed');

  const cust = one(`SELECT * FROM customers WHERE id = ?`, r.customerId);
  assert.equal(cust.user_id, user.id);

  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId);
  assert.equal(sub.status, 'active');
  assert.equal(sub.locked_price_cents, 2800);

  const pay = one(`SELECT * FROM payments WHERE id = ?`, r.paymentId);
  assert.equal(pay.status, 'paid');
  assert.equal(pay.provider, 'demo', 'demo transactions must be identifiable');
  assert.match(pay.provider_payment_id, /^demo_pay_/);

  assert.ok(one(`SELECT id FROM payment_methods WHERE customer_id = ?`, r.customerId));
  assert.ok(one(`SELECT id FROM service_addresses WHERE customer_id = ?`, r.customerId));
});

test('a failed demo payment leaves no active subscription and no collected revenue', async () => {
  const r = await enrol({ ...base, email: 'fail@test.local', outcome: 'failed' });
  assert.equal(r.ok, false);

  const sub = one(`SELECT s.* FROM subscriptions s JOIN customers c ON c.id = s.customer_id
                   JOIN users u ON u.id = c.user_id WHERE u.email = 'fail@test.local'`);
  assert.equal(sub.status, 'pending', 'a failed payment must not activate service');

  const pay = one(`SELECT p.* FROM payments p WHERE p.id = ?`, r.paymentId);
  assert.equal(pay.status, 'failed');
  assert.ok(pay.failure_reason);
});

test('a duplicate email is rejected before anything is charged', async () => {
  const r = await enrol({ ...base, outcome: 'success' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already/i);
});

test('a weak password is rejected', async () => {
  const r = await enrol({ ...base, email: 'weak@test.local', password: 'abc', outcome: 'success' });
  assert.equal(r.ok, false);
  assert.match(r.error, /password/i);
});

test('a provider that throws during charge is caught, marks the payment failed, and never activates service', async () => {
  const r = await enrol({ ...base, email: 'throws@test.local', outcome: 'not-a-real-outcome' });
  assert.equal(r.ok, false);
  assert.ok(r.paymentId, 'the ids from the pre-charge transaction must survive the catch block');

  const pay = one(`SELECT * FROM payments WHERE id = ?`, r.paymentId);
  assert.equal(pay.status, 'failed');
  assert.ok(pay.failure_reason, 'failure_reason must be populated when the provider throws');

  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, r.subscriptionId);
  assert.equal(sub.status, 'pending', 'a thrown provider error must never activate service');
});
