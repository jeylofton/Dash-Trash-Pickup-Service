-- ============================================================
-- Coupons, service-recovery credits, and role permissions
--
-- BUSINESS RULE enforced by the schema itself: a marketing coupon
-- and a service-recovery credit are different things and never
-- share a table. A coupon acquires or retains a customer; a credit
-- apologises for a mistake we made. They are reported separately.
-- ============================================================

PRAGMA foreign_keys = ON;

/* ---------- Configurable permissions ----------
   Admin is always allowed. Every other role is allowed only what
   appears here, so a Manager does not silently inherit Admin. */
CREATE TABLE IF NOT EXISTS role_permissions (
  role       TEXT NOT NULL,
  permission TEXT NOT NULL,
  allowed    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (role, permission)
);

/* ---------- Configurable limits (no magic numbers in code) ---------- */
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_by  INTEGER REFERENCES users(id),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO app_settings (key, value, description) VALUES
  ('credit.employee_max_cents',        '500',  'Most an employee may credit without approval'),
  ('credit.employee_monthly_cap_cents','5000', 'Most one employee may credit per calendar month'),
  ('credit.per_customer_monthly_cents','2000', 'Most one customer may receive per calendar month'),
  ('coupon.min_final_price_cents',     '500',  'A discount may never take a price below this'),
  ('plan.price_change_grace_days', '90',
   'Days an existing subscriber keeps their old price after a plan price change before switching to the new one');

/* ============================================================
   COUPONS — marketing
   ============================================================ */
CREATE TABLE IF NOT EXISTS coupons (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  code            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name            TEXT    NOT NULL,
  description     TEXT,

  discount_type   TEXT    NOT NULL CHECK (discount_type IN
                    ('fixed','percent','promo_price','free_period')),
  -- fixed: cents off · percent: 0-100 · promo_price: the new price in cents
  -- free_period: number of billing periods free
  discount_value  INTEGER NOT NULL CHECK (discount_value >= 0),

  starts_at       TEXT,           -- NULL = immediately
  ends_at         TEXT,           -- NULL = no end date
  max_redemptions INTEGER,        -- NULL = unlimited

  per_customer_limit TEXT NOT NULL DEFAULT 'once'
                       CHECK (per_customer_limit IN ('once','multiple','once_per_cycle')),
  eligible_customer_type TEXT NOT NULL DEFAULT 'all'
                       CHECK (eligible_customer_type IN ('new','existing','all')),

  allow_stacking  INTEGER NOT NULL DEFAULT 0,
  -- Marks the first-100 launch offer so the public site can find it.
  is_intro        INTEGER NOT NULL DEFAULT 0,
  -- Admin can switch a coupon off without deleting its history.
  disabled        INTEGER NOT NULL DEFAULT 0,

  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coupons_intro ON coupons(is_intro, disabled);

/* Which plans a coupon applies to. No rows = every plan. */
CREATE TABLE IF NOT EXISTS coupon_plans (
  coupon_id INTEGER NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
  plan_id   INTEGER NOT NULL REFERENCES plans(id)   ON DELETE CASCADE,
  PRIMARY KEY (coupon_id, plan_id)
);

/* A redemption row exists only for a COMPLETED transaction.
   Clicking or typing a code creates nothing — that is what stops a
   browsing visitor from burning one of the 100 launch spots. */
CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  coupon_id            INTEGER NOT NULL REFERENCES coupons(id) ON DELETE RESTRICT,
  customer_id          INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  subscription_id      INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  payment_id           INTEGER REFERENCES payments(id) ON DELETE SET NULL,

  original_price_cents INTEGER NOT NULL,
  discount_cents       INTEGER NOT NULL,
  final_price_cents    INTEGER NOT NULL,

  -- Decided at redemption time and frozen: a customer who is "new"
  -- today would otherwise look "existing" when the report is run later.
  customer_type        TEXT NOT NULL CHECK (customer_type IN ('new','existing')),
  status               TEXT NOT NULL DEFAULT 'completed'
                         CHECK (status IN ('completed','reversed')),
  redeemed_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_redemptions_coupon ON coupon_redemptions(coupon_id, status);
CREATE INDEX IF NOT EXISTS idx_redemptions_customer ON coupon_redemptions(customer_id, coupon_id);
CREATE INDEX IF NOT EXISTS idx_redemptions_date ON coupon_redemptions(redeemed_at);

/* ============================================================
   SERVICE CREDITS — operational apology, not marketing
   ============================================================ */
CREATE TABLE IF NOT EXISTS service_credits (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id            INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,

  requested_by_user_id   INTEGER REFERENCES users(id),
  requested_by_employee_id INTEGER REFERENCES employees(id),
  approved_by_user_id    INTEGER REFERENCES users(id),

  requested_cents        INTEGER NOT NULL CHECK (requested_cents > 0),
  approved_cents         INTEGER,          -- may differ if a manager modifies it

  reason                 TEXT NOT NULL CHECK (reason IN
                           ('missed_pickup','late_pickup','service_error','damaged_property',
                            'customer_complaint','billing_adjustment','courtesy','other')),
  notes                  TEXT,
  decision_notes         TEXT,

  -- Context, so a credit can be traced back to the service that caused it.
  pickup_record_id       INTEGER REFERENCES pickup_records(id) ON DELETE SET NULL,
  community_id           INTEGER REFERENCES communities(id) ON DELETE SET NULL,
  route_id               INTEGER REFERENCES routes(id) ON DELETE SET NULL,

  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                           ('auto_approved','pending','approved','modified','rejected','applied')),
  requested_at           TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at             TEXT,
  applied_at             TEXT
);
CREATE INDEX IF NOT EXISTS idx_credits_customer ON service_credits(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_credits_status ON service_credits(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_credits_employee ON service_credits(requested_by_employee_id, requested_at);
