/* ============================================================
   White-label business identity.

   Configurable business profile, stored in the shared app_settings
   table. Seeded to the current Dash Trash Pickup identity with
   INSERT OR IGNORE, so an existing install adopts these defaults
   without overwriting anything an admin has already set, and a new
   install starts branded and ready to be renamed.

   Values are strings, so they are read via lib/branding.js, never
   the numeric setting() helper. app_settings.value is NOT NULL, so
   fields with no known current value seed as an empty string.
   ============================================================ */

INSERT OR IGNORE INTO app_settings (key, value, description) VALUES
  ('business.name',         'Dash Trash Pickup',            'Full business name shown throughout the app'),
  ('business.shortName',    'Dash',                          'Short business name for tight spaces'),
  ('business.website',      'https://dashtrashpickup.com',   'Public website URL'),
  ('business.supportEmail', '',                              'Public support email address'),
  ('business.supportPhone', '',                              'Public support phone number'),
  ('business.address',      'Columbus, GA',                  'Public business address'),
  ('business.email',        '',                              'Internal business email (not shown publicly)'),
  ('business.phone',        '',                              'Internal business phone (not shown publicly)');
