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
