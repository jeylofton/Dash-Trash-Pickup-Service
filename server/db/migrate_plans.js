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
