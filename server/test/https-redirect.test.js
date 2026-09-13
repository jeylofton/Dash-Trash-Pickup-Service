/* ============================================================
   Force HTTPS in production. Behind a TLS-terminating proxy the
   app sees plain http with an x-forwarded-proto header, so that
   header - not req.secure alone - decides whether the request
   already arrived securely. In development there is no TLS and
   the redirect must stay out of the way.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forceHttps } from '../lib/security.js';

function fakeReq({ proto, host = 'dashtrashpickup.com', url = '/dashboard/login.html' } = {}) {
  return {
    headers: { host, ...(proto ? { 'x-forwarded-proto': proto } : {}) },
    originalUrl: url,
    secure: proto === 'https',
  };
}

function fakeRes() {
  return {
    redirected: null,
    redirect(status, location) { this.redirected = { status, location }; },
  };
}

test('in production, a plain-http request is redirected to https', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const res = fakeRes();
  let nexted = false;
  forceHttps(fakeReq({ proto: 'http' }), res, () => { nexted = true; });
  process.env.NODE_ENV = prev;

  assert.equal(nexted, false, 'must not fall through to the app');
  assert.equal(res.redirected.location, 'https://dashtrashpickup.com/dashboard/login.html');
  assert.ok([301, 308].includes(res.redirected.status), 'permanent redirect');
});

test('in production, a request already on https passes through', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const res = fakeRes();
  let nexted = false;
  forceHttps(fakeReq({ proto: 'https' }), res, () => { nexted = true; });
  process.env.NODE_ENV = prev;

  assert.equal(nexted, true);
  assert.equal(res.redirected, null);
});

test('in development, http is left alone (no TLS to redirect to)', () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'development';
  const res = fakeRes();
  let nexted = false;
  forceHttps(fakeReq({ proto: 'http' }), res, () => { nexted = true; });
  process.env.NODE_ENV = prev;

  assert.equal(nexted, true);
  assert.equal(res.redirected, null);
});
