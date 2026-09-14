/* SQLite connection. node:sqlite is built into Node 22+, so there is
   no native module to compile and nothing to install. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = process.env.DB_PATH || join(DATA_DIR, 'dash.db');
export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA journal_mode = WAL');   // concurrent reads while writing
db.exec('PRAGMA busy_timeout = 5000');

export function migrate() {
  db.exec(readFileSync(join(HERE, 'schema.sql'), 'utf8'));
  db.exec(readFileSync(join(HERE, 'schema_finance.sql'), 'utf8'));
  db.exec(readFileSync(join(HERE, 'schema_admin.sql'), 'utf8'));
  db.exec(readFileSync(join(HERE, 'schema_discounts.sql'), 'utf8'));
  db.exec(readFileSync(join(HERE, 'schema_communities.sql'), 'utf8'));
  db.exec(readFileSync(join(HERE, 'schema_roles.sql'), 'utf8'));
  db.exec(readFileSync(join(HERE, 'schema_payments.sql'), 'utf8'));
  db.exec(readFileSync(join(HERE, 'schema_branding.sql'), 'utf8'));

  // Add promotional-term columns, guarded for idempotency
  const addColumn = (table, column, decl) => {
    const has = db.prepare(`PRAGMA table_info(${table})`).all()
                  .some(c => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  };

  // The promotional price and how many billing periods it still covers.
  // Copied from the coupon at signup and frozen, exactly like
  // locked_price_cents - so editing the coupon later cannot re-price
  // a customer who already enrolled.
  addColumn('subscriptions', 'promo_price_cents', 'INTEGER');
  addColumn('subscriptions', 'promo_periods_remaining', 'INTEGER');

  // Lets a discount say "for N billing periods". NULL means forever.
  addColumn('coupons', 'duration_periods', 'INTEGER');

  // The introductory rate is a promotion on the Monthly plan, not a plan
  // of its own (see server/lib/signup.js). Deactivate the old
  // `Introductory` plans row so it can never be selected as a billable
  // plan again — do NOT delete it, existing subscriptions reference it
  // by foreign key and their history must stay readable. Naturally
  // idempotent (a no-op once already inactive), guarded the same way as
  // addColumn() so repeated boots never do redundant writes.
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
}

/* Practice / sandbox isolation flags. Rows created for the training accounts
   are flagged is_demo = 1 so the owner's dashboards and reports exclude them
   (a true blank slate), while the practice accounts still see their own data.
   Every real row defaults to 0.

   This MUST run AFTER the admin migrations: migrate_admin rebuilds the users,
   employees, and communities tables, which would drop columns added earlier.
   Idempotent, so both the server boot and the seed script call it. */
export function migrateDemoFlags() {
  const addColumn = (table, column, decl) => {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  };
  for (const t of ['users', 'customers', 'employees', 'communities', 'units',
    'routes', 'route_stops', 'route_assignments', 'service_stops', 'subscriptions',
    'payments', 'pickup_records', 'pickup_photos', 'time_entries', 'service_credits']) {
    addColumn(t, 'is_demo', 'INTEGER NOT NULL DEFAULT 0');
  }
}

/* Small helpers so route code reads cleanly. */
export const one  = (sql, ...p) => db.prepare(sql).get(...p);
export const all  = (sql, ...p) => db.prepare(sql).all(...p);
export const run  = (sql, ...p) => db.prepare(sql).run(...p);

/** Run fn inside a transaction; rolls back on throw. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
