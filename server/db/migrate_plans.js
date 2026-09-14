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

/* ============================================================
   The advertised default plans. These are REAL, editable records — the
   single source of truth every customer-facing surface reads from — not
   frontend copy. The set matches what the marketing site shows: three
   selectable plans plus the inactive Introductory promotion row.

   [code, name, unit, count, price_cents, status, available, order, label, is_intro, description]
   ============================================================ */
export const DEFAULT_PLANS = [
  ['Monthly',      'Monthly',           'month', 1,  2800, 'active',   1, 1, null,         0, 'Pay one month at a time'],
  ['Quarterly',    'Quarterly',         'month', 3,  7400, 'active',   1, 2, 'Best Value', 0, 'Pay every 3 months'],
  ['Annual',       'Annual',            'year',  1, 27600, 'active',   1, 3, null,         0, 'Pay once for the year'],
  // A real record so the launch coupon and signup path can reference it,
  // but never selectable: the intro rate is a promotion on Monthly.
  ['Introductory', 'Introductory Rate', 'month', 1,  1800, 'inactive', 0, 4, null,         1, null],
];

/* ============================================================
   Guarantee the deployment has its plan records. Runs on every boot but
   only ever acts when the plans table is EMPTY, so:

     - a brand-new database that the fresh-install seed already populated
       is left untouched (the seed ran first), and
     - a database that predates the plans feature — users already exist,
       so the fresh-install seed no-ops and never seeds plans — is
       backfilled with the advertised set, which is exactly the Hostinger
       case where Admin -> Subscription Plans came up blank.

   Never overwrites or "resets" an existing plan: once any plan exists,
   the admin owns the table and this is a no-op, so an edited price is
   never clobbered on the next restart. Returns a list of change notes.
   ============================================================ */
export function ensureDefaultPlans() {
  if (one(`SELECT id FROM plans LIMIT 1`)) return [];   // admin owns the table

  const insert = db.prepare(`
    INSERT INTO plans (code, name, interval_unit, interval_count, price_cents,
                       status, customer_available, display_order, label, is_intro,
                       description, provider_plan_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'demo')`);
  db.exec('BEGIN');
  try {
    for (const [code, name, unit, count, cents, status, avail, order, label, intro, desc] of DEFAULT_PLANS) {
      insert.run(code, name, unit, count, cents, status, avail, order, label, intro, desc);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return [`seeded ${DEFAULT_PLANS.length} default subscription plans (empty plans table)`];
}
