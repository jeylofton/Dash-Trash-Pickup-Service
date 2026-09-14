import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { migrate, all, migrateDemoFlags } = await import('../db/index.js');
const { migrateAdmin, migrateCommunities, migrateIssueCodes, migrateAdminControls, migrateDynamicRoles }
  = await import('../db/migrate_admin.js');
const { migrateCommunityLifecycle } = await import('../db/migrate_lifecycle.js');
const { migratePlans } = await import('../db/migrate_plans.js');
const { seedFreshInstall } = await import('../db/seed.js');

// The exact migration chain the direct seed run / server boot uses, then seed.
migrate();
migrateAdmin(); migrateCommunities(); migrateIssueCodes(); migrateAdminControls(); migrateDynamicRoles();
migrateCommunityLifecycle(); migratePlans();
migrateDemoFlags();
seedFreshInstall();

test('seed produces Weekly and Bi-Annual plans with the right intervals', () => {
  const plans = all(`SELECT code, interval_unit, interval_count, status, customer_available, display_order
                       FROM plans WHERE status = 'active' ORDER BY display_order`);
  const byCode = Object.fromEntries(plans.map(p => [p.code, p]));
  assert.equal(byCode.Weekly.interval_unit, 'week');
  assert.equal(byCode.Weekly.interval_count, 1);
  assert.equal(byCode.BiAnnual.interval_unit, 'month');
  assert.equal(byCode.BiAnnual.interval_count, 6);
  assert.equal(byCode.Monthly.interval_unit, 'month');
  assert.equal(byCode.Monthly.interval_count, 1);
  assert.equal(byCode.Quarterly.interval_count, 3);
  assert.equal(byCode.Annual.interval_unit, 'year');
  for (const c of ['Weekly', 'Monthly', 'Quarterly', 'BiAnnual', 'Annual']) {
    assert.equal(byCode[c].customer_available, 1, `${c} should be customer-available`);
  }
  // display_order is set and strictly increasing across the offered plans.
  const orders = ['Weekly', 'Monthly', 'Quarterly', 'BiAnnual', 'Annual'].map(c => byCode[c].display_order);
  assert.deepEqual(orders, [...orders].sort((a, b) => a - b));
});

test('the Introductory plan is seeded inactive and not customer-available', () => {
  const intro = all(`SELECT status, customer_available FROM plans WHERE code = 'Introductory'`)[0];
  assert.ok(intro, 'Introductory row should still exist for the launch coupon/history');
  assert.equal(intro.status, 'inactive');
  assert.equal(intro.customer_available, 0);
});
