import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
// NOTE: intentionally do NOT call migrate() here — that creates the plans
// table in its already-new shape. This test hand-builds a LEGACY-shape
// plans table (interval_months/active) plus FK children, to exercise the
// isLegacy rebuild branch in migrate_plans.js that schema-plans.test.js
// never reaches.
const { db, one, all, run } = await import('../db/index.js');
const { migratePlans } = await import('../db/migrate_plans.js');

const cols = (t) => all(`PRAGMA table_info(${t})`).map(c => c.name);

db.exec('PRAGMA foreign_keys = OFF');

db.exec(`
  CREATE TABLE plans (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT    NOT NULL UNIQUE,
    name             TEXT    NOT NULL,
    interval_months  INTEGER NOT NULL,
    price_cents      INTEGER NOT NULL,
    is_intro         INTEGER NOT NULL DEFAULT 0,
    provider_plan_id TEXT,
    active           INTEGER NOT NULL DEFAULT 1
  )`);

db.exec(`
  CREATE TABLE subscriptions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id             INTEGER NOT NULL REFERENCES plans(id),
    locked_price_cents  INTEGER
  )`);

db.exec(`
  CREATE TABLE coupon_plans (
    coupon_id INTEGER,
    plan_id   INTEGER NOT NULL REFERENCES plans(id)
  )`);

run(`INSERT INTO plans (code,name,interval_months,price_cents,is_intro,active)
     VALUES ('Monthly','Monthly',1,2800,0,1)`);
run(`INSERT INTO plans (code,name,interval_months,price_cents,is_intro,active)
     VALUES ('Quarterly','Quarterly',3,7400,0,1)`);
run(`INSERT INTO plans (code,name,interval_months,price_cents,is_intro,active)
     VALUES ('Annual','Annual',12,27600,0,1)`);
run(`INSERT INTO plans (code,name,interval_months,price_cents,is_intro,active)
     VALUES ('Introductory','Introductory',1,1800,1,1)`);

const monthlyIdBefore = one(`SELECT id FROM plans WHERE code = 'Monthly'`).id;

run(`INSERT INTO subscriptions (plan_id, locked_price_cents) VALUES (?, 2800)`, monthlyIdBefore);
run(`INSERT INTO coupon_plans (coupon_id, plan_id) VALUES (1, ?)`, monthlyIdBefore);

db.exec('PRAGMA foreign_keys = ON');

migratePlans();

test('plans table has the new configurable-billing columns after rebuild', () => {
  for (const c of ['interval_unit', 'interval_count', 'status', 'customer_available']) {
    assert.ok(cols('plans').includes(c), `missing plans.${c}`);
  }
  assert.ok(!cols('plans').includes('interval_months'), 'legacy interval_months column should be gone');
  assert.ok(!cols('plans').includes('active'), 'legacy active column should be gone');
});

test('Monthly plan backfills to interval_unit=month, interval_count=1, active/available', () => {
  const p = one(`SELECT interval_unit, interval_count, status, customer_available FROM plans WHERE code = 'Monthly'`);
  assert.equal(p.interval_unit, 'month');
  assert.equal(p.interval_count, 1);
  assert.equal(p.status, 'active');
  assert.equal(p.customer_available, 1);
});

test('Quarterly and Annual plans map interval_months straight into interval_count (unit stays month)', () => {
  // migrate_plans.js hard-codes 'month' as the unit for every legacy row —
  // it does not attempt to convert interval_months into weeks/years.
  const q = one(`SELECT interval_unit, interval_count FROM plans WHERE code = 'Quarterly'`);
  assert.equal(q.interval_unit, 'month');
  assert.equal(q.interval_count, 3);

  const a = one(`SELECT interval_unit, interval_count FROM plans WHERE code = 'Annual'`);
  assert.equal(a.interval_unit, 'month');
  assert.equal(a.interval_count, 12);
});

test('Introductory plan is forced inactive/unavailable regardless of its old active=1', () => {
  const intro = one(`SELECT status, customer_available FROM plans WHERE code = 'Introductory'`);
  assert.equal(intro.status, 'inactive');
  assert.equal(intro.customer_available, 0);
});

test('row ids are preserved across the rebuild, so existing FKs still resolve', () => {
  const monthlyAfter = one(`SELECT id FROM plans WHERE code = 'Monthly'`);
  assert.equal(monthlyAfter.id, monthlyIdBefore);

  const sub = one(`SELECT s.id, p.code FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.plan_id = ?`, monthlyIdBefore);
  assert.equal(sub.code, 'Monthly');

  const cp = one(`SELECT cp.coupon_id, p.code FROM coupon_plans cp JOIN plans p ON p.id = cp.plan_id WHERE cp.plan_id = ?`, monthlyIdBefore);
  assert.equal(cp.code, 'Monthly');
});

test('migratePlans is idempotent: a second call is a no-op on an already-new table', () => {
  const countBefore = one(`SELECT COUNT(*) AS n FROM plans`).n;

  assert.doesNotThrow(() => migratePlans());

  const countAfter = one(`SELECT COUNT(*) AS n FROM plans`).n;
  assert.equal(countAfter, countBefore);

  const monthlyAfter2 = one(`SELECT id, interval_unit, interval_count, status, customer_available FROM plans WHERE code = 'Monthly'`);
  assert.equal(monthlyAfter2.id, monthlyIdBefore);
  assert.equal(monthlyAfter2.interval_unit, 'month');
  assert.equal(monthlyAfter2.interval_count, 1);
  assert.equal(monthlyAfter2.status, 'active');
  assert.equal(monthlyAfter2.customer_available, 1);
});
