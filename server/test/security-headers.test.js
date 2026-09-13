/* ============================================================
   Security response headers. Every response the app sends must
   carry a baseline set of hardening headers; HSTS is special -
   it is only honoured (and only safe) over HTTPS, so it is sent
   in production alone, never in local http development.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityHeaders } from '../lib/security.js';

/* A res stand-in that records header writes the way express's does. */
function fakeRes() {
  const headers = {};
  return {
    headers,
    set(name, value) { headers[name] = value; return this; },
    get(name) { return headers[name]; },
  };
}

function run() {
  const res = fakeRes();
  let nexted = false;
  securityHeaders({}, res, () => { nexted = true; });
  return { res, nexted };
}

test('sends the baseline hardening headers on every response', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const { res, nexted } = run();
  process.env.NODE_ENV = prev;

  assert.equal(res.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(res.get('X-Frame-Options'), 'DENY');
  assert.equal(res.get('Referrer-Policy'), 'no-referrer');
  assert.match(res.get('Content-Security-Policy'), /default-src 'self'/);
  assert.match(res.get('Content-Security-Policy'), /script-src 'self'/);
  assert.match(res.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.match(res.get('Content-Security-Policy'), /object-src 'none'/);
  assert.equal(nexted, true, 'must call next()');
});

test('does NOT send HSTS in development (plain http would strand the user)', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const { res } = run();
  process.env.NODE_ENV = prev;

  assert.equal(res.get('Strict-Transport-Security'), undefined);
});

test('sends HSTS only in production', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const { res } = run();
  process.env.NODE_ENV = prev;

  assert.match(res.get('Strict-Transport-Security'), /max-age=\d+/);
  assert.match(res.get('Strict-Transport-Security'), /includeSubDomains/);
});
