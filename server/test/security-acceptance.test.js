/* ============================================================
   Security acceptance tests (spec 49).

   These boot the REAL app - every middleware, guard and router - over
   a fresh in-memory database seeded with one admin, one employee and
   two customers, then attack it over HTTP the way an outsider would.
   Most prove a guard that already holds; that is the point. Nothing
   here should ever start failing, and if a future change quietly drops
   a guard, one of these turns red.

   Attack surface (from the audit): unauthenticated access, role
   boundaries, object-level ownership (cross-customer data, photo
   IDOR, an employee servicing a stop that isn't theirs), URL/param
   tampering, mass assignment, self-privilege escalation, password
   leakage, login brute force, SQL injection, and the CSP that backs
   the XSS defence.
   ============================================================ */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';

// Environment MUST be set before importing anything that opens the DB.
process.env.DB_PATH = ':memory:';
process.env.DEV_RELOAD = '0';                 // no fs.watch handle to keep us alive
process.env.NODE_ENV = 'test';                // not production: forceHttps is a no-op
process.env.PAYMENT_PROVIDER = 'demo';
process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'dash-photos-'));

const { one, run } = await import('../db/index.js');
const { hashPassword } = await import('../lib/auth.js');
const { storage } = await import('../lib/storage.js');
const { enrol } = await import('../lib/signup.js');
const { app } = await import('../server.js');  // runs migrations on import

/* ---------- seed ---------- */

run(`INSERT INTO plans (code,name,interval_unit,interval_count,price_cents,is_intro,status,customer_available)
     VALUES ('Monthly','Monthly','month',1,2800,0,'active',1)`);

const PW = 'Passw0rd99';
const pwHash = await hashPassword(PW);

const adminUserId = run(
  `INSERT INTO users (email,password_hash,role,first_name,last_name)
   VALUES ('admin@t.local',?,'admin','Ad','Min')`, pwHash).lastInsertRowid;

const empUserId = run(
  `INSERT INTO users (email,password_hash,role,first_name,last_name)
   VALUES ('emp@t.local',?,'employee','Em','Ploy')`, pwHash).lastInsertRowid;
const empId = run(
  `INSERT INTO employees (user_id, employee_code, status) VALUES (?, 'E1', 'active')`,
  empUserId).lastInsertRowid;

const custA = await enrol({
  plan: 'Monthly', email: 'a@t.local', password: PW,
  firstName: 'Alice', lastName: 'Ay', phone: '7065550001',
  street: '1 A St', unit: '1', community: 'Acme', zip: '31901',
  startDate: '2026-10-01', outcome: 'success',
});
const custB = await enrol({
  plan: 'Monthly', email: 'b@t.local', password: PW,
  firstName: 'Bob', lastName: 'Bee', phone: '7065550002',
  street: '2 B St', unit: '2', community: 'Acme', zip: '31901',
  startDate: '2026-10-01', outcome: 'success',
});
assert.ok(custA.ok && custB.ok, 'both demo customers enrolled');

// A pickup photo that belongs to customer A, submitted by the employee.
const aUnit = one('SELECT unit_id FROM service_addresses WHERE customer_id = ?', custA.customerId).unit_id;
const recId = run(
  `INSERT INTO pickup_records (service_date, unit_id, customer_id, employee_id, status)
   VALUES ('2026-10-02', ?, ?, ?, 'completed')`, aUnit, custA.customerId, empId).lastInsertRowid;
const storageKey = await storage.put(Buffer.from('not-a-real-jpeg-but-enough'), { mimeType: 'image/jpeg' });
const aPhotoId = run(
  `INSERT INTO pickup_photos (pickup_record_id, storage_key, mime_type, bytes)
   VALUES (?, ?, 'image/jpeg', 10)`, recId, storageKey).lastInsertRowid;

/* ---------- HTTP harness ---------- */

const server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function login(email, password) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const set = r.headers.get('set-cookie');
  return { status: r.status, cookie: set ? set.split(';')[0] : null };
}
async function api(method, path, { cookie, body } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await r.text();
  let json; try { json = JSON.parse(raw); } catch { json = null; }
  return { status: r.status, json, raw, headers: r.headers };
}

const admin = await login('admin@t.local', PW);
const emp = await login('emp@t.local', PW);
const a = await login('a@t.local', PW);
const b = await login('b@t.local', PW);
assert.ok(admin.cookie && emp.cookie && a.cookie && b.cookie, 'all four roles signed in');

/* ============================================================
   1. Unauthenticated requests are refused.
   ============================================================ */
test('1: an unauthenticated request to a protected endpoint is 401', async () => {
  const r = await api('GET', '/api/customer/account');
  assert.equal(r.status, 401);
});

/* ============================================================
   2. A customer cannot reach the admin API - and the refusal is a
      404, so it does not even confirm the endpoint exists.
   ============================================================ */
test('2: a customer hitting the admin API gets 404 (existence not leaked)', async () => {
  const r = await api('GET', '/api/admin/customers', { cookie: a.cookie });
  assert.equal(r.status, 404);
});

/* ============================================================
   3. An employee cannot reach the admin-only finance API.
   ============================================================ */
test('3: an employee cannot reach the finance API', async () => {
  const r = await api('GET', '/api/finance/summary', { cookie: emp.cookie });
  assert.ok([403, 404].includes(r.status), `expected 403/404, got ${r.status}`);
});

/* ============================================================
   4. Object-level ownership: photo IDOR. Customer B must not be able
      to fetch customer A's pickup photo by guessing its id, while A
      and an admin can.
   ============================================================ */
test('4: a customer cannot fetch another customer\'s photo (404), the owner and admin can', async () => {
  const asB = await api('GET', `/api/photos/${aPhotoId}`, { cookie: b.cookie });
  assert.equal(asB.status, 404, 'cross-customer photo fetch must be refused');

  const asA = await api('GET', `/api/photos/${aPhotoId}`, { cookie: a.cookie });
  assert.equal(asA.status, 200, 'the owning customer can see it');

  const asAdmin = await api('GET', `/api/photos/${aPhotoId}`, { cookie: admin.cookie });
  assert.equal(asAdmin.status, 200, 'an admin can see it');

  const anon = await api('GET', `/api/photos/${aPhotoId}`);
  assert.equal(anon.status, 401, 'and a signed-out request is refused');
});

/* ============================================================
   5. Object-level ownership: an employee cannot record a pickup for a
      unit that is not a stop on their route that day.
   ============================================================ */
test('5: an employee cannot record a pickup for a stop that is not on their route', async () => {
  // status:'issue' so no photo is required, letting the request reach the
  // ownership check rather than stopping at the photo gate.
  const r = await api('POST', '/api/employee/pickups', {
    cookie: emp.cookie,
    body: { unitId: aUnit, serviceDate: '2026-10-05', status: 'issue', issueCode: 'other', notes: 'x' },
  });
  assert.equal(r.status, 403, 'servicing an unassigned stop must be refused');
});

/* ============================================================
   6. Cross-customer data scoping. B's payments are only ever B's, and
      a customerId query param cannot be used to read A's.
   ============================================================ */
test('6: a customer only ever sees their own payments; a customerId param cannot cross over', async () => {
  const aPayments = await api('GET', '/api/customer/payments', { cookie: a.cookie });
  const aIds = aPayments.json.map(p => p.id);
  assert.ok(aIds.length >= 1, 'A has at least one payment');

  // B asks for A's payments explicitly - the param must be ignored.
  const bPayments = await api('GET', `/api/customer/payments?customerId=${custA.customerId}`, { cookie: b.cookie });
  const bIds = bPayments.json.map(p => p.id);
  assert.ok(!bIds.some(id => aIds.includes(id)), 'B must never receive any of A\'s payment rows');
});

/* ============================================================
   7. Mass assignment. A customer editing their profile cannot smuggle
      in a role or status change.
   ============================================================ */
test('7: a customer cannot escalate role or status through the profile endpoint', async () => {
  const r = await api('PATCH', '/api/customer/profile', {
    cookie: a.cookie,
    body: { phone: '7069990000', role: 'admin', status: 'deactivated', is_intro: 1 },
  });
  assert.equal(r.status, 200);
  const u = one('SELECT role FROM users WHERE email = ?', 'a@t.local');
  const c = one('SELECT status, is_intro FROM customers WHERE id = ?', custA.customerId);
  assert.equal(u.role, 'customer', 'role must be unchanged');
  assert.notEqual(c.status, 'deactivated', 'status must be unchanged');
});

/* ============================================================
   8. Self-privilege guards. An admin cannot lock their own account or
      change their own role.
   ============================================================ */
test('8: an admin cannot lock their own account or change their own role', async () => {
  const lock = await api('POST', `/api/people/accounts/${adminUserId}/lock`, { cookie: admin.cookie });
  assert.equal(lock.status, 400, 'locking your own account is refused');

  const role = await api('PATCH', `/api/people/accounts/${adminUserId}`, {
    cookie: admin.cookie, body: { role: 'customer' },
  });
  assert.equal(role.status, 400, 'changing your own role is refused');
});

/* ============================================================
   9. Passwords never leave the server.
   ============================================================ */
test('9: no user-facing response includes a password hash', async () => {
  // The real leak indicators are a password_hash field or a stored scrypt
  // value - not the innocuous mustChangePassword flag, which is just a boolean.
  const leaks = (raw) => /password_hash/i.test(raw) || /scrypt\$/.test(raw);
  const me = await api('GET', '/api/auth/me', { cookie: a.cookie });
  assert.ok(!leaks(me.raw), '/api/auth/me leaks no password hash');
  const account = await api('GET', '/api/customer/account', { cookie: a.cookie });
  assert.ok(!leaks(account.raw), '/api/customer/account leaks no password hash');
});

/* ============================================================
   10. Login brute force is throttled (per ip+email). A distinct email
       is used so it cannot lock a real test account.
   ============================================================ */
test('10: repeated bad logins are throttled with 429', async () => {
  let sawThrottle = false;
  for (let i = 0; i < 12; i++) {
    const r = await login('bruteforce@t.local', 'wrong-password');
    if (r.status === 429) { sawThrottle = true; break; }
  }
  assert.ok(sawThrottle, 'password guessing must be throttled');
});

/* ============================================================
   11. SQL injection through a search parameter cannot break out of the
       prepared statement. The classic drop-table payload leaves the
       users table intact and returns a normal 200.
   ============================================================ */
test('11: a SQL-injection search payload is inert (parameterised)', async () => {
  const before = one('SELECT COUNT(*) AS n FROM users').n;
  const r = await api('GET', `/api/admin/customers?q=${encodeURIComponent("x'; DROP TABLE users;--")}`,
    { cookie: admin.cookie });
  assert.equal(r.status, 200, 'the query runs safely');
  const after = one('SELECT COUNT(*) AS n FROM users').n;
  assert.equal(after, before, 'the users table is untouched');
});

/* ============================================================
   12. The CSP that backs the XSS defence is present on responses, and
       a note carrying a <script> payload round-trips as inert JSON
       data (Content-Type application/json), never as executable HTML.
   ============================================================ */
test('12: responses carry a script-restricting CSP and treat note content as data', async () => {
  const r = await api('GET', '/api/customer/notes', { cookie: a.cookie });
  assert.match(r.headers.get('content-security-policy') || '', /script-src 'self'/);

  // Store a hostile note directly, then read it back through the API.
  run(`INSERT INTO customer_notes (customer_id, body, visible_to_customer)
       VALUES (?, ?, 1)`, custA.customerId, '<script>alert(document.cookie)</script>');
  const notes = await api('GET', '/api/customer/notes', { cookie: a.cookie });
  assert.match(notes.headers.get('content-type') || '', /application\/json/,
    'notes are served as data, not HTML');
  assert.ok(notes.json.some(n => n.body.includes('<script>')),
    'the payload is stored/returned verbatim as data - the browser never executes it under the CSP');
});

/* ============================================================
   13. The public, unauthenticated coupon-validation endpoint is
       rate-limited, so it cannot be used to brute-force coupon codes.
       (Audit item 11.)
   ============================================================ */
test('13: the public coupon-validation endpoint is rate-limited', async () => {
  let sawThrottle = false;
  for (let i = 0; i < 40; i++) {
    const r = await api('POST', '/api/promo/coupons/validate', { body: { code: `GUESS${i}`, planCode: 'Monthly' } });
    if (r.status === 429) { sawThrottle = true; break; }
  }
  assert.ok(sawThrottle, 'unbounded coupon guessing must be throttled');
});
