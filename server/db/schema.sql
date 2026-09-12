-- ============================================================
-- Dash Trash Pickup - operational database
--
-- Design rules followed here:
--   * One fact lives in one place. Prices live on plans; a
--     subscription stores only the price it LOCKED IN.
--   * A "unit" is any serviceable location: an apartment, a
--     townhouse, or a standalone house. Communities and
--     buildings are optional groupings above it.
--   * Nothing is ever hard-deleted that a service history or an
--     audit trail points at - rows are deactivated instead.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ---------- Identity ----------

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN ('admin','employee','customer')),
  first_name    TEXT    NOT NULL,
  last_name     TEXT    NOT NULL,
  phone         TEXT,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deactivated')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role, status);

-- Server-side sessions. Only a HASH of the token is stored, so a
-- database leak does not hand out working sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,
  expires_at TEXT    NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- ---------- People ----------

CREATE TABLE IF NOT EXISTS employees (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  employee_code TEXT    UNIQUE,
  hire_date     TEXT,
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id             INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  provider            TEXT,            -- 'square' | 'stripe'
  provider_customer_id TEXT,
  is_intro            INTEGER NOT NULL DEFAULT 0,  -- got one of the first 100 spots
  status              TEXT    NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','paused','cancelled','deactivated')),
  created_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_customers_status ON customers(status);

-- ---------- Locations ----------

CREATE TABLE IF NOT EXISTS communities (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT    NOT NULL,
  kind      TEXT    NOT NULL DEFAULT 'apartment'
              CHECK (kind IN ('apartment','townhome','neighborhood','other')),
  street    TEXT, city TEXT DEFAULT 'Columbus', state TEXT DEFAULT 'GA', zip TEXT,
  contact_name TEXT, contact_email TEXT, contact_phone TEXT,
  notes     TEXT,
  status    TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at TEXT   NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS buildings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name         TEXT    NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_buildings_community ON buildings(community_id);

-- The serviceable location. An apartment unit, a townhouse, or a
-- standalone house (community_id NULL, street filled in).
CREATE TABLE IF NOT EXISTS units (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  building_id  INTEGER REFERENCES buildings(id)  ON DELETE SET NULL,
  label        TEXT    NOT NULL,       -- "Unit 412" / "1823 Oak St"
  street       TEXT, city TEXT DEFAULT 'Columbus', state TEXT DEFAULT 'GA', zip TEXT,
  notes        TEXT,
  status       TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (community_id IS NOT NULL OR street IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_units_community ON units(community_id, status);
CREATE INDEX IF NOT EXISTS idx_units_building ON units(building_id);

-- Which customer currently occupies which unit. History is kept by
-- ending a row rather than deleting it.
CREATE TABLE IF NOT EXISTS service_addresses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  unit_id     INTEGER NOT NULL REFERENCES units(id)     ON DELETE RESTRICT,
  start_date  TEXT    NOT NULL DEFAULT (date('now')),
  end_date    TEXT,
  is_primary  INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_service_addr_customer ON service_addresses(customer_id);
CREATE INDEX IF NOT EXISTS idx_service_addr_unit ON service_addresses(unit_id, end_date);

-- ---------- Billing ----------

CREATE TABLE IF NOT EXISTS plans (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT    NOT NULL UNIQUE,  -- Introductory | Monthly | Quarterly | Annual
  name            TEXT    NOT NULL,
  interval_months INTEGER NOT NULL,
  price_cents     INTEGER NOT NULL,
  is_intro        INTEGER NOT NULL DEFAULT 0,
  provider_plan_id TEXT,                    -- Square plan variation id
  active          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id        INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  plan_id            INTEGER NOT NULL REFERENCES plans(id),
  -- The price this customer actually pays. Copied at signup so that
  -- editing plans.price_cents later NEVER re-prices an existing
  -- customer - this is what protects the introductory rate.
  locked_price_cents INTEGER NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','past_due','paused','cancelled','pending')),
  provider           TEXT,
  provider_subscription_id TEXT,
  started_at         TEXT    NOT NULL DEFAULT (date('now')),
  next_billing_date  TEXT,
  cancelled_at       TEXT,
  cancel_reason      TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subs_customer ON subscriptions(customer_id, status);

CREATE TABLE IF NOT EXISTS payments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id        INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  subscription_id    INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  amount_cents       INTEGER NOT NULL,
  status             TEXT    NOT NULL
                       CHECK (status IN ('paid','pending','past_due','failed','refunded','cancelled')),
  provider           TEXT,
  provider_payment_id TEXT,
  failure_reason     TEXT,
  paid_at            TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payments_customer ON payments(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);

-- ---------- Scheduling and routes ----------

-- Pickup days are configurable per community or per unit, never
-- hard-coded. 0 = Sunday ... 6 = Saturday.
CREATE TABLE IF NOT EXISTS pickup_schedules (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  unit_id      INTEGER REFERENCES units(id)       ON DELETE CASCADE,
  day_of_week  INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  active       INTEGER NOT NULL DEFAULT 1,
  CHECK (community_id IS NOT NULL OR unit_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_sched_community ON pickup_schedules(community_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_sched_unit ON pickup_schedules(unit_id, day_of_week);

CREATE TABLE IF NOT EXISTS routes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes       TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A stop is a whole community, or a single standalone unit.
CREATE TABLE IF NOT EXISTS route_stops (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id     INTEGER NOT NULL REFERENCES routes(id) ON DELETE CASCADE,
  community_id INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  unit_id      INTEGER REFERENCES units(id)       ON DELETE CASCADE,
  sort_order   INTEGER NOT NULL DEFAULT 0,        -- drag-to-reorder writes here
  CHECK (community_id IS NOT NULL OR unit_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_route_stops ON route_stops(route_id, sort_order);

-- Who is running a route. A new row with effective_date is how a
-- route gets reassigned when someone is out; history is preserved.
CREATE TABLE IF NOT EXISTS route_assignments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id       INTEGER NOT NULL REFERENCES routes(id)   ON DELETE CASCADE,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  effective_date TEXT    NOT NULL DEFAULT (date('now')),
  end_date       TEXT,
  assigned_by    INTEGER REFERENCES users(id),
  reason         TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_route_assign ON route_assignments(route_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_route_assign_emp ON route_assignments(employee_id, end_date);

-- ---------- Service execution ----------

-- One row per unit per service date: the day's work list.
CREATE TABLE IF NOT EXISTS service_stops (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  service_date TEXT    NOT NULL,
  route_id     INTEGER REFERENCES routes(id) ON DELETE SET NULL,
  unit_id      INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','completed','issue','skipped')),
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (service_date, unit_id)
);
CREATE INDEX IF NOT EXISTS idx_stops_date_route ON service_stops(service_date, route_id, status);

-- The permanent record. Never updated after the fact - a correction
-- is a new row, so history cannot be quietly rewritten.
CREATE TABLE IF NOT EXISTS pickup_records (
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
                    'oversized_item','customer_not_found','other')),
  notes           TEXT,
  completed_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  gps_lat         REAL,   -- optional, for a later version
  gps_lng         REAL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_records_unit ON pickup_records(unit_id, service_date);
CREATE INDEX IF NOT EXISTS idx_records_customer ON pickup_records(customer_id, service_date);
CREATE INDEX IF NOT EXISTS idx_records_employee ON pickup_records(employee_id, service_date);
CREATE INDEX IF NOT EXISTS idx_records_date ON pickup_records(service_date, status);

-- The image itself lives in object storage. Only the key/URL here.
CREATE TABLE IF NOT EXISTS pickup_photos (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_record_id  INTEGER NOT NULL REFERENCES pickup_records(id) ON DELETE CASCADE,
  storage_key       TEXT    NOT NULL,
  mime_type         TEXT,
  bytes             INTEGER,
  uploaded_by       INTEGER REFERENCES users(id),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_record ON pickup_photos(pickup_record_id);

-- ---------- Notes and audit ----------

CREATE TABLE IF NOT EXISTS customer_notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id    INTEGER REFERENCES customers(id) ON DELETE CASCADE,
  unit_id        INTEGER REFERENCES units(id) ON DELETE CASCADE,
  author_user_id INTEGER REFERENCES users(id),
  body           TEXT    NOT NULL,
  visible_to_customer INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cnotes_customer ON customer_notes(customer_id, created_at);

CREATE TABLE IF NOT EXISTS employee_notes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  author_user_id INTEGER REFERENCES users(id),
  body           TEXT    NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Append-only trail of consequential actions.
CREATE TABLE IF NOT EXISTS audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER REFERENCES users(id),
  actor_role    TEXT,
  action        TEXT    NOT NULL,
  entity_type   TEXT,
  entity_id     INTEGER,
  detail        TEXT,      -- JSON
  ip            TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user_id, created_at);

-- Reserved introductory spots (replaces the old JSON counter).
CREATE TABLE IF NOT EXISTS intro_counter (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  claimed INTEGER NOT NULL DEFAULT 0,
  total   INTEGER NOT NULL DEFAULT 100
);
INSERT OR IGNORE INTO intro_counter (id, claimed, total) VALUES (1, 0, 100);
