/* ============================================================
   Security regression coverage for the email-reuse path in
   lib/signup.js.

   POST /api/checkout is PUBLIC and UNAUTHENTICATED, and reusing an
   email DELETES the user row that holds it - which cascades to
   sessions, employees and customers. These tests pin down that the
   delete can only ever reach an abandoned customer shell: staff
   accounts and any customer with money taken, in flight, returned,
   owed, or with a live subscription must survive a signup attempt
   that names their email.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.PAYMENT_PROVIDER = 'demo';
const { db, migrate, one, run } = await import('../db/index.js');
migrate();
db.exec(`INSERT INTO plans (code,name,interval_unit,interval_count,price_cents,is_intro,status,customer_available)
         VALUES ('Monthly','Monthly','month',1,2800,0,'active',1)`);
const { enrol } = await import('../lib/signup.js');

const base = {
  plan: 'Monthly', firstName: 'Mal', lastName: 'Actor', phone: '7065550199',
  password: 'CorrectHorse9', street: '99 Example St', unit: 'Unit 9',
  community: 'Riverstone', zip: '31901', startDate: '2026-10-01',
};

/** A staff user with no customers row - exactly what an admin or an
 *  employee looks like in this schema. */
function makeStaff(email, role) {
  const id = run(
    `INSERT INTO users (email, password_hash, role, first_name, last_name)
     VALUES (?, 'x', ?, 'Staff', 'Member')`, email, role).lastInsertRowid;
  if (role === 'employee') {
    run(`INSERT INTO employees (user_id, employee_code) VALUES (?, ?)`, id, `E${id}`);
  }
  return id;
}

test('a signup naming an ADMIN email is rejected and the admin user survives', async () => {
  const email = 'admin@dashtrashpickup.local';
  const adminId = makeStaff(email, 'admin');

  const r = await enrol({ ...base, email, outcome: 'success' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already/i);

  const still = one(`SELECT id, role FROM users WHERE id = ?`, adminId);
  assert.ok(still, 'an anonymous signup must never delete an admin account');
  assert.equal(still.role, 'admin');
  assert.equal(one(`SELECT id FROM users WHERE email = ?`, email).id, adminId,
    'the admin row must be the SAME row, not a replacement');
});

test('a signup naming an EMPLOYEE email is rejected and the employee user survives', async () => {
  const email = 'driver@dashtrashpickup.local';
  const empUserId = makeStaff(email, 'employee');

  const r = await enrol({ ...base, email, outcome: 'success' });
  assert.equal(r.ok, false);
  assert.match(r.error, /already/i);

  assert.ok(one(`SELECT id FROM users WHERE id = ?`, empUserId),
    'an anonymous signup must never delete an employee account');
  assert.ok(one(`SELECT id FROM employees WHERE user_id = ?`, empUserId),
    'the cascaded employees row must survive too');
});

test('a customer with a PAID payment is rejected and survives', async () => {
  const email = 'paying@test.local';
  const first = await enrol({ ...base, email, outcome: 'success' });
  assert.equal(first.ok, true);

  const second = await enrol({ ...base, email, outcome: 'success' });
  assert.equal(second.ok, false);
  assert.match(second.error, /already/i);
  assert.ok(one(`SELECT id FROM customers WHERE id = ?`, first.customerId));
});

test('a shell whose only payment FAILED and has no live subscription can be reused', async () => {
  const email = 'shell@test.local';
  const first = await enrol({ ...base, email, outcome: 'failed' });
  assert.equal(first.ok, false);
  assert.equal(one(`SELECT status FROM payments WHERE id = ?`, first.paymentId).status, 'failed');

  const second = await enrol({ ...base, email, outcome: 'success' });
  assert.equal(second.ok, true, 'an abandoned shell must not burn the email forever');
  assert.equal(one(`SELECT COUNT(*) n FROM users WHERE email = ?`, email).n, 1);
  assert.equal(one(`SELECT id FROM customers WHERE id = ?`, first.customerId), undefined,
    'the old shell is gone');
});

test('a customer with a PENDING payment is rejected and survives', async () => {
  const email = 'inflight@test.local';
  const first = await enrol({ ...base, email, outcome: 'pending' });
  assert.equal(first.status, 'pending');
  const userId = one(`SELECT user_id FROM customers WHERE id = ?`, first.customerId).user_id;

  const second = await enrol({ ...base, email, outcome: 'success' });
  assert.equal(second.ok, false, 'a charge still in flight must never be discarded');
  assert.match(second.error, /already/i);
  assert.ok(one(`SELECT id FROM users WHERE id = ?`, userId));
  assert.ok(one(`SELECT id FROM customers WHERE id = ?`, first.customerId));
});

test('a customer with an ACTIVE subscription but no paid payment is rejected', async () => {
  const email = 'serviced@test.local';
  const first = await enrol({ ...base, email, outcome: 'failed' });
  const userId = one(`SELECT user_id FROM customers WHERE id = ?`, first.customerId).user_id;
  // A real, serviced customer whose charges have all gone bad - the
  // subscription is what makes them real, not the payment rows.
  run(`UPDATE subscriptions SET status = 'active' WHERE id = ?`, first.subscriptionId);

  const second = await enrol({ ...base, email, outcome: 'success' });
  assert.equal(second.ok, false, 'a live subscription means a real customer');
  assert.match(second.error, /already/i);
  assert.ok(one(`SELECT id FROM users WHERE id = ?`, userId));
});

test('customers.status tracks the charge outcome, not the signup attempt', async () => {
  const bad = await enrol({ ...base, email: 'unpaid-status@test.local', outcome: 'failed' });
  assert.equal(bad.ok, false);
  const badCust = one(`SELECT status FROM customers WHERE id = ?`, bad.customerId);
  assert.notEqual(badCust.status, 'active',
    'an unpaid signup must not be counted as a customer or put on a route');

  const good = await enrol({ ...base, email: 'paid-status@test.local', outcome: 'success' });
  assert.equal(good.ok, true);
  assert.equal(one(`SELECT status FROM customers WHERE id = ?`, good.customerId).status, 'active');
});
