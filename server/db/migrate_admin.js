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
  /* Only run while the OLD fixed CHECK is still present. A later migration
     removes that CHECK entirely for custom roles; without this guard this
     step would try to re-impose it and fail on any custom role key. */
  const hasFixedRoleCheck = /CHECK\s*\(\s*role\s+IN/i.test(userDdl);
  if (hasFixedRoleCheck && !userDdl.includes("'manager'")) {
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
  /* This seeded the ORIGINAL coarse permissions against a `role` column.
     migrateAdminControls later renames that column to `role_key` and seeds
     the granular set, so run this only on a database still using the old
     shape — otherwise it would fail on a column that no longer exists. */
  if (columns('role_permissions').includes('role')) {
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
  }

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

/* ============================================================
   Routes, communities, and role migration for the admin-control
   phase. Each step is guarded so re-running is safe.
   ============================================================ */
export function migrateAdminControls() {
  const changes = [];

  /* --- routes: description, times, service area, widened status --- */
  const routeDdl = one(`SELECT sql FROM sqlite_master WHERE type='table' AND name='routes'`)?.sql || '';
  if (!routeDdl.includes('archived')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      const cols = columns('routes');
      db.exec(`
        CREATE TABLE routes_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          name           TEXT    NOT NULL,
          description    TEXT,
          day_of_week    INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
          start_time     TEXT,
          estimated_end_time TEXT,
          service_area   TEXT,
          status         TEXT    NOT NULL DEFAULT 'active' CHECK (status IN
                           ('draft','scheduled','active','on_hold','inactive','archived')),
          effective_date TEXT,
          notes          TEXT,
          created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
        )`);
      const shared = ['id','name','day_of_week','status','notes','created_at'].filter(c => cols.includes(c));
      db.exec(`INSERT INTO routes_new (${shared.join(',')}) SELECT ${shared.join(',')} FROM routes`);
      db.exec(`UPDATE routes_new SET status='active' WHERE status NOT IN
                 ('draft','scheduled','active','on_hold','inactive','archived')`);
      db.exec('DROP TABLE routes');
      db.exec('ALTER TABLE routes_new RENAME TO routes');
      db.exec('COMMIT');
      changes.push('routes: description, start/end time, service area, status widened');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    finally { db.exec('PRAGMA foreign_keys = ON'); }
  }

  /* --- communities: on_hold + archived --- */
  const commDdl = one(`SELECT sql FROM sqlite_master WHERE type='table' AND name='communities'`)?.sql || '';
  if (!commDdl.includes('archived')) {
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec('BEGIN');
    try {
      const cols = columns('communities');
      db.exec(`
        CREATE TABLE communities_new2 (
          id        INTEGER PRIMARY KEY AUTOINCREMENT,
          name      TEXT    NOT NULL,
          kind      TEXT    NOT NULL DEFAULT 'apartment'
                      CHECK (kind IN ('apartment','townhome','neighborhood','other')),
          street    TEXT, city TEXT DEFAULT 'Columbus', state TEXT DEFAULT 'GA', zip TEXT,
          contact_name TEXT, contact_email TEXT, contact_phone TEXT,
          notes     TEXT,
          status    TEXT    NOT NULL DEFAULT 'lead' CHECK (status IN
                      ('lead','waiting_list','driver_needed','pending_setup',
                       'scheduled','active','on_hold','paused','inactive','archived')),
          waiting_reason      TEXT,
          unit_count_estimate INTEGER,
          potential_customers INTEGER,
          tentative_start_date TEXT,
          actual_start_date    TEXT,
          service_start_time   TEXT,
          service_instructions TEXT,
          access_instructions  TEXT,
          pricing_note         TEXT,
          archived_at          TEXT,
          created_at TEXT   NOT NULL DEFAULT (datetime('now'))
        )`);
      const shared = ['id','name','kind','street','city','state','zip','contact_name','contact_email',
                      'contact_phone','notes','status','waiting_reason','unit_count_estimate',
                      'potential_customers','tentative_start_date','actual_start_date','created_at']
                      .filter(c => cols.includes(c));
      db.exec(`INSERT INTO communities_new2 (${shared.join(',')}) SELECT ${shared.join(',')} FROM communities`);
      db.exec('DROP TABLE communities');
      db.exec('ALTER TABLE communities_new2 RENAME TO communities');
      db.exec('COMMIT');
      changes.push('communities: on_hold + archived, service/access instructions, start time');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    finally { db.exec('PRAGMA foreign_keys = ON'); }
  }

  /* --- pickup_schedules: effective dating, so changing service days
         does not rewrite the schedule that applied last month --- */
  if (addColumn('pickup_schedules', 'effective_date', "TEXT NOT NULL DEFAULT '2000-01-01'"))
    changes.push('pickup_schedules.effective_date');
  if (addColumn('pickup_schedules', 'end_date', 'TEXT'))
    changes.push('pickup_schedules.end_date');

  /* --- role_permissions: move from a bare role string to roles.key --- */
  if (!columns('role_permissions').includes('role_key')) {
    db.exec('BEGIN');
    try {
      db.exec(`CREATE TABLE role_permissions_new (
                 role_key   TEXT NOT NULL,
                 permission TEXT NOT NULL,
                 allowed    INTEGER NOT NULL DEFAULT 1,
                 PRIMARY KEY (role_key, permission))`);
      db.exec(`INSERT OR IGNORE INTO role_permissions_new (role_key, permission, allowed)
               SELECT role, permission, allowed FROM role_permissions`);
      db.exec('DROP TABLE role_permissions');
      db.exec('ALTER TABLE role_permissions_new RENAME TO role_permissions');
      db.exec('COMMIT');
      changes.push('role_permissions keyed by role');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  }

  /* --- seed the granular defaults for the built-in roles --- */
  const grant = (roleKey, perms) => {
    let n = 0;
    for (const p of perms) {
      const r = db.prepare(`INSERT OR IGNORE INTO role_permissions (role_key, permission, allowed)
                            VALUES (?, ?, 1)`).run(roleKey, p);
      n += r.changes;
    }
    return n;
  };

  const MANAGER = [
    'customers.view','customers.create','customers.edit','customers.billing.view',
    'communities.view','communities.create','communities.edit','communities.schedule.edit',
    'communities.driver.assign',
    'routes.view','routes.create','routes.edit','routes.driver.assign','routes.crew.assign',
    'routes.communities.edit','routes.schedule.edit',
    'employees.view','time.view','time.edit',
    'coupons.view','coupons.create','coupons.edit','coupons.disable','coupons.analytics.view',
    'credits.issue','credits.approve','credits.reject','credits.reports.view',
    'pickups.view','pickups.photos.view','pickups.issues.review',
    'reports.view',
  ];
  const EMPLOYEE = ['pickups.view','pickups.photos.view','credits.issue'];

  const m = grant('manager', MANAGER);
  const e = grant('employee', EMPLOYEE);
  if (m || e) changes.push(`${m + e} granular permission default(s) seeded`);

  /* --- mirror users.role into user_roles (future multi-role support) --- */
  const missing = all(`SELECT u.id, u.role FROM users u
                        LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.role_key = u.role
                       WHERE ur.user_id IS NULL`);
  for (const u of missing) {
    db.prepare(`INSERT OR IGNORE INTO user_roles (user_id, role_key, is_primary)
                VALUES (?, ?, 1)`).run(u.id, u.role);
  }
  if (missing.length) changes.push(`${missing.length} user role link(s) created`);

  /* --- an opening version for every existing route --- */
  const noVersion = all(`SELECT r.* FROM routes r
                          LEFT JOIN route_versions v ON v.route_id = r.id
                         WHERE v.id IS NULL`);
  for (const r of noVersion) {
    const driver = one(`SELECT employee_id FROM route_assignments
                         WHERE route_id = ? AND end_date IS NULL`, r.id);
    db.prepare(`INSERT INTO route_versions
                  (route_id, name, day_of_week, start_time, status, driver_employee_id,
                   effective_date, change_note)
                VALUES (?, ?, ?, ?, ?, ?, date(?), 'Initial configuration')`)
      .run(r.id, r.name, r.day_of_week, r.start_time ?? null, r.status,
           driver?.employee_id ?? null, r.created_at);
  }
  if (noVersion.length) changes.push(`${noVersion.length} initial route version(s) recorded`);

  return changes;
}


/** Remove the fixed users.role CHECK — roles are rows now, not constants. */
export function migrateDynamicRoles() {
  const ddl = one(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`)?.sql || '';
  if (!ddl.includes("CHECK (role IN")) return [];

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(`
      CREATE TABLE users_dyn (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT    NOT NULL,
        -- No CHECK: valid roles live in the roles table and are validated
        -- in application code, so custom roles are possible.
        role          TEXT    NOT NULL,
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
    const cols = ['id','email','password_hash','role','first_name','last_name','phone','status',
                  'created_at','last_login_at','must_change_password','locked_until',
                  'password_changed_at'].filter(c => columns('users').includes(c));
    db.exec(`INSERT INTO users_dyn (${cols.join(',')}) SELECT ${cols.join(',')} FROM users`);
    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_dyn RENAME TO users');
    db.exec('CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, status)');
    db.exec('COMMIT');
    return ['users.role CHECK removed (custom roles allowed)'];
  } catch (err) { db.exec('ROLLBACK'); throw err; }
  finally { db.exec('PRAGMA foreign_keys = ON'); }
}
