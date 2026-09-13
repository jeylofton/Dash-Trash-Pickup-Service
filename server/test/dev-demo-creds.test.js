/* ============================================================
   Demo credentials are a development convenience, never something
   the live site should hand a visitor. The endpoint that feeds the
   login page's demo block therefore answers only outside production;
   in production it 404s and the password never leaves the server.

   Outside production it lists the demo accounts that actually exist
   in the database - not a hardcoded guess - so a reset or reseed can
   never leave the hint advertising a login that no longer works.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { migrate, run } = await import('../db/index.js');
migrate();
run(`INSERT INTO users (email, role, password_hash, first_name, last_name)
     VALUES ('admin@x.local','admin','x','Ad','Min')`);
run(`INSERT INTO users (email, role, password_hash, first_name, last_name)
     VALUES ('cust@x.local','customer','x','Cus','Tom')`);
// Note: no employee row - the hint must simply omit that role, not invent one.

// The plaintext each seeded account is created with (db/seed.js). The demo
// hint must advertise the SAME password per account, or clicking a role fills
// the wrong password and only the one whose password happens to match works.
const SEED_PASSWORD = { admin: 'DashDemo2026', employee: 'employee', customer: 'customer' };

const { devDemoCreds } = await import('../lib/demo-creds.js');

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
  };
}

test('in development, returns the demo password and only accounts that exist', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const res = fakeRes();
  devDemoCreds({}, res);
  process.env.NODE_ENV = prev;

  assert.equal(res.statusCode, 200);
  const emails = res.body.accounts.map(a => a.email);
  assert.deepEqual(emails.sort(), ['admin@x.local', 'cust@x.local']);
  assert.ok(res.body.accounts.every(a => a.email && a.role));
  // Each account carries ITS OWN password - the one that account was seeded
  // with - so clicking any role in the hint fills a password that logs in.
  assert.ok(res.body.accounts.every(a => a.password === SEED_PASSWORD[a.role]));
  // The absent employee role is not advertised.
  assert.ok(!res.body.accounts.some(a => a.role === 'employee'));
});

test('in production, 404s and reveals no password', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const res = fakeRes();
  devDemoCreds({}, res);
  process.env.NODE_ENV = prev;

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.password, undefined);
  assert.equal(res.body.accounts, undefined);
});
