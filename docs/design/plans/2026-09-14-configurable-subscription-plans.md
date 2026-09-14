# Configurable Subscription Plans Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin define their own subscription plans — any billing frequency (week/month/year × N), price, status, customer availability, order, and label — from the dashboard, and have customer plan selection use them.

**Architecture:** Rebuild the existing `plans` table so `interval_unit` + `interval_count` (not whole `interval_months`) is the canonical billing interval; centralize interval math in a new `lib/billing.js`; drive plan status transitions through the existing `lib/lifecycle.js` engine via a new `lib/plan_lifecycle.js`; expose CRUD + lifecycle + price-change endpoints in a new `routes/plans.js`; add a "Subscription Plans" admin tab following the existing page-state pattern.

**Tech Stack:** Node 22 (ESM, `node:sqlite`, `node:test`), Express 4, vanilla-JS dashboard.

## Global Constraints

- Node >= 22; ESM only (`"type": "module"`); no new dependencies.
- Run tests with `npm test` (`node --test server/test/**/*.test.js`). Per-file: `node --test server/test/<file>.test.js`.
- One fact in one place: prices live on plans; a subscription stores only the price it LOCKED IN. Never rewrite historical `payments` rows.
- Nothing operational is ever hard-deleted when history points at it — deactivate/archive instead.
- All new mutating routes go through `requirePermission(...)` and are written to `audit_log` via `lib/audit.js`.
- Money is stored as integer cents. Route-local `money = (cents) => cents / 100` returns dollars (a number); the browser formats.
- SQLite table rebuilds follow the project idiom: `PRAGMA foreign_keys=OFF; BEGIN; CREATE _new; INSERT…SELECT; DROP; RENAME; COMMIT;` then `PRAGMA foreign_keys=ON` in `finally` (see `db/migrate_admin.js`). Preserve `plans.id` so `subscriptions.plan_id` and `coupon_plans.plan_id` stay valid.
- Migrations are idempotent and guarded; they run at server boot (`server.js`) and in `db/seed.js`.

---

## File Structure

**Create:**
- `server/lib/billing.js` — pure interval math + labels + code-slug helper.
- `server/lib/plan_lifecycle.js` — the lifecycle spec (statuses + actions) for plans.
- `server/lib/plans.js` — plan data access: create/edit/duplicate, deletability, `applyDuePriceChanges()`, `planView()`.
- `server/db/migrate_plans.js` — `migratePlans()`: rebuild legacy `plans` table, backfill, force `Introductory`→inactive.
- `server/routes/plans.js` — `/api/admin/plans` CRUD + lifecycle + price-change endpoints.
- Test files under `server/test/` (one per task, named below).

**Modify:**
- `server/db/schema.sql` — new `plans` shape + `plan_price_changes` table (fresh-install source of truth).
- `server/db/schema_discounts.sql` — seed `plan.price_change_grace_days` app setting.
- `server/db/schema_roles.sql` — add `plans.*` permission catalog rows.
- `server/db/index.js` — guard the `Introductory` intro-deactivation block so it never reads a dropped `active` column.
- `server/db/seed.js` — new plan columns + Weekly + Bi-Annual example plans.
- `server/server.js` — import/run `migratePlans()`; call `applyDuePriceChanges()` at boot; mount `plansRouter`.
- `server/routes/admin.js` — MRR uses `monthsEquivalent`.
- `server/routes/customer.js` — `/account`, `/plans`, `/plan/change` use billing helpers + availability gating.
- `server/lib/signup.js` — next-billing uses `addInterval`.
- `server/public/dashboard/admin/index.html` — new tab + section markup; dynamic plan dropdown.
- `server/public/dashboard/admin/admin.js` — Subscription Plans section logic.

---

## Task 1: `lib/billing.js` — interval math and labels

**Files:**
- Create: `server/lib/billing.js`
- Test: `server/test/billing.test.js`

**Interfaces:**
- Produces:
  - `INTERVAL_UNITS: string[]` = `['week','month','year']`
  - `monthsEquivalent(unit: string, count: number): number`
  - `addInterval(dateISO: string, unit: string, count: number): string` (returns `YYYY-MM-DD`)
  - `frequencyLabel(unit: string, count: number): string` (e.g. `'weekly'`, `'every 2 weeks'`, `'every 6 months'`)
  - `perLabel(unit: string, count: number): string` (e.g. `'/ week'`, `'/ 6 months'`)
  - `slugCode(name: string): string` (PascalCase-ish alphanumeric plan code)

- [ ] **Step 1: Write the failing test**

Create `server/test/billing.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERVAL_UNITS, monthsEquivalent, addInterval, frequencyLabel, perLabel, slugCode,
} from '../lib/billing.js';

test('INTERVAL_UNITS is week/month/year only (no day)', () => {
  assert.deepEqual(INTERVAL_UNITS, ['week', 'month', 'year']);
});

test('monthsEquivalent normalizes each unit for MRR', () => {
  assert.equal(monthsEquivalent('month', 1), 1);
  assert.equal(monthsEquivalent('month', 3), 3);
  assert.equal(monthsEquivalent('year', 1), 12);
  // week ~ 7/30.436875 months
  assert.ok(Math.abs(monthsEquivalent('week', 1) - 0.23) < 0.01);
  assert.ok(Math.abs(monthsEquivalent('week', 2) - 0.46) < 0.01);
});

test('monthsEquivalent throws on an unknown unit', () => {
  assert.throws(() => monthsEquivalent('day', 1));
});

test('addInterval advances the date by unit x count', () => {
  assert.equal(addInterval('2026-01-01', 'week', 1), '2026-01-08');
  assert.equal(addInterval('2026-01-01', 'week', 2), '2026-01-15');
  assert.equal(addInterval('2026-01-15', 'month', 1), '2026-02-15');
  assert.equal(addInterval('2026-01-15', 'month', 6), '2026-07-15');
  assert.equal(addInterval('2026-01-15', 'year', 1), '2027-01-15');
  // Accepts a full ISO timestamp and returns date only.
  assert.equal(addInterval('2026-01-01T12:00:00Z', 'month', 1), '2026-02-01');
});

test('frequencyLabel reads naturally for single and multi counts', () => {
  assert.equal(frequencyLabel('week', 1), 'weekly');
  assert.equal(frequencyLabel('week', 2), 'every 2 weeks');
  assert.equal(frequencyLabel('month', 1), 'monthly');
  assert.equal(frequencyLabel('month', 6), 'every 6 months');
  assert.equal(frequencyLabel('year', 1), 'yearly');
});

test('perLabel builds a price suffix', () => {
  assert.equal(perLabel('week', 1), '/ week');
  assert.equal(perLabel('month', 6), '/ 6 months');
  assert.equal(perLabel('year', 1), '/ year');
});

test('slugCode makes a safe unique-able plan code from a name', () => {
  assert.equal(slugCode('Standard Monthly'), 'StandardMonthly');
  assert.equal(slugCode('  bi-annual!! '), 'Biannual');
  assert.equal(slugCode(''), 'Plan');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/billing.test.js`
Expected: FAIL — cannot find module `../lib/billing.js`.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/billing.js`:

```js
/* ============================================================
   Billing interval math, in one place.

   A plan's billing frequency is (interval_unit, interval_count):
   "every N weeks/months/years". This module is the ONLY thing
   that knows how to turn that into a next-billing date, a monthly
   figure for MRR, or a human label. `interval_months` is retired.
   ============================================================ */

export const INTERVAL_UNITS = ['week', 'month', 'year'];

const DAYS_PER_MONTH = 30.436875; // average Gregorian month

/** Fractional months represented by one billing cycle — for MRR only. */
export function monthsEquivalent(unit, count) {
  const n = Number(count) || 0;
  switch (unit) {
    case 'week':  return (n * 7) / DAYS_PER_MONTH;
    case 'month': return n;
    case 'year':  return n * 12;
    default: throw new Error(`Unknown interval unit: ${unit}`);
  }
}

/** The next billing date after `dateISO`, `YYYY-MM-DD`. UTC, so no TZ drift. */
export function addInterval(dateISO, unit, count) {
  const d = new Date(`${String(dateISO).slice(0, 10)}T00:00:00Z`);
  const n = Number(count) || 0;
  switch (unit) {
    case 'week':  d.setUTCDate(d.getUTCDate() + n * 7); break;
    case 'month': d.setUTCMonth(d.getUTCMonth() + n); break;
    case 'year':  d.setUTCFullYear(d.getUTCFullYear() + n); break;
    default: throw new Error(`Unknown interval unit: ${unit}`);
  }
  return d.toISOString().slice(0, 10);
}

const SINGULAR = { week: 'week', month: 'month', year: 'year' };
const PLURAL   = { week: 'weeks', month: 'months', year: 'years' };
const EVERY_ONE = { week: 'weekly', month: 'monthly', year: 'yearly' };

/** "weekly" / "every 2 weeks" / "every 6 months". */
export function frequencyLabel(unit, count) {
  const n = Number(count) || 1;
  if (n === 1) return EVERY_ONE[unit] ?? `every ${unit}`;
  return `every ${n} ${PLURAL[unit] ?? `${unit}s`}`;
}

/** Price suffix: "/ week" / "/ 6 months". */
export function perLabel(unit, count) {
  const n = Number(count) || 1;
  return n === 1 ? `/ ${SINGULAR[unit] ?? unit}` : `/ ${n} ${PLURAL[unit] ?? `${unit}s`}`;
}

/** A safe, mostly-unique plan code derived from a name. */
export function slugCode(name) {
  const s = String(name || '').replace(/[^A-Za-z0-9]+/g, '');
  if (!s) return 'Plan';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/billing.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/lib/billing.js server/test/billing.test.js
git commit -m "feat(billing): interval math + labels helper (week/month/year)"
```

---

## Task 2: Migrate & rebuild the `plans` table + `plan_price_changes`

**Files:**
- Modify: `server/db/schema.sql` (plans block; add `plan_price_changes`)
- Modify: `server/db/schema_discounts.sql` (seed grace setting)
- Modify: `server/db/index.js` (guard the Introductory block)
- Create: `server/db/migrate_plans.js`
- Test: `server/test/schema-plans.test.js`

**Interfaces:**
- Produces: `migratePlans(): string[]` (list of applied changes, like `migrateAdmin`).
- New `plans` columns: `id, code, name, description, internal_notes, price_cents, currency, interval_unit, interval_count, customer_available, status, display_order, label, is_intro, provider_plan_id, created_at, updated_at, archived_at`.
- New table `plan_price_changes(id, plan_id, old_price_cents, new_price_cents, applies_to, effective_date, reason, status, created_by, created_at, applied_at)`.
- New app setting `plan.price_change_grace_days` = `'90'`.

- [ ] **Step 1: Write the failing test**

Create `server/test/schema-plans.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db, migrate, one, all } = await import('../db/index.js');
const { migratePlans } = await import('../db/migrate_plans.js');
migrate();
migratePlans();

const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);

test('plans has the new configurable-billing columns', () => {
  for (const c of ['interval_unit', 'interval_count', 'description', 'internal_notes',
    'currency', 'customer_available', 'status', 'display_order', 'label',
    'created_at', 'updated_at', 'archived_at']) {
    assert.ok(cols('plans').includes(c), `missing plans.${c}`);
  }
});

test('plans.status is constrained to the four lifecycle states', () => {
  db.exec(`INSERT INTO plans (code,name,price_cents,interval_unit,interval_count,status)
           VALUES ('T1','T1',1000,'month',1,'active')`);
  assert.throws(() => db.exec(`INSERT INTO plans (code,name,price_cents,interval_unit,interval_count,status)
           VALUES ('T2','T2',1000,'month',1,'bogus')`));
});

test('interval_unit is constrained to week/month/year', () => {
  assert.throws(() => db.exec(`INSERT INTO plans (code,name,price_cents,interval_unit,interval_count,status)
           VALUES ('T3','T3',1000,'day',1,'active')`));
});

test('plan_price_changes exists with the columns the re-pricing engine needs', () => {
  for (const c of ['plan_id','old_price_cents','new_price_cents','applies_to',
    'effective_date','reason','status','created_by','created_at','applied_at']) {
    assert.ok(cols('plan_price_changes').includes(c), `missing plan_price_changes.${c}`);
  }
});

test('the price-change grace-period setting is seeded', () => {
  const row = one(`SELECT value FROM app_settings WHERE key = 'plan.price_change_grace_days'`);
  assert.equal(row?.value, '90');
});

test('legacy month-based plans backfill to interval_unit=month', () => {
  // A fresh in-memory DB seeds nothing, so simulate a legacy row shape by
  // confirming month plans inserted through the new schema read back sanely.
  const p = one(`SELECT interval_unit, interval_count FROM plans WHERE code = 'T1'`);
  assert.equal(p.interval_unit, 'month');
  assert.equal(p.interval_count, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/schema-plans.test.js`
Expected: FAIL — cannot find module `../db/migrate_plans.js` (and, once created, missing columns until schema.sql is updated).

- [ ] **Step 3a: Update `server/db/schema.sql` — replace the `plans` CREATE TABLE**

Replace the existing `CREATE TABLE IF NOT EXISTS plans (...)` block with:

```sql
CREATE TABLE IF NOT EXISTS plans (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  code               TEXT    NOT NULL UNIQUE,   -- Monthly | Quarterly | Annual | Weekly | …
  name               TEXT    NOT NULL,
  description        TEXT,
  internal_notes     TEXT,
  price_cents        INTEGER NOT NULL,
  currency           TEXT    NOT NULL DEFAULT 'USD',
  -- Billing frequency as "every N units". This, not a whole month count,
  -- is what lets a company bill weekly, biweekly, or bi-annually.
  interval_unit      TEXT    NOT NULL DEFAULT 'month'
                       CHECK (interval_unit IN ('week','month','year')),
  interval_count     INTEGER NOT NULL DEFAULT 1 CHECK (interval_count > 0),
  customer_available INTEGER NOT NULL DEFAULT 0,   -- may a customer pick it?
  status             TEXT    NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','active','inactive','archived')),
  display_order      INTEGER NOT NULL DEFAULT 0,
  label              TEXT,                          -- "Most Popular", "Best Value", …
  is_intro           INTEGER NOT NULL DEFAULT 0,
  provider_plan_id   TEXT,                          -- 'demo' until a real provider is connected
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT,
  archived_at        TEXT
);

-- A pending or applied change to a plan's price. New customers pay the
-- plan's advertised price at signup; EXISTING customers keep their locked
-- price until effective_date (default: change date + grace days), then
-- switch. Applying NEVER rewrites historical payment rows.
CREATE TABLE IF NOT EXISTS plan_price_changes (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id          INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  old_price_cents  INTEGER NOT NULL,
  new_price_cents  INTEGER NOT NULL,
  applies_to       TEXT    NOT NULL CHECK (applies_to IN ('new','existing_and_new')),
  effective_date   TEXT    NOT NULL,           -- when EXISTING customers switch
  reason           TEXT,
  status           TEXT    NOT NULL DEFAULT 'scheduled'
                     CHECK (status IN ('scheduled','applied','cancelled')),
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  applied_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_price_changes_due
  ON plan_price_changes(status, effective_date);
```

- [ ] **Step 3b: Update `server/db/schema_discounts.sql` — seed the grace setting**

In the existing `INSERT OR IGNORE INTO app_settings (key, value, description) VALUES` block, add a row:

```sql
  ('plan.price_change_grace_days', '90',
   'Days an existing subscriber keeps their old price after a plan price change before switching to the new one'),
```

(Keep it inside the same VALUES list; mind the trailing comma/semicolon.)

- [ ] **Step 3c: Guard the Introductory block in `server/db/index.js`**

The current `migrate()` reads `SELECT active FROM plans WHERE code='Introductory'`. After the rebuild the `active` column no longer exists, and on a fresh new-shape DB it never existed — that read would throw. Wrap it so it only runs while the legacy `active` column is present:

```js
  // Legacy only: the old plans table had an `active` flag. Deactivating the
  // Introductory row is now handled in migrate_plans.js against the new
  // `status` column, so only touch `active` while it still exists.
  const planCols = db.prepare(`PRAGMA table_info(plans)`).all().map(c => c.name);
  if (planCols.includes('active')) {
    const introPlanActive = one(`SELECT active FROM plans WHERE code = 'Introductory'`);
    if (introPlanActive && introPlanActive.active) {
      db.exec(`UPDATE plans SET active = 0 WHERE code = 'Introductory'`);
    }
  }
```

- [ ] **Step 3d: Create `server/db/migrate_plans.js`**

```js
/* ============================================================
   Rebuild the plans table from the legacy (interval_months) shape
   to the configurable (interval_unit + interval_count) shape, and
   backfill sensible values. Guarded so repeat boots are no-ops.
   ============================================================ */

import { db, one, all } from './index.js';

const columns = (table) => all(`PRAGMA table_info(${table})`).map(c => c.name);

export function migratePlans() {
  const changes = [];
  const cols = columns('plans');

  // Only a legacy table has interval_months and lacks interval_unit.
  const isLegacy = cols.includes('interval_months') && !cols.includes('interval_unit');
  if (isLegacy) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE plans_new (
          id                 INTEGER PRIMARY KEY AUTOINCREMENT,
          code               TEXT    NOT NULL UNIQUE,
          name               TEXT    NOT NULL,
          description        TEXT,
          internal_notes     TEXT,
          price_cents        INTEGER NOT NULL,
          currency           TEXT    NOT NULL DEFAULT 'USD',
          interval_unit      TEXT    NOT NULL DEFAULT 'month'
                               CHECK (interval_unit IN ('week','month','year')),
          interval_count     INTEGER NOT NULL DEFAULT 1 CHECK (interval_count > 0),
          customer_available INTEGER NOT NULL DEFAULT 0,
          status             TEXT    NOT NULL DEFAULT 'draft'
                               CHECK (status IN ('draft','active','inactive','archived')),
          display_order      INTEGER NOT NULL DEFAULT 0,
          label              TEXT,
          is_intro           INTEGER NOT NULL DEFAULT 0,
          provider_plan_id   TEXT,
          created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
          updated_at         TEXT,
          archived_at        TEXT
        )`);
      // Backfill: month-based interval, status/availability from the old
      // `active` flag, order by id. A legacy interval_months of 0 (should
      // not happen) is clamped to 1 to satisfy the CHECK.
      db.exec(`
        INSERT INTO plans_new
          (id, code, name, price_cents, interval_unit, interval_count,
           customer_available, status, display_order, is_intro, provider_plan_id)
        SELECT id, code, name, price_cents, 'month',
               CASE WHEN interval_months < 1 THEN 1 ELSE interval_months END,
               active, CASE WHEN active = 1 THEN 'active' ELSE 'inactive' END,
               id, is_intro, provider_plan_id
          FROM plans`);
      db.exec('DROP TABLE plans');
      db.exec('ALTER TABLE plans_new RENAME TO plans');
      db.exec('COMMIT');
      changes.push('plans rebuilt to interval_unit + interval_count');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // The Introductory rate is a promotion on Monthly, never a selectable
  // plan (see lib/signup.js). Keep the row for old FKs but ensure it is
  // never active/available. Idempotent no-op once already inactive/absent.
  const intro = one(`SELECT status, customer_available FROM plans WHERE code = 'Introductory'`);
  if (intro && (intro.status !== 'inactive' || intro.customer_available)) {
    db.exec(`UPDATE plans SET status = 'inactive', customer_available = 0 WHERE code = 'Introductory'`);
    changes.push('Introductory plan forced inactive');
  }

  return changes;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/schema-plans.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/db/schema.sql server/db/schema_discounts.sql server/db/index.js server/db/migrate_plans.js server/test/schema-plans.test.js
git commit -m "feat(db): configurable plans schema + plan_price_changes + migratePlans()"
```

---

## Task 3: `lib/plans.js` — data access, price changes, deletability

**Files:**
- Create: `server/lib/plans.js`
- Test: `server/test/plans-lib.test.js`

**Interfaces:**
- Consumes: `lib/billing.js` (`slugCode`), `db/index.js` (`one`, `all`, `run`, `tx`), `lib/permissions.js` (`setting`).
- Produces:
  - `uniqueCode(base: string): string`
  - `createPlan(input, userId): {id}` — input `{name, description, internalNotes, priceCents, intervalUnit, intervalCount, customerAvailable, status, displayOrder, label, currency}`
  - `updatePlan(id, input, userId): void` (does NOT change status; that's lifecycle)
  - `duplicatePlan(id, userId): {id}`
  - `planCustomerCount(id): number` (live subscriptions)
  - `planDeletability(id): {deletable: boolean, reason: string|null}`
  - `deletePlan(id): void` (throws if not deletable)
  - `schedulePriceChange(id, {newPriceCents, appliesTo, effectiveDate, reason}, userId): {id, effectiveDate}`
  - `applyDuePriceChanges(): number` (count applied)

- [ ] **Step 1: Write the failing test**

Create `server/test/plans-lib.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db, migrate, one, run } = await import('../db/index.js');
const { migratePlans } = await import('../db/migrate_plans.js');
migrate(); migratePlans();

const plans = await import('../lib/plans.js');

function seedCustomerOnPlan(planId, priceCents) {
  run(`INSERT INTO users (email,password_hash,role,first_name,last_name)
       VALUES ('c'||abs(random())||'@t.local','x','customer','C','C')`);
  const userId = one(`SELECT last_insert_rowid() AS id`).id;
  run(`INSERT INTO customers (user_id, status) VALUES (?, 'active')`, userId);
  const custId = one(`SELECT last_insert_rowid() AS id`).id;
  run(`INSERT INTO subscriptions (customer_id, plan_id, locked_price_cents, status)
       VALUES (?, ?, ?, 'active')`, custId, planId, priceCents);
  return custId;
}

test('createPlan generates a unique code and defaults', () => {
  const a = plans.createPlan({ name: 'Standard Monthly', priceCents: 3000,
    intervalUnit: 'month', intervalCount: 1, status: 'active', customerAvailable: 1 }, 1);
  const b = plans.createPlan({ name: 'Standard Monthly', priceCents: 3000,
    intervalUnit: 'month', intervalCount: 1, status: 'draft' }, 1);
  const rowA = one(`SELECT * FROM plans WHERE id = ?`, a.id);
  const rowB = one(`SELECT * FROM plans WHERE id = ?`, b.id);
  assert.equal(rowA.code, 'StandardMonthly');
  assert.notEqual(rowB.code, rowA.code); // uniqueness suffix
  assert.equal(rowA.currency, 'USD');
});

test('updatePlan changes details but not status', () => {
  const { id } = plans.createPlan({ name: 'Edit Me', priceCents: 1000,
    intervalUnit: 'week', intervalCount: 1, status: 'active' }, 1);
  plans.updatePlan(id, { name: 'Edited', priceCents: 1200, intervalUnit: 'week',
    intervalCount: 2, label: 'Best Value' }, 1);
  const row = one(`SELECT * FROM plans WHERE id = ?`, id);
  assert.equal(row.name, 'Edited');
  assert.equal(row.price_cents, 1200);
  assert.equal(row.interval_count, 2);
  assert.equal(row.status, 'active'); // unchanged
  assert.ok(row.updated_at);
});

test('duplicatePlan clones as a fresh draft, unavailable, new code', () => {
  const { id } = plans.createPlan({ name: 'Popular', priceCents: 5000,
    intervalUnit: 'month', intervalCount: 6, status: 'active', customerAvailable: 1 }, 1);
  const dup = plans.duplicatePlan(id, 1);
  const row = one(`SELECT * FROM plans WHERE id = ?`, dup.id);
  assert.equal(row.status, 'draft');
  assert.equal(row.customer_available, 0);
  assert.match(row.name, /Copy/);
  assert.notEqual(row.code, one(`SELECT code FROM plans WHERE id = ?`, id).code);
});

test('a plan with subscription history cannot be hard-deleted', () => {
  const { id } = plans.createPlan({ name: 'Has Subs', priceCents: 2000,
    intervalUnit: 'month', intervalCount: 1, status: 'active' }, 1);
  seedCustomerOnPlan(id, 2000);
  const del = plans.planDeletability(id);
  assert.equal(del.deletable, false);
  assert.throws(() => plans.deletePlan(id));
});

test('an unused draft plan can be hard-deleted', () => {
  const { id } = plans.createPlan({ name: 'Throwaway', priceCents: 100,
    intervalUnit: 'month', intervalCount: 1, status: 'draft' }, 1);
  assert.equal(plans.planDeletability(id).deletable, true);
  plans.deletePlan(id);
  assert.equal(one(`SELECT id FROM plans WHERE id = ?`, id), undefined);
});

test('new-scope price change touches no existing subscriber', () => {
  const { id } = plans.createPlan({ name: 'NewScope', priceCents: 2000,
    intervalUnit: 'month', intervalCount: 1, status: 'active' }, 1);
  const custId = seedCustomerOnPlan(id, 2000);
  plans.schedulePriceChange(id, { newPriceCents: 2500, appliesTo: 'new',
    effectiveDate: '2020-01-01' }, 1); // past date, but 'new' scope
  plans.applyDuePriceChanges();
  assert.equal(one(`SELECT price_cents FROM plans WHERE id = ?`, id).price_cents, 2500);
  assert.equal(one(`SELECT locked_price_cents FROM subscriptions WHERE customer_id = ?`, custId).locked_price_cents, 2000);
});

test('existing_and_new applies to live subscriptions once due, not before', () => {
  const { id } = plans.createPlan({ name: 'ExistingScope', priceCents: 2000,
    intervalUnit: 'month', intervalCount: 1, status: 'active' }, 1);
  const custId = seedCustomerOnPlan(id, 2000);
  // Future effective date: not yet due.
  plans.schedulePriceChange(id, { newPriceCents: 3000, appliesTo: 'existing_and_new',
    effectiveDate: '2999-01-01' }, 1);
  plans.applyDuePriceChanges();
  assert.equal(one(`SELECT locked_price_cents FROM subscriptions WHERE customer_id = ?`, custId).locked_price_cents, 2000);
  // A due (past) effective date applies.
  run(`UPDATE plan_price_changes SET effective_date = '2020-01-01' WHERE plan_id = ?`, id);
  const applied = plans.applyDuePriceChanges();
  assert.ok(applied >= 1);
  assert.equal(one(`SELECT locked_price_cents FROM subscriptions WHERE customer_id = ?`, custId).locked_price_cents, 3000);
  // Idempotent: a second run does nothing new.
  assert.equal(plans.applyDuePriceChanges(), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/plans-lib.test.js`
Expected: FAIL — cannot find module `../lib/plans.js`.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/plans.js`:

```js
/* ============================================================
   Plan data access: create / edit / duplicate, deletability, and
   the effective-dated price-change engine.

   Price rule: a plan's advertised price_cents changes immediately
   (new customers pay it at signup). Existing subscribers keep their
   locked_price_cents until a scheduled change's effective_date
   (default: change date + grace days) falls due — then, and only for
   'existing_and_new' changes, their locked price switches. Historical
   payments are never touched.
   ============================================================ */

import { one, all, run, tx } from '../db/index.js';
import { slugCode } from './billing.js';
import { setting } from './permissions.js';

/** A code not already used by another plan. */
export function uniqueCode(base) {
  const root = slugCode(base);
  if (!one(`SELECT id FROM plans WHERE code = ? COLLATE NOCASE`, root)) return root;
  for (let n = 2; ; n++) {
    const candidate = `${root}${n}`;
    if (!one(`SELECT id FROM plans WHERE code = ? COLLATE NOCASE`, candidate)) return candidate;
  }
}

export function createPlan(input, userId) {
  const {
    name, description = null, internalNotes = null, priceCents,
    intervalUnit, intervalCount, customerAvailable = 0, status = 'draft',
    displayOrder = null, label = null, currency = 'USD', code = null,
  } = input;
  const order = displayOrder ?? ((one(`SELECT COALESCE(MAX(display_order), 0) + 1 AS n FROM plans`).n) || 1);
  const id = run(`
    INSERT INTO plans (code, name, description, internal_notes, price_cents, currency,
                       interval_unit, interval_count, customer_available, status,
                       display_order, label, provider_plan_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo')`,
    code || uniqueCode(name), name, description, internalNotes, priceCents, currency,
    intervalUnit, intervalCount, customerAvailable ? 1 : 0, status, order, label).lastInsertRowid;
  return { id };
}

export function updatePlan(id, input, userId) {
  const cur = one(`SELECT * FROM plans WHERE id = ?`, id);
  if (!cur) throw Object.assign(new Error('Plan not found.'), { status: 404 });
  const v = {
    name: input.name ?? cur.name,
    description: input.description ?? cur.description,
    internal_notes: input.internalNotes ?? cur.internal_notes,
    price_cents: input.priceCents ?? cur.price_cents,
    currency: input.currency ?? cur.currency,
    interval_unit: input.intervalUnit ?? cur.interval_unit,
    interval_count: input.intervalCount ?? cur.interval_count,
    customer_available: input.customerAvailable === undefined
      ? cur.customer_available : (input.customerAvailable ? 1 : 0),
    display_order: input.displayOrder ?? cur.display_order,
    label: input.label === undefined ? cur.label : input.label,
  };
  run(`UPDATE plans SET name=?, description=?, internal_notes=?, price_cents=?, currency=?,
          interval_unit=?, interval_count=?, customer_available=?, display_order=?, label=?,
          updated_at=datetime('now')
        WHERE id=?`,
    v.name, v.description, v.internal_notes, v.price_cents, v.currency,
    v.interval_unit, v.interval_count, v.customer_available, v.display_order, v.label, id);
}

export function duplicatePlan(id, userId) {
  const p = one(`SELECT * FROM plans WHERE id = ?`, id);
  if (!p) throw Object.assign(new Error('Plan not found.'), { status: 404 });
  return createPlan({
    name: `${p.name} (Copy)`, description: p.description, internalNotes: p.internal_notes,
    priceCents: p.price_cents, currency: p.currency, intervalUnit: p.interval_unit,
    intervalCount: p.interval_count, customerAvailable: 0, status: 'draft',
    label: p.label,
  }, userId);
}

export function planCustomerCount(id) {
  return one(`SELECT COUNT(*) AS n FROM subscriptions
               WHERE plan_id = ? AND status != 'cancelled'`, id).n;
}

/** History-safe: a plan referenced by any subscription or coupon is never deleted. */
export function planDeletability(id) {
  const subs = one(`SELECT COUNT(*) AS n FROM subscriptions WHERE plan_id = ?`, id).n;
  const coup = one(`SELECT COUNT(*) AS n FROM coupon_plans WHERE plan_id = ?`, id).n;
  if (subs > 0) return { deletable: false, reason: `${subs} subscription(s) reference this plan. Archive it instead.` };
  if (coup > 0) return { deletable: false, reason: `A coupon targets this plan. Archive it instead.` };
  return { deletable: true, reason: null };
}

export function deletePlan(id) {
  const del = planDeletability(id);
  if (!del.deletable) throw Object.assign(new Error(del.reason), { status: 409 });
  run(`DELETE FROM plans WHERE id = ?`, id);
}

/** Schedule a price change. Advertised price updates immediately. */
export function schedulePriceChange(id, { newPriceCents, appliesTo, effectiveDate, reason = null }, userId) {
  const plan = one(`SELECT * FROM plans WHERE id = ?`, id);
  if (!plan) throw Object.assign(new Error('Plan not found.'), { status: 404 });
  const oldPrice = plan.price_cents;
  const grace = setting('plan.price_change_grace_days', 90);
  const effective = effectiveDate
    || new Date(Date.now() + grace * 86400000).toISOString().slice(0, 10);

  return tx(() => {
    // Advertised price changes now — this is the "new customers" effect.
    run(`UPDATE plans SET price_cents = ?, updated_at = datetime('now') WHERE id = ?`, newPriceCents, id);
    // Existing-customer switch is recorded and applied at the effective date.
    if (appliesTo === 'existing_and_new') {
      const pcId = run(`
        INSERT INTO plan_price_changes (plan_id, old_price_cents, new_price_cents,
                                        applies_to, effective_date, reason, created_by)
        VALUES (?, ?, ?, 'existing_and_new', ?, ?, ?)`,
        id, oldPrice, newPriceCents, effective, reason, userId ?? null).lastInsertRowid;
      return { id: pcId, effectiveDate: effective };
    }
    return { id: null, effectiveDate: null };
  });
}

/**
 * Apply every scheduled existing_and_new change whose effective date has
 * arrived. Idempotent: each row flips to 'applied' so a re-run is a no-op.
 * Returns the number of change rows applied.
 */
export function applyDuePriceChanges() {
  const due = all(`SELECT * FROM plan_price_changes
                    WHERE status = 'scheduled' AND applies_to = 'existing_and_new'
                      AND effective_date <= date('now')`);
  let applied = 0;
  for (const pc of due) {
    tx(() => {
      // Only subscriptions still on the OLD price and still live. Promo
      // subscriptions keep their frozen promo_price_cents; their eventual
      // reversion reads the (now-updated) locked_price_cents.
      const subs = all(`SELECT id FROM subscriptions
                         WHERE plan_id = ? AND locked_price_cents = ?
                           AND status IN ('active','past_due','paused')`,
                        pc.plan_id, pc.old_price_cents);
      for (const s of subs) {
        run(`UPDATE subscriptions SET locked_price_cents = ? WHERE id = ?`, pc.new_price_cents, s.id);
        run(`INSERT INTO audit_log (action, entity_type, entity_id, detail)
             VALUES ('subscription.reprice', 'subscription', ?, ?)`,
          s.id, JSON.stringify({ planId: pc.plan_id, from: pc.old_price_cents, to: pc.new_price_cents, priceChangeId: pc.id }));
      }
      run(`UPDATE plan_price_changes SET status = 'applied', applied_at = datetime('now') WHERE id = ?`, pc.id);
    });
    applied++;
  }
  return applied;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/plans-lib.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/plans.js server/test/plans-lib.test.js
git commit -m "feat(plans): plan CRUD, deletability, and effective-dated re-pricing"
```

---

## Task 4: `lib/plan_lifecycle.js` — status transitions

**Files:**
- Create: `server/lib/plan_lifecycle.js`
- Test: `server/test/plan-lifecycle.test.js`

**Interfaces:**
- Consumes: `lib/lifecycle.js` (`field`, `availableActions`, `resolveAction`), `db/index.js`.
- Produces:
  - `PLAN_STATUSES` object
  - `PLAN_LIFECYCLE` spec (`{ entity, statusField, statuses, actions }`) with actions `activate`, `deactivate`, `archive`, `restore`, each with a `run(record, values, ctx)` that writes the new status (and `archived_at` on archive).

- [ ] **Step 1: Write the failing test**

Create `server/test/plan-lifecycle.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/plan-lifecycle.test.js`
Expected: FAIL — cannot find module `../lib/plan_lifecycle.js`.

- [ ] **Step 3: Write minimal implementation**

Create `server/lib/plan_lifecycle.js`:

```js
/* ============================================================
   What can happen to a subscription plan, and what each does.
   Draft while being built; Active while selectable; Inactive when
   it stops taking NEW subscriptions (existing history stays); Archived
   when filed away. Nothing here deletes subscription history.
   ============================================================ */

import { run } from '../db/index.js';
import { field } from './lifecycle.js';

export const PLAN_STATUSES = {
  draft:    { label: 'Draft',    tone: 'muted',
              description: 'Still being configured. Customers cannot see it.' },
  active:   { label: 'Active',   tone: 'ok',
              description: 'Available for use. May be offered to customers when made available.' },
  inactive: { label: 'Inactive', tone: 'warn',
              description: 'Not accepting new subscriptions. Existing customer history stays.' },
  archived: { label: 'Archived', tone: 'muted',
              description: 'Out of normal management views. Preserved historically.' },
};

const noteField = () => [field('notes', 'Notes', 'textarea', { required: false })];

export const PLAN_LIFECYCLE = {
  entity: 'plan',
  statusField: 'status',
  statuses: PLAN_STATUSES,
  actions: {
    activate: {
      label: 'Activate Plan', tone: 'primary',
      from: ['draft', 'inactive'], to: 'active',
      fields: noteField,
      confirmTitle: (p) => `Activate ${p.name}?`,
      effects: ['The plan becomes usable. Make it customer-available to offer it at signup.'],
      run(p) {
        run(`UPDATE plans SET status='active', archived_at=NULL, updated_at=datetime('now') WHERE id=?`, p.id);
        return { message: `${p.name} is active.` };
      },
    },
    deactivate: {
      label: 'Deactivate Plan', tone: 'warn',
      from: ['active'], to: 'inactive',
      fields: noteField,
      confirmTitle: (p) => `Deactivate ${p.name}?`,
      effects: ['No NEW subscriptions can be created on it.',
                'Existing subscribers and all history are untouched.'],
      run(p) {
        run(`UPDATE plans SET status='inactive', customer_available=0, updated_at=datetime('now') WHERE id=?`, p.id);
        return { message: `${p.name} no longer accepts new subscriptions.` };
      },
    },
    archive: {
      label: 'Archive Plan', tone: 'danger',
      from: ['draft', 'active', 'inactive'], to: 'archived',
      fields: noteField,
      confirmTitle: (p) => `Archive ${p.name}?`,
      effects: ['It leaves active management views.',
                'Every subscription and coupon link to it is preserved.'],
      run(p) {
        run(`UPDATE plans SET status='archived', customer_available=0,
                archived_at=datetime('now'), updated_at=datetime('now') WHERE id=?`, p.id);
        return { message: `${p.name} archived. History is intact.` };
      },
    },
    restore: {
      label: 'Restore Plan', tone: 'primary',
      from: ['archived'], to: 'inactive',
      fields: noteField,
      confirmTitle: (p) => `Restore ${p.name} from the archive?`,
      effects: ['It returns as Inactive. Activate it to offer it again.'],
      run(p) {
        run(`UPDATE plans SET status='inactive', archived_at=NULL, updated_at=datetime('now') WHERE id=?`, p.id);
        return { message: `${p.name} restored as inactive.` };
      },
    },
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/test/plan-lifecycle.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/lib/plan_lifecycle.js server/test/plan-lifecycle.test.js
git commit -m "feat(plans): draft/active/inactive/archived lifecycle spec"
```

---

## Task 5: `routes/plans.js` + permissions + mount

**Files:**
- Modify: `server/db/schema_roles.sql` (permission catalog)
- Create: `server/routes/plans.js`
- Modify: `server/server.js` (import `migratePlans`, run it + `applyDuePriceChanges()` at boot, mount router)
- Test: `server/test/plans-routes.test.js`

**Interfaces:**
- Consumes: `lib/plans.js`, `lib/plan_lifecycle.js`, `lib/billing.js`, `lib/permissions.js` (`requirePermission`), `lib/audit.js` (`audit`), `lib/lifecycle.js`.
- Produces (all under `/api/admin/plans`, admin-mounted):
  - `GET /` → `{ plans: [{id, code, name, price, priceCents, currency, intervalUnit, intervalCount, frequency, perLabel, customerAvailable, status, statusLabel, displayOrder, label, customers}] }` ordered by `display_order, id`.
  - `GET /:id` → `{ plan, actions, deletion, priceChanges }`.
  - `POST /` (create), `PATCH /:id` (edit), `POST /:id/duplicate`, `DELETE /:id`.
  - `GET /:id/actions`, `POST /:id/action` (`{ action, ...fields }`).
  - `POST /:id/price-change` (`{ newPriceDollars|newPriceCents, appliesTo, effectiveDate, reason }`).

**New permission keys** (add to `schema_roles.sql` catalog, new category "Plans & Billing"):
`plans.view`, `plans.create`, `plans.edit`, `plans.status`, `plans.archive`.

- [ ] **Step 1: Add permissions to `server/db/schema_roles.sql`**

In the `INSERT OR IGNORE INTO permissions (key, category, label, sort_order) VALUES` list, add before the `system.*` block:

```sql
  ('plans.view','Plans & Billing','View subscription plans',66),
  ('plans.create','Plans & Billing','Create subscription plans',67),
  ('plans.edit','Plans & Billing','Edit subscription plans',68),
  ('plans.status','Plans & Billing','Activate / deactivate plans',69),
  ('plans.archive','Plans & Billing','Archive plans',70),
```

(Renumber only if a sort-order collision matters; duplicates are harmless for display. Keep the comma/semicolon correct.)

- [ ] **Step 2: Write the failing test**

Create `server/test/plans-routes.test.js`. It mounts the router on a bare Express app with a fake admin user and drives the endpoints:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DB_PATH = ':memory:';
const { migrate, one } = await import('../db/index.js');
const { migratePlans } = await import('../db/migrate_plans.js');
migrate(); migratePlans();
const { router } = await import('../routes/plans.js');

// Minimal harness: inject an admin user, JSON body parsing, mount router.
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: 1, role: 'admin' }; next(); });
app.use('/api/admin/plans', router);

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/admin/plans`;
const api = async (method, path = '', body) => {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('create -> list -> edit -> lifecycle -> price-change flow', async () => {
  // Create
  const created = await api('POST', '', { name: 'Weekly', priceDollars: 8,
    intervalUnit: 'week', intervalCount: 1, status: 'active', customerAvailable: true });
  assert.equal(created.status, 200);
  const id = created.json.plan.id;

  // List shows a human frequency + customer count
  const list = await api('GET');
  const row = list.json.plans.find(p => p.id === id);
  assert.equal(row.frequency, 'weekly');
  assert.equal(row.customers, 0);
  assert.equal(row.status, 'active');

  // Edit
  const edited = await api('PATCH', `/${id}`, { priceDollars: 9, label: 'Best Value' });
  assert.equal(edited.status, 200);
  assert.equal(one(`SELECT price_cents FROM plans WHERE id = ?`, id).price_cents, 900);

  // Lifecycle: deactivate
  const act = await api('POST', `/${id}/action`, { action: 'deactivate' });
  assert.equal(act.status, 200);
  assert.equal(one(`SELECT status FROM plans WHERE id = ?`, id).status, 'inactive');

  // Price change (existing_and_new) records a schedule row
  const pc = await api('POST', `/${id}/price-change`, { newPriceDollars: 12,
    appliesTo: 'existing_and_new', effectiveDate: '2999-01-01' });
  assert.equal(pc.status, 200);
  assert.equal(one(`SELECT price_cents FROM plans WHERE id = ?`, id).price_cents, 1200);
  assert.ok(one(`SELECT id FROM plan_price_changes WHERE plan_id = ?`, id));
});

test('an unknown action is rejected', async () => {
  const created = await api('POST', '', { name: 'X', priceDollars: 5,
    intervalUnit: 'month', intervalCount: 1, status: 'draft' });
  const id = created.json.plan.id;
  const res = await api('POST', `/${id}/action`, { action: 'bogus' });
  assert.equal(res.status, 400);
});

test.after(() => server.close());
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test server/test/plans-routes.test.js`
Expected: FAIL — cannot find module `../routes/plans.js`.

- [ ] **Step 4: Write minimal implementation**

Create `server/routes/plans.js`:

```js
/* ============================================================
   Admin subscription-plan management. CRUD, the lifecycle engine,
   and effective-dated price changes — every mutation permission-gated
   and audited. Customer-facing plan selection lives in routes/customer.js.
   ============================================================ */

import { Router } from 'express';
import { one, all } from '../db/index.js';
import { requirePermission } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';
import { availableActions, resolveAction } from '../lib/lifecycle.js';
import { PLAN_LIFECYCLE, PLAN_STATUSES } from '../lib/plan_lifecycle.js';
import { frequencyLabel, perLabel, INTERVAL_UNITS } from '../lib/billing.js';
import {
  createPlan, updatePlan, duplicatePlan, deletePlan,
  planDeletability, planCustomerCount, schedulePriceChange, applyDuePriceChanges,
} from '../lib/plans.js';

export const router = Router();
const money = (cents) => cents / 100;
const centsFrom = (body, dollarsKey, centsKey) =>
  body[centsKey] != null ? Math.round(Number(body[centsKey]))
  : body[dollarsKey] != null ? Math.round(Number(body[dollarsKey]) * 100) : null;

function shape(p) {
  return {
    id: p.id, code: p.code, name: p.name, description: p.description,
    internalNotes: p.internal_notes,
    priceCents: p.price_cents, price: money(p.price_cents), currency: p.currency,
    intervalUnit: p.interval_unit, intervalCount: p.interval_count,
    frequency: frequencyLabel(p.interval_unit, p.interval_count),
    perLabel: perLabel(p.interval_unit, p.interval_count),
    customerAvailable: Boolean(p.customer_available),
    status: p.status, statusLabel: PLAN_STATUSES[p.status]?.label ?? p.status,
    displayOrder: p.display_order, label: p.label,
    customers: planCustomerCount(p.id),
  };
}

function validIntervals(body) {
  if (body.intervalUnit && !INTERVAL_UNITS.includes(body.intervalUnit)) {
    return 'Billing unit must be week, month, or year.';
  }
  if (body.intervalCount != null && !(Number(body.intervalCount) >= 1)) {
    return 'Billing count must be a whole number of 1 or more.';
  }
  return null;
}

/* ---- list ---- */
router.get('/', requirePermission('plans.view'), (req, res) => {
  applyDuePriceChanges();
  const rows = all(`SELECT * FROM plans WHERE status != 'archived' OR ?1 = 1
                     ORDER BY display_order, id`,
                   req.query.includeArchived ? 1 : 0);
  res.json({ plans: rows.map(shape) });
});

/* ---- one, with actions + deletability + price-change history ---- */
router.get('/:id', requirePermission('plans.view'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  res.json({
    plan: shape(p),
    actions: availableActions(PLAN_LIFECYCLE, p),
    deletion: planDeletability(p.id),
    priceChanges: all(`SELECT * FROM plan_price_changes WHERE plan_id = ? ORDER BY id DESC`, p.id)
      .map(pc => ({ id: pc.id, from: money(pc.old_price_cents), to: money(pc.new_price_cents),
                    appliesTo: pc.applies_to, effectiveDate: pc.effective_date,
                    status: pc.status, reason: pc.reason })),
  });
});

/* ---- create ---- */
router.post('/', requirePermission('plans.create'), (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: 'A plan name is required.' });
  const priceCents = centsFrom(b, 'priceDollars', 'priceCents');
  if (priceCents == null || priceCents < 0) return res.status(400).json({ error: 'A price is required.' });
  const bad = validIntervals(b);
  if (bad) return res.status(400).json({ error: bad });
  const { id } = createPlan({
    name: b.name, description: b.description, internalNotes: b.internalNotes,
    priceCents, intervalUnit: b.intervalUnit || 'month', intervalCount: Number(b.intervalCount) || 1,
    customerAvailable: b.customerAvailable, status: b.status || 'draft',
    displayOrder: b.displayOrder, label: b.label, currency: b.currency,
  }, req.user.id);
  audit(req, 'plan.created', { entityType: 'plan', entityId: id, detail: { name: b.name } });
  res.json({ plan: shape(one(`SELECT * FROM plans WHERE id = ?`, id)) });
});

/* ---- edit (details only; status is lifecycle) ---- */
router.patch('/:id', requirePermission('plans.edit'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  const b = req.body || {};
  const bad = validIntervals(b);
  if (bad) return res.status(400).json({ error: bad });
  const priceCents = centsFrom(b, 'priceDollars', 'priceCents');
  updatePlan(p.id, {
    name: b.name, description: b.description, internalNotes: b.internalNotes,
    priceCents: priceCents ?? undefined,
    intervalUnit: b.intervalUnit, intervalCount: b.intervalCount != null ? Number(b.intervalCount) : undefined,
    customerAvailable: b.customerAvailable, displayOrder: b.displayOrder, label: b.label, currency: b.currency,
  }, req.user.id);
  audit(req, 'plan.updated', { entityType: 'plan', entityId: p.id, detail: { fields: Object.keys(b) } });
  res.json({ plan: shape(one(`SELECT * FROM plans WHERE id = ?`, p.id)) });
});

/* ---- duplicate ---- */
router.post('/:id/duplicate', requirePermission('plans.create'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  const { id } = duplicatePlan(p.id, req.user.id);
  audit(req, 'plan.duplicated', { entityType: 'plan', entityId: id, detail: { from: p.id } });
  res.json({ plan: shape(one(`SELECT * FROM plans WHERE id = ?`, id)) });
});

/* ---- delete (only when nothing references it) ---- */
router.delete('/:id', requirePermission('plans.archive'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  try {
    deletePlan(p.id);
  } catch (err) {
    return res.status(err.status || 409).json({ error: err.message });
  }
  audit(req, 'plan.deleted', { entityType: 'plan', entityId: p.id, detail: { name: p.name } });
  res.json({ ok: true });
});

/* ---- lifecycle ---- */
router.get('/:id/actions', requirePermission('plans.view'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  res.json({ status: p.status, actions: availableActions(PLAN_LIFECYCLE, p),
             deletion: planDeletability(p.id) });
});

router.post('/:id/action', requirePermission('plans.status', 'plans.archive'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  const { action, ...input } = req.body || {};
  let resolved;
  try {
    resolved = resolveAction(PLAN_LIFECYCLE, p, action, input, {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message, code: err.code });
  }
  const result = resolved.action.run(p, resolved.values, { userId: req.user.id, input });
  audit(req, `plan.${action}`, { entityType: 'plan', entityId: p.id,
    detail: { from: resolved.from, to: resolved.to } });
  res.json({ ok: true, ...result, plan: shape(one(`SELECT * FROM plans WHERE id = ?`, p.id)) });
});

/* ---- price change ---- */
router.post('/:id/price-change', requirePermission('plans.edit'), (req, res) => {
  const p = one(`SELECT * FROM plans WHERE id = ?`, req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found.' });
  const b = req.body || {};
  const newPriceCents = centsFrom(b, 'newPriceDollars', 'newPriceCents');
  if (newPriceCents == null || newPriceCents < 0) return res.status(400).json({ error: 'A new price is required.' });
  if (!['new', 'existing_and_new'].includes(b.appliesTo)) {
    return res.status(400).json({ error: 'appliesTo must be "new" or "existing_and_new".' });
  }
  const out = schedulePriceChange(p.id, {
    newPriceCents, appliesTo: b.appliesTo, effectiveDate: b.effectiveDate || null, reason: b.reason,
  }, req.user.id);
  audit(req, 'plan.price_change', { entityType: 'plan', entityId: p.id,
    detail: { to: money(newPriceCents), appliesTo: b.appliesTo, effectiveDate: out.effectiveDate } });
  res.json({ ok: true, effectiveDate: out.effectiveDate,
             plan: shape(one(`SELECT * FROM plans WHERE id = ?`, p.id)) });
});
```

- [ ] **Step 5: Mount in `server/server.js`**

Add the import near the other route imports (after `settingsRouter`):

```js
import { router as plansRouter } from './routes/plans.js';
```

Add the migration import alongside the other db migration imports:

```js
import { migratePlans } from './db/migrate_plans.js';
```

In the boot migration block (around `server.js:332-337`), add `migratePlans()` to the changes spread and call `applyDuePriceChanges()` once after migrations:

```js
const adminChanges = [...migrateAdmin(), ...migrateCommunities(), ...migrateIssueCodes(),
                      ...migrateAdminControls(), ...migrateDynamicRoles(),
                      ...migrateCommunityLifecycle(), ...migratePlans()];
migrateDemoFlags();
```

Then, after `migrateDemoFlags();`, add:

```js
import('./lib/plans.js').then(({ applyDuePriceChanges }) => applyDuePriceChanges()).catch(() => {});
```

(Or, if top-level imports are preferred, `import { applyDuePriceChanges } from './lib/plans.js';` at the top and call `applyDuePriceChanges();` after the migrations.)

Mount the router with the other `app.use('/api/...')` lines:

```js
app.use('/api/admin/plans', plansRouter);   // per-permission, enforced inside
```

Place this line BEFORE `app.use('/api/admin', adminRouter);` is not required (paths differ), but keep it grouped with the admin mounts.

- [ ] **Step 6: Run test to verify it passes**

Run: `node --test server/test/plans-routes.test.js`
Expected: PASS.

- [ ] **Step 7: Full suite + commit**

Run: `npm test`
Expected: existing tests still pass (none referenced `plans.interval_months` in a way Task 6 hasn't fixed yet — if any legacy test fails on the schema change, note it for Task 6; the plan-specific tests pass).

```bash
git add server/db/schema_roles.sql server/routes/plans.js server/server.js server/test/plans-routes.test.js
git commit -m "feat(plans): admin CRUD + lifecycle + price-change routes, permissions, boot wiring"
```

---

## Task 6: Retire legacy plans columns (`interval_months` + `active`) across admin, signup, finance seed, and test fixtures

**Files:**
- Modify: `server/routes/admin.js:47-50` (MRR)
- Modify: `server/lib/signup.js` (next-billing computation AND the `active = 1` plan lookup)
- Modify: `server/db/seed_finance.js` (billing-cycle length from interval)
- Modify: the 8 test fixtures that `INSERT INTO plans (...interval_months...)` — see Step 3e for the full list
- Test: `server/test/interval-months-retired.test.js`

**Interfaces:**
- Consumes: `lib/billing.js` (`monthsEquivalent`, `addInterval`).

**Context:** The `plans` table rebuild (Task 2) removed BOTH `interval_months` and `active`. This task makes every remaining producer/consumer consistent with the new `interval_unit`/`interval_count` + `status` columns, and updates the test fixtures that seed plans with the old columns, so the FULL suite goes green. `customer.js`'s plan queries are intentionally NOT in this task — they are consolidated into Task 7 (which owns every `customer.js` plan edit) to avoid two tasks editing the same file.

- [ ] **Step 1: Write the failing test**

Create `server/test/interval-months-retired.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/interval-months-retired.test.js`
Expected: FAIL — those files still contain `interval_months` / `active = 1`.

- [ ] **Step 3a: `server/routes/admin.js` MRR**

Add near the top imports: `import { monthsEquivalent } from '../lib/billing.js';`

Replace the SQL-division MRR query (lines ~47-50) with a JS computation that avoids dividing by a non-existent column:

```js
  // MRR normalized to a month. A promotional subscription still on its term
  // bills at promo_price_cents; count that, not the standard rate.
  const mrrRows = all(`
    SELECT p.interval_unit, p.interval_count,
           CASE WHEN s.promo_periods_remaining > 0 THEN s.promo_price_cents
                ELSE s.locked_price_cents END AS cents
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.status = 'active' AND s.is_demo = 0`);
  const mrrCents = mrrRows.reduce((sum, r) =>
    sum + r.cents / monthsEquivalent(r.interval_unit, r.interval_count), 0);
```

(Ensure `all` is imported in `admin.js`; it already imports db helpers — confirm and add `all` to the import if missing.)

- [ ] **Step 3b: `server/lib/signup.js` — next-billing AND plan lookup**

Add import: `import { addInterval } from './billing.js';`

(1) Replace the block that does `next.setMonth(next.getMonth() + planRow.interval_months)` with:

```js
      const nextBilling = addInterval(startDate || new Date().toISOString().slice(0, 10),
                                      planRow.interval_unit, planRow.interval_count);
      run(`UPDATE subscriptions SET status = 'active', next_billing_date = ?
            WHERE id = ?`, nextBilling, ids.subscriptionId);
```

(The `planRow` is already `SELECT * FROM plans`, so `interval_unit`/`interval_count` are present. Remove the now-unused `next` Date construction.)

(2) The plan lookup currently filters on the removed `active` column:

```js
  const planRow = one(`SELECT * FROM plans WHERE code = ? AND active = 1`, planCode);
```

Change it to filter on `status` instead:

```js
  const planRow = one(`SELECT * FROM plans WHERE code = ? AND status = 'active'`, planCode);
```

- [ ] **Step 3c: `server/db/seed_finance.js` — billing-cycle length**

This file computes a billing cycle in days from `interval_months` (around line 109-114):

```js
  const subs = all(`SELECT s.*, p.interval_months FROM subscriptions s
                    JOIN plans p ON p.id = s.plan_id ...`);
  ...
    const cycleDays = 30 * sub.interval_months;
```

Add import: `import { monthsEquivalent } from '../lib/billing.js';`
Select the new columns and derive the cycle length from them:

```js
  const subs = all(`SELECT s.*, p.interval_unit, p.interval_count FROM subscriptions s
                    JOIN plans p ON p.id = s.plan_id ...`);   // keep the rest of the WHERE unchanged
  ...
    const cycleDays = Math.round(monthsEquivalent(sub.interval_unit, sub.interval_count) * 30);
```

(Keep every other part of the query and loop as-is; only the selected columns and the `cycleDays` line change. `30 * months` is preserved for month plans since `monthsEquivalent('month', n) === n`.)

- [ ] **Step 3d: (removed — customer.js edits live in Task 7)**

- [ ] **Step 3e: Update test fixtures that seed plans with the removed columns**

Eight test files insert plans using the old `(interval_months, ... )` shape and now fail at setup. Update each `INSERT INTO plans (...)` to the new columns, making the plan usable where the test expects a billable plan (`status='active'`, and `customer_available=1` if a customer path reads it). The files:

```
server/test/atomic-redemption.test.js
server/test/intro-redemption.test.js
server/test/final-review-fixes.test.js
server/test/public-intro-signup.test.js
server/test/signup-email-reuse-guard.test.js
server/test/security-acceptance.test.js
server/test/demo-isolation.test.js
server/test/signup.test.js
```

Mechanical transform for each plan insert, e.g.:

```js
// BEFORE
db.exec(`INSERT INTO plans (code,name,interval_months,price_cents,is_intro)
         VALUES ('Monthly','Monthly',1,2800,0)`);
// AFTER
db.exec(`INSERT INTO plans (code,name,interval_unit,interval_count,price_cents,is_intro,status,customer_available)
         VALUES ('Monthly','Monthly','month',1,2800,0,'active',1)`);
```

Map old month counts to `('month', N)`: `1→month,1`; `3→month,3`; `12→year,1` (or `month,12` — either is correct, prefer `year,1` for Annual). Preserve each row's existing `code`, `name`, `price_cents`, and `is_intro` values exactly. Do not change any other part of these test files. After editing, run each file to confirm it passes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test server/test/interval-months-retired.test.js`
Expected: PASS.
Run: `npm test`
Expected: FULL suite green — the 8 previously-failing fixtures now pass, and no new failures. (Customer.js `/plans` and `/plan/change` still reference `active`/`interval_months` at this point, but no existing test exercises those DB paths; Task 7 fixes them. If `npm test` shows a failure traceable to a customer.js plan query, note it — it means a test does exercise that path and Task 7 must run next.)

- [ ] **Step 5: Commit**

```bash
git add server/routes/admin.js server/lib/signup.js server/db/seed_finance.js server/test/
git commit -m "refactor(plans): retire interval_months + active in admin, signup, finance seed, and fixtures"
```

---

## Task 7: Customer plan queries — availability, ordering, labels, next-billing

**Files:**
- Modify: `server/routes/customer.js` (`/account` subscription block; `/plans` offering; `/plan/change` lookup + next-billing) — this task owns ALL customer.js plan edits
- Test: `server/test/customer-plan-availability.test.js`

**Interfaces:**
- Consumes: `lib/billing.js` (`addInterval`, `frequencyLabel`, `perLabel`).

**Context:** After Task 6, every plan producer/consumer is on the new columns EXCEPT `customer.js`, which still references `interval_months` (in `/account`) and the removed `active` column (in `/plans` and `/plan/change`). This task migrates all three and adds availability gating + ordering.

- [ ] **Step 1: Write the failing test**

Create `server/test/customer-plan-availability.test.js`. It guards (a) the offering filter and (b) that `customer.js` no longer references the removed columns:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.DB_PATH = ':memory:';
const { migrate, all, run } = await import('../db/index.js');
const { migratePlans } = await import('../db/migrate_plans.js');
migrate(); migratePlans();

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, '..', p), 'utf8');

function mk(code, status, avail, order) {
  run(`INSERT INTO plans (code,name,price_cents,interval_unit,interval_count,status,customer_available,display_order)
       VALUES (?,?,?,?,?,?,?,?)`, code, code, 1000, 'month', 1, status, avail, order);
}

test('only active + customer_available plans are offered, in display_order', () => {
  mk('B', 'active', 1, 2);
  mk('A', 'active', 1, 1);
  mk('Draft', 'draft', 1, 3);      // hidden: not active
  mk('Hidden', 'active', 0, 4);    // hidden: not customer_available
  mk('Arch', 'archived', 1, 5);    // hidden

  // Mirror the route's offering query.
  const offered = all(`SELECT code FROM plans
                        WHERE status = 'active' AND customer_available = 1
                        ORDER BY display_order, id`).map(r => r.code);
  assert.deepEqual(offered, ['A', 'B']);
});

test('customer.js no longer references interval_months or the removed active column', () => {
  const src = read('routes/customer.js');
  assert.ok(!/interval_months/.test(src), 'customer.js still references interval_months');
  assert.ok(!/plans WHERE active = 1|FROM plans WHERE code = \? AND \(active = 1/.test(src),
    'customer.js still filters plans on the removed active column');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/customer-plan-availability.test.js`
Expected: FAIL — the second test fails because `customer.js` still references `interval_months`/`active`.

- [ ] **Step 3a: `server/routes/customer.js` `/account`**

Add import at top: `import { addInterval, frequencyLabel, perLabel } from '../lib/billing.js';`

In the `/account` subscription query, replace `p.interval_months` with `p.interval_unit, p.interval_count`. In the response `subscription` object, replace `intervalMonths: subscription.interval_months` with:

```js
      intervalUnit: subscription.interval_unit,
      intervalCount: subscription.interval_count,
      frequency: frequencyLabel(subscription.interval_unit, subscription.interval_count),
      perLabel: perLabel(subscription.interval_unit, subscription.interval_count),
```

- [ ] **Step 3b: `server/routes/customer.js` `/plans`**

Replace the `available` query and mapping so it (a) offers only `status='active' AND customer_available=1` plans plus the customer's current plan, ordered by `display_order`, and (b) returns `frequency`/`perLabel` instead of `intervalMonths`:

```js
  const available = all(`SELECT id, code, name, interval_unit, interval_count, price_cents, is_intro,
                                status, customer_available, display_order
                           FROM plans
                          WHERE (status = 'active' AND customer_available = 1) OR id = ?
                          ORDER BY display_order, id`, current?.plan_id ?? -1)
    .filter(p => !p.is_intro || current?.code === 'Introductory')
    .map(p => ({
      code: p.code, name: p.name,
      frequency: frequencyLabel(p.interval_unit, p.interval_count),
      perLabel: perLabel(p.interval_unit, p.interval_count),
      price: money(p.price_cents), isIntro: Boolean(p.is_intro),
      isCurrent: current?.plan_id === p.id,
      lockedPrice: current?.plan_id === p.id
        ? money(current.promo_periods_remaining > 0 ? current.promo_price_cents : current.locked_price_cents)
        : null,
      afterPrice: current?.plan_id === p.id && current.promo_periods_remaining > 0
        ? money(current.locked_price_cents) : null,
      promoPeriodsRemaining: current?.plan_id === p.id ? current.promo_periods_remaining : null,
    }));
```

Also update `/plan/change`'s plan lookup so a customer can only switch to an active + available plan (or their current one). Replace the target lookup:

```js
  const plan = one(`SELECT * FROM plans
                     WHERE code = ? AND ((status = 'active' AND customer_available = 1)
                                          OR code = 'Introductory')`, planCode);
```

(The `code = 'Introductory'` clause is retained only so the explicit intro-block message below still fires; the intro plan is `inactive`+unavailable and blocked right after.)

- [ ] **Step 4: Run tests**

Run: `node --test server/test/customer-plan-availability.test.js`
Expected: PASS.
Run: `npm test`
Expected: full suite green.

- [ ] **Step 5: Commit**

```bash
git add server/routes/customer.js server/test/customer-plan-availability.test.js
git commit -m "feat(customer): offer only active + available plans in display order"
```

---

## Task 8: Seed data — new columns + Weekly + Bi-Annual

**Files:**
- Modify: `server/db/seed.js` (plans array + inserts)
- Test: `server/test/seed-plans.test.js`

**Interfaces:** none new.

- [ ] **Step 1: Write the failing test**

Create `server/test/seed-plans.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
// Seed into a temp file DB, then inspect.
const DB = join(HERE, `seedtest-${process.pid}.db`);
process.env.DB_PATH = DB;

test('seed produces Weekly and Bi-Annual plans with correct intervals', async () => {
  const { migrate, all } = await import('../db/index.js');
  const { migratePlans } = await import('../db/migrate_plans.js');
  const seed = await import('../db/seed.js');
  migrate(); migratePlans();
  await seed.seedReferenceData();   // see Step 3 for the exported function name

  const plans = all(`SELECT code, interval_unit, interval_count, status, customer_available
                       FROM plans WHERE status = 'active' ORDER BY display_order`);
  const byCode = Object.fromEntries(plans.map(p => [p.code, p]));
  assert.equal(byCode.Weekly.interval_unit, 'week');
  assert.equal(byCode.Weekly.interval_count, 1);
  assert.equal(byCode.BiAnnual.interval_unit, 'month');
  assert.equal(byCode.BiAnnual.interval_count, 6);
  assert.equal(byCode.Monthly.interval_unit, 'month');
  assert.equal(byCode.Annual.interval_unit, 'year');
  for (const c of ['Weekly', 'Monthly', 'Quarterly', 'BiAnnual', 'Annual']) {
    assert.equal(byCode[c].customer_available, 1, `${c} should be customer-available`);
  }
});

test.after(async () => {
  const { rmSync } = await import('node:fs');
  for (const suffix of ['', '-shm', '-wal']) { try { rmSync(DB + suffix); } catch {} }
});
```

**Note:** the current `db/seed.js` seeds plans inside a larger routine. If plan seeding is not separately exported, either (a) export a small `seedReferenceData()` that inserts the plans and is called by the main seed, or (b) adjust this test to call the main seed entry point. Prefer (a) — a focused, testable function.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/test/seed-plans.test.js`
Expected: FAIL — Weekly/BiAnnual absent, or `seedReferenceData` not exported.

- [ ] **Step 3: Update `server/db/seed.js`**

Locate the plans block (around line 80):

```js
  const plans = [
    ['Monthly', 'Monthly', 1, 2800, 0],
    ['Quarterly', 'Quarterly', 3, 7400, 0],
    ['Annual', 'Annual', 12, 27600, 0],
  ];
  for (const [code, name, months, cents, intro] of plans) {
    planId[code] = run(`INSERT INTO plans (code, name, interval_months, price_cents, is_intro)
                        ...`).lastInsertRowid;
  }
```

Replace it with the new column shape and the two extra examples. Use `[code, name, unit, count, cents, order]`:

```js
  const plans = [
    ['Weekly',    'Weekly',    'week',  1,   800, 1],
    ['Monthly',   'Monthly',   'month', 1,  2800, 2],
    ['Quarterly', 'Quarterly', 'month', 3,  7400, 3],
    ['BiAnnual',  'Bi-Annual', 'month', 6, 15500, 4],
    ['Annual',    'Annual',    'year',  1, 27600, 5],
  ];
  for (const [code, name, unit, count, cents, order] of plans) {
    planId[code] = run(
      `INSERT INTO plans (code, name, interval_unit, interval_count, price_cents,
                          status, customer_available, display_order, provider_plan_id)
       VALUES (?, ?, ?, ?, ?, 'active', 1, ?, 'demo')`,
      code, name, unit, count, cents, order).lastInsertRowid;
  }
```

If the demo subscription later in seed.js references `planId.Monthly`, that key still exists — leave it. If a `seedReferenceData()` wrapper does not exist, extract the plans + launch-coupon seeding into an exported `seedReferenceData()` and call it where the inline code was.

- [ ] **Step 4: Run tests**

Run: `node --test server/test/seed-plans.test.js`
Expected: PASS.
Run from repo root to re-seed the real dev DB and confirm no crash:

```bash
node server/db/seed.js
```

Expected: seed completes; the printed summary lists 5 plans.

- [ ] **Step 5: Commit**

```bash
git add server/db/seed.js server/test/seed-plans.test.js
git commit -m "feat(seed): configurable plans + Weekly and Bi-Annual examples"
```

---

## Task 9: Admin dashboard — "Subscription Plans" tab

**Files:**
- Modify: `server/public/dashboard/admin/index.html` (nav button + `<section data-panel="plans">`)
- Modify: `server/public/dashboard/admin/admin.js` (section logic)

**Interfaces:** consumes `/api/admin/plans` endpoints from Task 5.

**Context:** This is front-end wiring following the existing page-state pattern. Before editing, READ how an existing section works end-to-end — the Coupons section (`data-tab="coupons"`, `data-panel="coupons"` in `index.html`; its handlers in `admin.js`) is the closest analogue (list table + detail card + create form). Mirror its structure, the tab-activation mechanism, the `data-perm` hidden-tab gating (as System Settings uses `data-perm="system.settings.view"`), and the list→select→edit→save/cancel→back-to-list state handling (reset selection on tab entry).

- [ ] **Step 1: Add the nav button (`index.html`)**

In `<nav class="tabs">`, add (gated on the new permission, hidden until allowed, matching the System Settings pattern):

```html
    <button data-tab="plans" data-perm="plans.view" hidden>Subscription Plans</button>
```

- [ ] **Step 2: Add the panel markup (`index.html`)**

Add a `<section data-panel="plans" hidden>` modeled on the coupons section: a page title, a "New plan" button that reveals a create/edit form (fields: name, description, price, billing frequency `<select>` with `week`/`month`/`year` plus an `interval_count` number input shown for all — labeled "every N", customer-available toggle, status `<select>` draft/active/inactive, display order, label, internal notes), a list `<table id="planTable">`, and a `<div class="card" id="planDetail" hidden>` for Manage (lifecycle actions + price-change form + price-change history). Keep IDs prefixed `plan…` to avoid collisions. Example skeleton:

```html
    <section data-panel="plans" hidden>
      <h1>Subscription Plans</h1>
      <div class="card" id="planFormCard" hidden>
        <div class="row">
          <div><label for="planName">Plan name</label><input id="planName" /></div>
          <div><label for="planPrice">Price ($)</label><input id="planPrice" type="number" step="0.01" /></div>
        </div>
        <div class="row">
          <div><label for="planUnit">Bills every</label>
            <input id="planCount" type="number" min="1" value="1" style="width:5rem" />
            <select id="planUnit"><option value="week">week(s)</option>
              <option value="month" selected>month(s)</option><option value="year">year(s)</option></select></div>
          <div><label for="planAvail">Available to customers</label>
            <select id="planAvail"><option value="0">No</option><option value="1">Yes</option></select></div>
          <div><label for="planStatus">Status</label>
            <select id="planStatus"><option value="draft">Draft</option>
              <option value="active">Active</option><option value="inactive">Inactive</option></select></div>
          <div><label for="planOrder">Display order</label><input id="planOrder" type="number" /></div>
        </div>
        <div class="row">
          <div><label for="planLabel">Label (optional)</label><input id="planLabel" placeholder="Most Popular" /></div>
          <div style="flex:2"><label for="planDesc">Description</label><input id="planDesc" /></div>
        </div>
        <div class="row"><div style="flex:1"><label for="planNotes">Internal notes</label><input id="planNotes" /></div></div>
        <p class="msg" id="planMsg" hidden></p>
        <button class="btn btn-primary" id="planSave">Save plan</button>
        <button class="btn" id="planCancel">Cancel</button>
      </div>
      <div class="card">
        <button class="btn btn-primary" id="planNew">New plan</button>
        <div class="table-wrap"><table id="planTable"></table></div>
      </div>
      <div class="card" id="planDetail" hidden></div>
    </section>
```

- [ ] **Step 3: Add section logic (`admin.js`)**

Following the coupons section's pattern in the same file, add a `plans` section controller that:

1. On tab activation, resets selection (`planDetail.hidden = true`, form hidden) and calls `loadPlans()`.
2. `loadPlans()` → `GET /api/admin/plans`, renders `#planTable` with columns **Plan · Price · Billing Frequency · Customer Available · Status · Customers · [Manage]**, using `p.price`, `p.frequency`, `p.customerAvailable ? 'Yes' : 'No'`, `p.statusLabel`, `p.customers`. Each row's Manage button calls `openPlan(p.id)`.
3. `#planNew` → clears the form to defaults, shows `#planFormCard` in create mode.
4. `#planSave` → `POST` (create) or `PATCH /:id` (edit) with the form values (`priceDollars`, `intervalUnit`, `intervalCount`, `customerAvailable`, `status`, `displayOrder`, `label`, `description`, `internalNotes`); on success hide the form and `loadPlans()`. `#planCancel` → hide form, write nothing.
5. `openPlan(id)` → `GET /api/admin/plans/:id`; render `#planDetail` with the plan summary, an **Edit** button (loads the form in edit mode), the available **lifecycle actions** (each posts `POST /:id/action {action}` after a confirm, then reloads), a **Change price** form (new price, applies-to `new`/`existing_and_new`, effective date prefilled to today+90 shown only for `existing_and_new`, reason) posting `POST /:id/price-change`, the **price-change history** list, a **Duplicate** button (`POST /:id/duplicate`), and a **Delete** button shown only when `deletion.deletable` (else show `deletion.reason`).
6. Reuse existing helpers already in `admin.js` (the fetch/JSON wrapper, table renderer, toast/msg helpers) — do not invent new ones; match how coupons does it.

Use the existing money formatter in `admin.js` for the price column. Keep all network calls through the file's existing API helper so auth headers/CSRF (if any) are consistent.

- [ ] **Step 4: Manual verification in the browser preview**

Start the app and drive the new tab:

1. Ensure `.claude/launch.json` has a dev-server entry (create if missing: `npm start`, port from `server/.env` — default per README). Then open the preview:
   - `preview_start` with the dev server name (or `{url}` at the running port).
2. Log in as the seeded admin (README documents the demo admin credentials).
3. Verify: the **Subscription Plans** tab appears; the table lists Weekly/Monthly/Quarterly/Bi-Annual/Annual with correct frequency + price + "Yes" availability + Active + a customer count.
4. Create a plan ("Biweekly", every 2 weeks, $15, draft) → it appears; Activate it via Manage → status flips to Active; make it customer-available.
5. Edit its price → change reflects. Schedule an `existing_and_new` price change → history row appears with the +90-day effective date.
6. Duplicate a plan → a `(Copy)` draft appears. Try Delete on a plan with customers → blocked with the reason; Delete the unused draft copy → removed.
7. Check `read_console_messages` and `preview_logs` for errors; fix any before committing.
8. Screenshot the plan list for the record (`computer` screenshot) and share it.

- [ ] **Step 5: Commit**

```bash
git add server/public/dashboard/admin/index.html server/public/dashboard/admin/admin.js
git commit -m "feat(admin-ui): Subscription Plans tab — list, create/edit, lifecycle, price changes"
```

---

## Task 10: Dynamic plan dropdowns (coupon/customer-filter compatibility)

**Files:**
- Modify: `server/public/dashboard/admin/index.html:63` (the hardcoded `#custPlan` `<option>` list) and `server/public/dashboard/admin/admin.js` (populate it dynamically)

**Interfaces:** consumes `/api/admin/plans`.

**Context:** Section 14 requires new plans to appear wherever plans are referenced, without hardcoding. The `#custPlan` filter currently hardcodes `Introductory/Monthly/Quarterly/Annual`. Populate it from the live plans instead. The `coupon_plans` eligibility system already works by plan id/code server-side and needs no data change.

- [ ] **Step 1: Replace the hardcoded options (`index.html`)**

Change line 63 to keep only the "All" default; options are filled in JS:

```html
        <div><label for="custPlan">Plan</label>
          <select id="custPlan"><option value="">All</option></select></div>
```

- [ ] **Step 2: Populate on load (`admin.js`)**

Where the customers section initializes (or in a shared init), fetch plans once and fill `#custPlan` (and any other plan `<select>` that lists plans for filtering) with `code`→`name` options, ordered by `displayOrder`. Example:

```js
async function fillPlanFilters() {
  const { plans } = await api('GET', '/api/admin/plans'); // reuse the file's api() helper
  const sel = document.getElementById('custPlan');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">All</option>' +
    plans.map(p => `<option value="${p.code}">${p.name}</option>`).join('');
  sel.value = current;
}
```

Call `fillPlanFilters()` during dashboard init (alongside the other initial loads). If the admin lacks `plans.view`, the endpoint 404s — guard by catching and leaving the default "All" only.

- [ ] **Step 3: Manual verification**

Reload the dashboard; the Customers → Plan filter lists all active plans (including the new Weekly/Bi-Annual). No console errors.

- [ ] **Step 4: Commit**

```bash
git add server/public/dashboard/admin/index.html server/public/dashboard/admin/admin.js
git commit -m "feat(admin-ui): populate plan filter dropdowns from configured plans"
```

---

## Task 11: Full-suite verification + demo-payment weekly-plan check

**Files:**
- Test: `server/test/demo-payment-weekly.test.js`

**Interfaces:** consumes `lib/signup.js` `enrol()`.

- [ ] **Step 1: Write the test**

Create `server/test/demo-payment-weekly.test.js`. Model it on the existing signup tests (`server/test/signup.test.js`) — same DB bootstrap and `enrol()` usage — but for a Weekly plan, asserting the subscription is created with the right locked price and a next-billing date one week out:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.PAYMENT_PROVIDER = 'demo';
const { migrate, one, run } = await import('../db/index.js');
const { migratePlans } = await import('../db/migrate_plans.js');
migrate(); migratePlans();
// A customer-available weekly plan.
run(`INSERT INTO plans (code,name,price_cents,interval_unit,interval_count,status,customer_available)
     VALUES ('Weekly','Weekly',800,'week',1,'active',1)`);

const { enrol } = await import('../lib/signup.js');

test('demo signup on a weekly plan locks $8 and bills one week out', async () => {
  const res = await enrol({
    plan: 'Weekly', firstName: 'Wk', lastName: 'Ly', email: 'wk@t.local',
    phone: '5550000', password: 'Sup3rSecret!', street: '1 A St', unit: '1',
    community: 'Testville', zip: '31900', startDate: '2026-03-01', outcome: 'success',
  });
  assert.equal(res.ok, true);
  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, res.subscriptionId);
  assert.equal(sub.locked_price_cents, 800);
  assert.equal(sub.status, 'active');
  assert.equal(sub.next_billing_date, '2026-03-08'); // one week after start
});
```

(If `signup.test.js` uses a different bootstrap — e.g. it calls `seed()` — mirror whatever it does; the key assertions are the locked price and `next_billing_date`.)

- [ ] **Step 2: Run it (expect PASS once Task 6 is in)**

Run: `node --test server/test/demo-payment-weekly.test.js`
Expected: PASS.

- [ ] **Step 3: Full suite**

Run: `npm test`
Expected: ALL tests pass (new + existing). Investigate and fix any regression before continuing — do not silence a failing test.

- [ ] **Step 4: Commit**

```bash
git add server/test/demo-payment-weekly.test.js
git commit -m "test(plans): demo payment on a weekly plan locks price + weekly billing date"
```

---

## Self-Review

**Spec coverage** (each design section → task):
- §1 data model / rebuild → Task 2 (+ retirement in Task 6).
- §2 price changes / grace → Tasks 2 (schema+setting), 3 (engine), 5 (route), 9 (UI).
- §3 lifecycle & no-delete-with-history → Tasks 3 (deletability), 4 (lifecycle), 5 (routes).
- §4 admin UI / table columns / page-state → Task 9.
- §5 permissions → Task 5.
- §6 customer selection (auth only) → Task 7.
- §7 demo payment compatibility → Task 11.
- §8 coupon compatibility / dynamic dropdowns → Task 10.
- §9 seed (Weekly + Bi-Annual + grace) → Tasks 2 (grace) + 8 (plans).
- Billing helpers underpinning all → Task 1.
- Tests 1–8 in the spec's Testing section → Tasks 1,2,4,3,3,7,(coupon: existing coverage + Task 10 manual),11 respectively.

**Placeholder scan:** no TBD/TODO; every code step shows real code; UI tasks (9,10) intentionally reference the existing Coupons section to copy patterns rather than restate ~1500 lines of `admin.js`, and give concrete IDs, endpoints, columns, and skeleton markup.

**Type/name consistency:** `migratePlans`, `applyDuePriceChanges`, `schedulePriceChange`, `createPlan/updatePlan/duplicatePlan/deletePlan/planDeletability/planCustomerCount`, `PLAN_LIFECYCLE/PLAN_STATUSES`, `frequencyLabel/perLabel/monthsEquivalent/addInterval/slugCode/INTERVAL_UNITS` are used identically across the tasks that define and consume them. Endpoint paths (`/api/admin/plans…`) and field names (`priceDollars`, `intervalUnit`, `intervalCount`, `customerAvailable`, `appliesTo`, `effectiveDate`) match between Task 5 (routes) and Task 9 (UI).

**Open follow-ups (non-blocking):** granting `plans.*` to non-admin roles is left to the existing Roles UI (admin already has all permissions); the public marketing wizard is intentionally out of scope per the spec.
