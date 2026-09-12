/* ============================================================
   Migrations that plain SQL cannot express.

   SQLite has no ALTER TABLE ... DROP/MODIFY CONSTRAINT, so widening
   a CHECK means rebuilding the table. Each step below is guarded so
   running it repeatedly is safe.
   ============================================================ */

import { db, one, all } from './index.js';

const columns = (table) => all(`PRAGMA table_info(${table})`).map(c => c.name);

function addColumn(table, name, definition) {
  if (columns(table).includes(name)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  return true;
}

export function migrateAdmin() {
  const changes = [];

  /* --- users: password + lock state --- */
  if (addColumn('users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0')) changes.push('users.must_change_password');
  if (addColumn('users', 'locked_until', 'TEXT')) changes.push('users.locked_until');
  if (addColumn('users', 'password_changed_at', 'TEXT')) changes.push('users.password_changed_at');

  /* --- employees: widen the status CHECK --- */
  const ddl = one(`SELECT sql FROM sqlite_master WHERE type='table' AND name='employees'`)?.sql || '';
  if (!ddl.includes('terminated')) {
    // Rebuild. Foreign keys are disabled for the swap so child rows
    // (time entries, route assignments) survive the drop/rename.
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      db.exec(`
        CREATE TABLE employees_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
          employee_code TEXT    UNIQUE,
          hire_date     TEXT,
          status        TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','inactive','on_leave','terminated','archived')),
          end_date      TEXT,
          created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        )`);
      db.exec(`INSERT INTO employees_new (id, user_id, employee_code, hire_date, status, created_at)
               SELECT id, user_id, employee_code, hire_date, status, created_at FROM employees`);
      db.exec('DROP TABLE employees');
      db.exec('ALTER TABLE employees_new RENAME TO employees');
      db.exec('COMMIT');
      changes.push('employees.status widened (on_leave, terminated, archived)');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /* --- users.role: add 'manager' --- */
  const userDdl = one(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`)?.sql || '';
  if (!userDdl.includes("'manager'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      const cols = columns('users');
      db.exec(`
        CREATE TABLE users_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
          password_hash TEXT    NOT NULL,
          role          TEXT    NOT NULL CHECK (role IN ('admin','manager','employee','customer')),
          first_name    TEXT    NOT NULL,
          last_name     TEXT    NOT NULL,
          phone         TEXT,
          status        TEXT    NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','suspended','deactivated')),
          created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
          last_login_at TEXT,
          must_change_password INTEGER NOT NULL DEFAULT 0,
          locked_until  TEXT,
          password_changed_at  TEXT
        )`);
      const shared = ['id','email','password_hash','role','first_name','last_name','phone',
                      'status','created_at','last_login_at','must_change_password',
                      'locked_until','password_changed_at'].filter(c => cols.includes(c));
      db.exec(`INSERT INTO users_new (${shared.join(',')}) SELECT ${shared.join(',')} FROM users`);
      db.exec('DROP TABLE users');
      db.exec('ALTER TABLE users_new RENAME TO users');
      db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, status)');
      db.exec('COMMIT');
      changes.push("users.role widened (manager added)");
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  /* --- default manager permissions ---
     Deliberately NOT financials, payroll, or account administration:
     a Manager runs operations, an Admin runs the business. */
  const MANAGER_DEFAULTS = [
    ['customers.view', 1], ['customers.manage', 1],
    ['employees.view', 1], ['employees.manage', 0],
    ['routes.manage', 1], ['pickups.view', 1],
    ['coupons.manage', 1], ['credits.approve', 1],
    ['reports.view', 1],
    ['financials.view', 0], ['payroll.view', 0], ['accounts.manage', 0],
  ];
  const existing = new Set(all(`SELECT permission FROM role_permissions WHERE role='manager'`)
    .map(r => r.permission));
  let seeded = 0;
  for (const [perm, allowed] of MANAGER_DEFAULTS) {
    if (existing.has(perm)) continue;
    db.prepare(`INSERT INTO role_permissions (role, permission, allowed) VALUES ('manager', ?, ?)`)
      .run(perm, allowed);
    seeded++;
  }
  if (seeded) changes.push(`${seeded} manager permission default(s) seeded`);

  /* --- a profile row for every existing employee --- */
  const missing = all(`SELECT e.id FROM employees e
                        LEFT JOIN employee_profiles p ON p.employee_id = e.id
                       WHERE p.employee_id IS NULL`);
  for (const m of missing) {
    db.prepare('INSERT INTO employee_profiles (employee_id) VALUES (?)').run(m.id);
  }
  if (missing.length) changes.push(`${missing.length} employee profile row(s) created`);

  return changes;
}

/* ============================================================
   Community lifecycle migration (called from migrateAdmin above
   via migrateCommunities, kept separate for readability).
   ============================================================ */
export function migrateCommunities() {
  const changes = [];

  const ddl = one(`SELECT sql FROM sqlite_master WHERE type='table' AND name='communities'`)?.sql || '';
  if (!ddl.includes('waiting_list')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      const cols = columns('communities');
      db.exec(`
        CREATE TABLE communities_new (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          name      TEXT    NOT NULL,
          kind      TEXT    NOT NULL DEFAULT 'apartment'
                      CHECK (kind IN ('apartment','townhome','neighborhood','other')),
          street    TEXT, city TEXT DEFAULT 'Columbus', state TEXT DEFAULT 'GA', zip TEXT,
          contact_name TEXT, contact_email TEXT, contact_phone TEXT,
          notes     TEXT,
          -- Lifecycle. 'active' is the only status that produces service.
          status    TEXT    NOT NULL DEFAULT 'lead' CHECK (status IN
                      ('lead','waiting_list','driver_needed','pending_setup',
                       'scheduled','active','paused','inactive')),
          waiting_reason      TEXT,
          unit_count_estimate INTEGER,
          potential_customers INTEGER,
          tentative_start_date TEXT,
          actual_start_date    TEXT,
          created_at TEXT   NOT NULL DEFAULT (datetime('now'))
        )`);
      const shared = ['id','name','kind','street','city','state','zip','contact_name',
                      'contact_email','contact_phone','notes','created_at']
                      .filter(c => cols.includes(c));
      db.exec(`INSERT INTO communities_new (${shared.join(',')}) SELECT ${shared.join(',')} FROM communities`);
      // Everything that was already being serviced stays serviced.
      db.exec(`UPDATE communities_new SET status = 'active', actual_start_date = date(created_at)
                WHERE id IN (SELECT id FROM communities WHERE status = 'active')`);
      db.exec('DROP TABLE communities');
      db.exec('ALTER TABLE communities_new RENAME TO communities');
      db.exec('COMMIT');
      changes.push('communities.status widened (lead, waiting_list, driver_needed, ...)');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }
  return changes;
}

/** Widen pickup_records.issue_code for the expanded issue list. */
export function migrateIssueCodes() {
  const ddl = one(`SELECT sql FROM sqlite_master WHERE type='table' AND name='pickup_records'`)?.sql || '';
  if (ddl.includes('animal_safety')) return [];

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    const cols = columns('pickup_records');
    db.exec(`
      CREATE TABLE pickup_records_new (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        service_stop_id INTEGER REFERENCES service_stops(id) ON DELETE SET NULL,
        service_date    TEXT    NOT NULL,
        unit_id         INTEGER NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
        customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
        employee_id     INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        route_id        INTEGER REFERENCES routes(id) ON DELETE SET NULL,
        status          TEXT    NOT NULL CHECK (status IN ('completed','issue')),
        issue_code      TEXT    CHECK (issue_code IN (
                          'no_trash_outside','unable_to_access','not_properly_bagged',
                          'oversized_item','restricted_item','customer_not_home',
                          'incorrect_address','blocked_access','animal_safety',
                          'property_issue','service_problem','customer_not_found','other')),
        notes           TEXT,
        completed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
        gps_lat         REAL, gps_lng REAL,
        created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
      )`);
    const shared = ['id','service_stop_id','service_date','unit_id','customer_id','employee_id',
                    'route_id','status','issue_code','notes','completed_at','gps_lat','gps_lng',
                    'created_at'].filter(c => cols.includes(c));
    db.exec(`INSERT INTO pickup_records_new (${shared.join(',')}) SELECT ${shared.join(',')} FROM pickup_records`);
    db.exec('DROP TABLE pickup_records');
    db.exec('ALTER TABLE pickup_records_new RENAME TO pickup_records');
    for (const idx of [
      'CREATE INDEX IF NOT EXISTS idx_records_unit ON pickup_records(unit_id, service_date)',
      'CREATE INDEX IF NOT EXISTS idx_records_customer ON pickup_records(customer_id, service_date)',
      'CREATE INDEX IF NOT EXISTS idx_records_employee ON pickup_records(employee_id, service_date)',
      'CREATE INDEX IF NOT EXISTS idx_records_date ON pickup_records(service_date, status)',
    ]) db.exec(idx);
    db.exec('COMMIT');
    return ['pickup_records.issue_code widened (13 issue types)'];
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
