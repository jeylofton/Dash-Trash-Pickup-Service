-- ============================================================
-- Employee management, accounts, password handling
--
-- Credentials stay in `users`; everything descriptive about a
-- person lives in `employee_profiles`. Keeping them apart means a
-- profile can be read for operational screens without touching
-- the row that holds the password hash.
-- ============================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employee_profiles (
  employee_id             INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  address                 TEXT,
  city                    TEXT DEFAULT 'Columbus',
  state                   TEXT DEFAULT 'GA',
  zip                     TEXT,
  emergency_contact_name  TEXT,
  emergency_contact_phone TEXT,
  job_title               TEXT DEFAULT 'Pickup Technician',
  -- Optional / later fields. Sensitive: admin-only, never sent to
  -- an employee's own dashboard.
  drivers_license         TEXT,
  vehicle_assignment      TEXT,
  uniform_size            TEXT,
  training_completed      TEXT,
  background_check_status TEXT CHECK (background_check_status IN
                            ('not_started','pending','cleared','flagged')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Every password action, so a reset can be traced later.
CREATE TABLE IF NOT EXISTS password_reset_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_user_id  INTEGER REFERENCES users(id),
  kind           TEXT NOT NULL CHECK (kind IN
                   ('temporary_password','force_change','self_change','unlock','lock')),
  -- Never the password itself, only that one was issued.
  expires_at     TEXT,
  used_at        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_reset_events(user_id, created_at);
