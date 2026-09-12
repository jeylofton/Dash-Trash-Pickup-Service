-- ============================================================
-- Custom roles, granular permissions, route versioning
--
-- GOVERNING RULE: current and future information is editable;
-- historical records keep the values that were true when the work
-- happened. Nothing operational is ever hard-deleted.
-- ============================================================

PRAGMA foreign_keys = ON;

/* ---------- The permission catalog ---------- */
CREATE TABLE IF NOT EXISTS permissions (
  key        TEXT PRIMARY KEY,
  category   TEXT NOT NULL,
  label      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

/* ---------- Roles ---------- */
CREATE TABLE IF NOT EXISTS roles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name        TEXT NOT NULL,
  description TEXT,
  -- System roles cannot be archived or renamed; admin cannot be edited at all.
  is_system   INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','inactive','archived')),
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Future-ready: a user may hold more than one role. The first version
   still uses users.role as the primary, but this table is what a
   multi-role feature would read. */
CREATE TABLE IF NOT EXISTS user_roles (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_key    TEXT    NOT NULL REFERENCES roles(key) ON DELETE CASCADE,
  is_primary  INTEGER NOT NULL DEFAULT 0,
  assigned_by INTEGER REFERENCES users(id),
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, role_key)
);

/* ---------- Route versions ----------
   A route's configuration is versioned by effective date. Service
   records reference the route; the version in force on a given date
   is what says who drove it and when it started. Editing today's
   configuration therefore cannot rewrite last month. */
CREATE TABLE IF NOT EXISTS route_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id       INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  name           TEXT,
  description    TEXT,
  day_of_week    INTEGER CHECK (day_of_week BETWEEN 0 AND 6),
  start_time     TEXT,
  estimated_end_time TEXT,
  service_area   TEXT,
  status         TEXT,
  driver_employee_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,
  notes          TEXT,
  effective_date TEXT NOT NULL,
  end_date       TEXT,
  changed_by     INTEGER REFERENCES users(id),
  change_note    TEXT,
  changes        TEXT,        -- JSON: { field: {from, to} }
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_route_versions ON route_versions(route_id, effective_date);

/* Additional employees on a route beyond the primary driver. */
CREATE TABLE IF NOT EXISTS route_crew (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id       INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_date TEXT NOT NULL DEFAULT (date('now')),
  end_date       TEXT,
  assigned_by    INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_route_crew ON route_crew(route_id, end_date);

/* ---------- Permission catalog ---------- */
INSERT OR IGNORE INTO permissions (key, category, label, sort_order) VALUES
  ('customers.view','Customers','View customers',1),
  ('customers.create','Customers','Add customers',2),
  ('customers.edit','Customers','Edit customers',3),
  ('customers.archive','Customers','Archive customers',4),
  ('customers.billing.view','Customers','View customer billing',5),
  ('customers.plan.change','Customers','Change customer plans',6),

  ('communities.view','Communities','View communities',10),
  ('communities.create','Communities','Add communities',11),
  ('communities.edit','Communities','Edit communities',12),
  ('communities.archive','Communities','Archive communities',13),
  ('communities.schedule.edit','Communities','Change service days',14),
  ('communities.pricing.edit','Communities','Change community pricing',15),
  ('communities.driver.assign','Communities','Assign drivers',16),

  ('routes.view','Routes','View routes',20),
  ('routes.create','Routes','Create routes',21),
  ('routes.edit','Routes','Edit routes',22),
  ('routes.driver.assign','Routes','Assign drivers',23),
  ('routes.crew.assign','Routes','Assign additional employees',24),
  ('routes.communities.edit','Routes','Add communities to routes',25),
  ('routes.schedule.edit','Routes','Change route schedule',26),
  ('routes.archive','Routes','Archive routes',27),

  ('employees.view','Employees','View employees',30),
  ('employees.create','Employees','Add employees',31),
  ('employees.edit','Employees','Edit employees',32),
  ('employees.pay.rate','Employees','Change pay rate',33),
  ('employees.pay.type','Employees','Change pay type',34),
  ('employees.roles.assign','Employees','Assign roles',35),
  ('employees.archive','Employees','Archive employees',36),
  ('employees.password.reset','Employees','Reset employee password',37),

  ('time.view','Time tracking','View employee time',40),
  ('time.edit','Time tracking','Edit time records',41),
  ('time.approve','Time tracking','Approve time corrections',42),

  ('payroll.pay.view','Payroll','View estimated pay',50),
  ('payroll.labor.view','Payroll','View labor cost',51),
  ('payroll.compensation.edit','Payroll','Edit employee compensation',52),

  ('financials.revenue.view','Financials','View revenue',60),
  ('financials.expenses.view','Financials','View expenses',61),
  ('financials.expenses.create','Financials','Add expenses',62),
  ('financials.expenses.edit','Financials','Edit expenses',63),
  ('financials.profit.view','Financials','View profit',64),
  ('financials.reports.view','Financials','View profitability reports',65),

  ('coupons.view','Coupons','View coupons',70),
  ('coupons.create','Coupons','Create coupons',71),
  ('coupons.edit','Coupons','Edit coupons',72),
  ('coupons.disable','Coupons','Disable coupons',73),
  ('coupons.analytics.view','Coupons','View coupon analytics',74),

  ('credits.issue','Service credits','Issue service credit',80),
  ('credits.approve','Service credits','Approve credits over the limit',81),
  ('credits.reject','Service credits','Reject credits',82),
  ('credits.reports.view','Service credits','View credit reports',83),

  ('pickups.view','Pickups','View pickup records',90),
  ('pickups.photos.view','Pickups','View photos',91),
  ('pickups.edit','Pickups','Edit pickup records',92),
  ('pickups.issues.review','Pickups','Review service issues',93),

  ('reports.view','Reports','View reports',100),
  ('reports.export','Reports','Export reports',101),

  ('system.users.manage','System','Manage users',110),
  ('system.roles.manage','System','Manage roles',111),
  ('system.permissions.manage','System','Manage permissions',112),
  ('system.passwords.reset','System','Reset passwords',113),
  ('system.audit.view','System','View audit logs',114),
  ('system.settings.manage','System','Manage settings',115);

/* ---------- Default roles ---------- */
INSERT OR IGNORE INTO roles (key, name, description, is_system) VALUES
  ('admin','Admin','Full system access.',1),
  ('manager','Manager','Operational management access.',1),
  ('employee','Employee','Assigned routes, pickups, photos, time clock, limited service credits.',1),
  ('customer','Customer','Their own account only.',1);
