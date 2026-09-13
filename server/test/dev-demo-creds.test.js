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
  assert.ok(res.body.password.length >= 10);
  const emails = res.body.accounts.map(a => a.email);
  assert.deepEqual(emails.sort(), ['admin@x.local', 'cust@x.local']);
  assert.ok(res.body.accounts.every(a => a.email && a.role));
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
