import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db, migrate, one, run } = await import('../db/index.js');
const { migratePlans } = await import('../db/migrate_plans.js');
migrate(); migratePlans();

const { availableActions, resolveAction } = await import('../lib/lifecycle.js');
const { PLAN_LIFECYCLE } = await import('../lib/plan_lifecycle.js');

function mkPlan(status) {
  run(`INSERT INTO plans (code,name,price_cents,interval_unit,interval_count,status)
       VALUES ('L'||abs(random()),'L',1000,'month',1,?)`, status);
  return one(`SELECT * FROM plans WHERE id = last_insert_rowid()`);
}

test('a draft plan can be activated but not deactivated', () => {
  const p = mkPlan('draft');
  const keys = availableActions(PLAN_LIFECYCLE, p).map(a => a.key);
  assert.ok(keys.includes('activate'));
  assert.ok(!keys.includes('deactivate'));
});

test('activate moves draft -> active', () => {
  const p = mkPlan('draft');
  const r = resolveAction(PLAN_LIFECYCLE, p, 'activate', {}, {});
  r.action.run(p, r.values, {});
  assert.equal(one(`SELECT status FROM plans WHERE id = ?`, p.id).status, 'active');
});

test('deactivate moves active -> inactive; archive sets archived_at', () => {
  const p = mkPlan('active');
  let r = resolveAction(PLAN_LIFECYCLE, p, 'deactivate', {}, {});
  r.action.run(p, r.values, {});
  assert.equal(one(`SELECT status FROM plans WHERE id = ?`, p.id).status, 'inactive');

  const p2 = mkPlan('active');
  r = resolveAction(PLAN_LIFECYCLE, p2, 'archive', {}, {});
  r.action.run(p2, r.values, {});
  const row = one(`SELECT status, archived_at FROM plans WHERE id = ?`, p2.id);
  assert.equal(row.status, 'archived');
  assert.ok(row.archived_at);
});

test('restore moves archived -> inactive', () => {
  const p = mkPlan('archived');
  const r = resolveAction(PLAN_LIFECYCLE, p, 'restore', {}, {});
  r.action.run(p, r.values, {});
  assert.equal(one(`SELECT status FROM plans WHERE id = ?`, p.id).status, 'inactive');
});

test('an invalid transition is rejected', () => {
  const p = mkPlan('archived');
  assert.throws(() => resolveAction(PLAN_LIFECYCLE, p, 'deactivate', {}, {}));
});
