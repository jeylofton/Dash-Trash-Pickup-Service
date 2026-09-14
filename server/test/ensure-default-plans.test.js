/* ============================================================
   ensureDefaultPlans(): the self-healing backfill that guarantees a
   deployment always has the advertised plan records, even when the
   database predates the plans feature (users already exist, so the
   fresh-install seed no-ops and would otherwise leave the plans table
   empty forever — the exact Hostinger symptom: a blank Admin plans
   list while the public site still showed hardcoded prices).

   It must:
     - seed the advertised set (Monthly, Quarterly, Annual + an
       inactive Introductory promo row) when the table is EMPTY, and
     - do nothing at all when any plan already exists, so it is safe to
       call on every boot and never overwrites an admin's edits.
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { migrate, all, one } = await import('../db/index.js');
const { migratePlans, ensureDefaultPlans } = await import('../db/migrate_plans.js');
migrate();
migratePlans();

test('seeds the advertised default plans into an empty plans table', () => {
  assert.equal(one('SELECT COUNT(*) AS n FROM plans').n, 0, 'starts empty');

  const changes = ensureDefaultPlans();
  assert.ok(changes.length >= 1, 'reports that it seeded');

  const byCode = Object.fromEntries(all('SELECT * FROM plans').map(p => [p.code, p]));

  // Three selectable plans, priced/scheduled to match what the site advertises.
  assert.equal(byCode.Monthly.price_cents, 2800);
  assert.equal(byCode.Monthly.interval_unit, 'month');
  assert.equal(byCode.Monthly.interval_count, 1);
  assert.equal(byCode.Monthly.status, 'active');
  assert.equal(byCode.Monthly.customer_available, 1);

  assert.equal(byCode.Quarterly.price_cents, 7400);
  assert.equal(byCode.Quarterly.interval_unit, 'month');
  assert.equal(byCode.Quarterly.interval_count, 3);
  assert.equal(byCode.Quarterly.label, 'Best Value',
    'the featured badge is data, not hard-coded to Quarterly in the HTML');

  assert.equal(byCode.Annual.price_cents, 27600);
  assert.equal(byCode.Annual.status, 'active');
  assert.equal(byCode.Annual.customer_available, 1);

  // The Introductory rate is a promotion, kept as a real (inactive) record so
  // the launch coupon and the signup path can reference it — never selectable.
  assert.equal(byCode.Introductory.status, 'inactive');
  assert.equal(byCode.Introductory.customer_available, 0);
  assert.equal(byCode.Introductory.is_intro, 1);

  // Display order runs Monthly -> Quarterly -> Annual for the selectable set.
  assert.ok(byCode.Monthly.display_order < byCode.Quarterly.display_order);
  assert.ok(byCode.Quarterly.display_order < byCode.Annual.display_order);
});

test('is a no-op when any plan already exists — never touches existing rows', () => {
  const before = all('SELECT id, code, price_cents, label FROM plans ORDER BY id');
  assert.ok(before.length > 0, 'table has rows from the previous test');

  const changes = ensureDefaultPlans();
  assert.equal(changes.length, 0, 'reports no work done');

  const after = all('SELECT id, code, price_cents, label FROM plans ORDER BY id');
  assert.deepEqual(after, before, 'existing rows are left exactly as they were');
});
