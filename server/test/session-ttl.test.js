/* ============================================================
   Privileged sessions expire sooner. A stolen or forgotten admin
   cookie is far more dangerous than a customer's, so admin and
   manager sessions get a short lifetime while customers keep the
   long, convenience-oriented one. The cookie's Max-Age and the
   server-side expires_at must agree, or one outlives the other.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { migrate, run } = await import('../db/index.js');
migrate();
const adminId = run(
  `INSERT INTO users (email, role, password_hash, first_name, last_name)
   VALUES ('a@test.local','admin','x','Ada','Min')`).lastInsertRowid;
const custId = run(
  `INSERT INTO users (email, role, password_hash, first_name, last_name)
   VALUES ('c@test.local','customer','x','Cus','Tomer')`).lastInsertRowid;

const { createSession, cookieOptions } = await import('../lib/auth.js');

test('an admin cookie has a shorter Max-Age than a customer cookie', () => {
  assert.ok(
    cookieOptions('admin').maxAge < cookieOptions('customer').maxAge,
    'admin session lifetime must be shorter than customer'
  );
});

test('manager is treated as privileged, same short lifetime as admin', () => {
  assert.equal(cookieOptions('manager').maxAge, cookieOptions('admin').maxAge);
});

test('an unknown/undefined role falls back to the short privileged lifetime', () => {
  // Fail safe: if we cannot tell what the role is, do not hand out a 14-day cookie.
  assert.equal(cookieOptions(undefined).maxAge, cookieOptions('admin').maxAge);
});

test('createSession stores an expires_at that matches the role lifetime', () => {
  const admin = createSession(adminId, { role: 'admin' });
  const cust = createSession(custId, { role: 'customer' });
  const adminMs = new Date(admin.expires).getTime() - Date.now();
  const custMs = new Date(cust.expires).getTime() - Date.now();
  assert.ok(adminMs < custMs, 'admin expires_at must be sooner than customer');
  // And each expires_at should be within a minute of the cookie Max-Age.
  assert.ok(Math.abs(adminMs - cookieOptions('admin').maxAge) < 60_000);
  assert.ok(Math.abs(custMs - cookieOptions('customer').maxAge) < 60_000);
});
