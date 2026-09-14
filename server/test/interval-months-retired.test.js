import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, '..', p), 'utf8');

test('admin/signup/finance-seed no longer reference plans.interval_months', () => {
  // customer.js is covered by Task 7; billing.js/migrate_plans.js legitimately
  // mention the word (a comment / the legacy backfill source) so are excluded.
  for (const f of ['routes/admin.js', 'lib/signup.js', 'db/seed_finance.js']) {
    assert.ok(!/interval_months/.test(read(f)), `${f} still references interval_months`);
  }
});

test('signup.js selects a billable plan by status, not the removed active column', () => {
  const src = read('lib/signup.js');
  assert.ok(!/plans WHERE code = \? AND active = 1/.test(src),
    'signup.js still filters plans on the removed `active` column');
});
