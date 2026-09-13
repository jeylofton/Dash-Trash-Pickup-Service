/* ============================================================
   Server-side {{brand.*}} token replacement for served HTML.
   Values are HTML-escaped on injection so an admin-set business name
   like "<script>" cannot inject markup into every page. Only public
   brand fields are templatable; unknown tokens are left untouched.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { migrate, run } = await import('../db/index.js');
migrate();
const { invalidateBrandingCache } = await import('../lib/branding.js');
const { renderBrandTokens } = await import('../lib/htmltemplate.js');

test('replaces a known brand token with its value', () => {
  const out = renderBrandTokens('<title>Sign in · {{brand.name}}</title>');
  assert.equal(out, '<title>Sign in · Dash Trash Pickup</title>');
});

test('HTML-escapes the injected value (no stored XSS via the business name)', () => {
  run(`UPDATE app_settings SET value = '<script>alert(1)</script>' WHERE key = 'business.name'`);
  invalidateBrandingCache();
  const out = renderBrandTokens('<h1>{{brand.name}}</h1>');
  assert.ok(!out.includes('<script>'), 'raw script tag must not survive');
  assert.match(out, /&lt;script&gt;/);
  // restore
  run(`UPDATE app_settings SET value = 'Dash Trash Pickup' WHERE key = 'business.name'`);
  invalidateBrandingCache();
});

test('leaves unknown tokens untouched', () => {
  assert.equal(renderBrandTokens('{{brand.notafield}}'), '{{brand.notafield}}');
  assert.equal(renderBrandTokens('no tokens here'), 'no tokens here');
});

test('does not expose internal contact fields as tokens', () => {
  run(`UPDATE app_settings SET value = 'secret@internal.test' WHERE key = 'business.email'`);
  invalidateBrandingCache();
  // brand.email is not a public token, so it must be left as the literal token.
  assert.equal(renderBrandTokens('{{brand.email}}'), '{{brand.email}}');
});
