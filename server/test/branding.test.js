/* ============================================================
   Branding is the single source of truth for the business identity.
   It reads the business.* keys from app_settings (string values, so
   not via the numeric setting() helper), caches them, and exposes a
   public subset that never includes the internal contact fields.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { migrate, run } = await import('../db/index.js');
migrate();

const { branding, publicBranding, invalidateBrandingCache } = await import('../lib/branding.js');

test('branding() returns the seeded business identity', () => {
  const b = branding();
  assert.equal(b.name, 'Dash Trash Pickup');
  assert.equal(b.shortName, 'Dash');
  assert.ok('website' in b && 'supportEmail' in b && 'address' in b);
});

test('publicBranding() exposes the public subset and never the internal contacts', () => {
  const p = publicBranding();
  assert.equal(p.name, 'Dash Trash Pickup');
  assert.ok('supportEmail' in p && 'website' in p && 'address' in p);
  assert.ok(!('email' in p), 'internal business email must not be public');
  assert.ok(!('phone' in p), 'internal business phone must not be public');
});

test('the cache reflects a change only after it is invalidated', () => {
  run(`UPDATE app_settings SET value = 'Premier Valet Waste' WHERE key = 'business.name'`);
  assert.equal(branding().name, 'Dash Trash Pickup', 'still cached until invalidated');
  invalidateBrandingCache();
  assert.equal(branding().name, 'Premier Valet Waste', 'fresh read after invalidation');
});
