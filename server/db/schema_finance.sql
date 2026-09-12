-- ============================================================
-- Dash Trash Pickup - payroll, expenses, profitability
--
-- Design rule carried over: financial figures are DERIVED from
-- transactions (payments, time entries, expenses), never stored
-- as totals that can drift out of sync with their sources.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- Employee compensation ----------
-- Historical: a new row supersedes the old one, so a rate change
-- never silently re-prices shifts that were already worked.
CREATE TABLE IF NOT EXISTS employee_compensation (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  pay_type       TEXT    NOT NULL CHECK (pay_type IN ('hourly','daily')),
  rate_cents     INTEGER NOT NULL CHECK (rate_cents >= 0),
  effective_date TEXT    NOT NULL DEFAULT (date('now')),
  end_date       TEXT,
  created_by     INTEGER REFERENCES users(id),
  note           TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comp_employee ON employee_compensation(employee_id, effective_date);

-- ---------- Time tracking ----------
CREATE TABLE IF NOT EXISTS time_entries (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  route_id       INTEGER REFERENCES routes(id) ON DELETE SET NULL,
  work_date      TEXT    NOT NULL,
  clock_in_at    TEXT    NOT NULL,
  clock_out_at   TEXT,
  break_minutes  INTEGER NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  clock_in_lat   REAL, clock_in_lng  REAL,
  clock_out_lat  REAL, clock_out_lng REAL,
  device         TEXT,
  source         TEXT NOT NULL DEFAULT 'employee' CHECK (source IN ('employee','admin')),
  -- Snapshot of the rate in force at clock-in. Payroll must not change
  -- retroactively when an admin edits the employee's rate later.
  pay_type_snapshot   TEXT,
  rate_cents_snapshot INTEGER,
  edited_by      INTEGER REFERENCES users(id),
  edit_reason    TEXT,
  note           TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_time_employee ON time_entries(employee_id, work_date);
CREATE INDEX IF NOT EXISTS idx_time_date ON time_entries(work_date);
CREATE INDEX IF NOT EXISTS idx_time_route ON time_entries(route_id, work_date);
-- An employee may only have one shift open at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_time_open_shift
  ON time_entries(employee_id) WHERE clock_out_at IS NULL;

-- ---------- Pay periods ----------
CREATE TABLE IF NOT EXISTS pay_periods (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date TEXT NOT NULL,
  end_date   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','paid')),
  closed_at  TEXT,
  closed_by  INTEGER REFERENCES users(id),
  UNIQUE (start_date, end_date)
);

-- ---------- Expenses ----------
CREATE TABLE IF NOT EXISTS expense_categories (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  code     TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  -- is_labor marks the category that payroll writes into, so labor is
  -- never double-counted alongside derived payroll.
  is_labor INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS expenses (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id  INTEGER NOT NULL REFERENCES expense_categories(id),
  description  TEXT    NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  incurred_on  TEXT    NOT NULL,
  vendor       TEXT,
  -- Direct costs can be attributed to a route or community; anything
  -- left NULL is overhead and gets allocated in the profitability math.
  route_id     INTEGER REFERENCES routes(id) ON DELETE SET NULL,
  community_id INTEGER REFERENCES communities(id) ON DELETE SET NULL,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  recurrence   TEXT CHECK (recurrence IN ('monthly','quarterly','annual','weekly')),
  receipt_key  TEXT,           -- storage key, same adapter as pickup photos
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(incurred_on);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id, incurred_on);
CREATE INDEX IF NOT EXISTS idx_expenses_route ON expenses(route_id);
CREATE INDEX IF NOT EXISTS idx_expenses_community ON expenses(community_id);

-- ---------- Seed categories ----------
INSERT OR IGNORE INTO expense_categories (code, name, is_labor, sort_order) VALUES
  ('labor',        'Employee labor',        1,  1),
  ('fuel',         'Fuel',                  0,  2),
  ('vehicle_pmt',  'Vehicle payments',      0,  3),
  ('vehicle_maint','Vehicle maintenance',   0,  4),
  ('vehicle_ins',  'Vehicle insurance',     0,  5),
  ('business_ins', 'Business insurance',    0,  6),
  ('supplies',     'Trash bags / supplies', 0,  7),
  ('uniforms',     'Uniforms',              0,  8),
  ('equipment',    'Equipment',             0,  9),
  ('software',     'Software subscriptions',0, 10),
  ('hosting',      'Website / hosting',     0, 11),
  ('marketing',    'Advertising / marketing',0,12),
  ('processing',   'Payment processing fees',0,13),
  ('office',       'Office expenses',       0, 14),
  ('contractor',   'Contractor expenses',   0, 15),
  ('licensing',    'Licensing / permits',   0, 16),
  ('misc',         'Miscellaneous',         0, 17);
