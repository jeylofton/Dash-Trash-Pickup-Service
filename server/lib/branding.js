/* ============================================================
   Business identity - the single source of truth for white-label
   branding. Reads the business.* keys from app_settings (string
   values, so NOT via the numeric setting() helper) and caches them.

   publicBranding() is the subset safe to hand any visitor; the
   internal email/phone are never included there.

   The cache is invalidated explicitly whenever a business.* value is
   written (see routes/settings.js), so a rename shows up at once
   without a per-request query on every page load.
   ============================================================ */

import { all } from '../db/index.js';

/* Baked-in fallbacks so a key missing entirely (e.g. before the seed
   migration ran) never yields blank UI. Keys here are the field names;
   the stored keys are these prefixed with "business.". */
const DEFAULTS = {
  name: 'Dash Trash Pickup',
  shortName: 'Dash',
  website: 'https://dashtrashpickup.com',
  supportEmail: '',
  supportPhone: '',
  address: 'Columbus, GA',
  email: '',
  phone: '',
};

/* What any visitor may see. The internal email/phone are excluded. */
const PUBLIC_FIELDS = ['name', 'shortName', 'website', 'supportEmail', 'supportPhone', 'address'];

let cache = null;

export function branding() {
  if (cache) return cache;
  const rows = all(`SELECT key, value FROM app_settings WHERE key LIKE 'business.%'`);
  const stored = {};
  for (const { key, value } of rows) {
    const field = key.slice('business.'.length);
    if (field in DEFAULTS) stored[field] = value;
  }
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

export function publicBranding() {
  const b = branding();
  return Object.fromEntries(PUBLIC_FIELDS.map(f => [f, b[f]]));
}

export function invalidateBrandingCache() {
  cache = null;
}
