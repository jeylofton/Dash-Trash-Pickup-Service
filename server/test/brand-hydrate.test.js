/* ============================================================
   Client-side {{brand.*}} hydration. On hosts that serve the static
   HTML directly (Passenger serving public/ on Hostinger), the server
   never runs its {{brand.*}} replacement, so tokens reach the browser
   literally. brand-hydrate.js fills them in from /api/branding. These
   tests cover its pure substitution helper, which must mirror the
   server's renderBrandTokens semantics: only public fields resolve,
   unknown/internal tokens are left exactly as written.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { substituteBrandTokens } = await import('../public/brand-hydrate.js');

const BRAND = {
  name: 'Dash Trash Pickup',
  shortName: 'Dash',
  website: 'https://dashtrashpickup.com',
  supportEmail: 'help@dashtrashpickup.com',
  supportPhone: '(555) 010-0100',
  address: 'Columbus, GA',
};

test('replaces a known public token with its value', () => {
  assert.equal(substituteBrandTokens('Sign in · {{brand.name}}', BRAND), 'Sign in · Dash Trash Pickup');
  assert.equal(substituteBrandTokens('{{brand.shortName}}', BRAND), 'Dash');
});

test('replaces every occurrence in a string', () => {
  assert.equal(
    substituteBrandTokens('{{brand.name}} — get {{brand.name}} today', BRAND),
    'Dash Trash Pickup — get Dash Trash Pickup today',
  );
});

test('leaves unknown tokens untouched', () => {
  assert.equal(substituteBrandTokens('{{brand.notafield}}', BRAND), '{{brand.notafield}}');
  assert.equal(substituteBrandTokens('no tokens here', BRAND), 'no tokens here');
});

test('does not resolve internal (non-public) fields even if present in data', () => {
  const withInternal = { ...BRAND, email: 'secret@internal.test', phone: '(555) 999-0000' };
  assert.equal(substituteBrandTokens('{{brand.email}}', withInternal), '{{brand.email}}');
  assert.equal(substituteBrandTokens('{{brand.phone}}', withInternal), '{{brand.phone}}');
});

test('leaves a token whose value is missing from the branding payload', () => {
  assert.equal(substituteBrandTokens('{{brand.supportEmail}}', { name: 'X' }), '{{brand.supportEmail}}');
});

test('is a no-op on null/garbage brand input (keeps tokens rather than throwing)', () => {
  assert.equal(substituteBrandTokens('{{brand.name}}', null), '{{brand.name}}');
});
