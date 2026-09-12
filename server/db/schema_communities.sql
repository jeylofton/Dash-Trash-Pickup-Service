-- ============================================================
-- Community lifecycle: lead → waiting list → active
--
-- A property exists in the system long before we service it, so
-- Admin can track demand and decide where a driver is needed.
-- Adding a community NEVER starts service on its own.
-- ============================================================

PRAGMA foreign_keys = ON;

/* Customers who want service at a community that has not started. */
CREATE TABLE IF NOT EXISTS community_waitlist (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id  INTEGER REFERENCES communities(id) ON DELETE CASCADE,
  -- May be a prospect with no account yet, so these are free text.
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  unit_label    TEXT,
  street        TEXT,
  zip           TEXT,
  -- If they claimed the launch offer before service began.
  coupon_id     INTEGER REFERENCES coupons(id) ON DELETE SET NULL,
  promo_reserved INTEGER NOT NULL DEFAULT 0,
  customer_id   INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'waiting'
                  CHECK (status IN ('waiting','notified','converted','declined')),
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  notified_at   TEXT,
  converted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_waitlist_community ON community_waitlist(community_id, status);
CREATE INDEX IF NOT EXISTS idx_waitlist_email ON community_waitlist(email);

/* Status history, so "when did this become active" is answerable. */
CREATE TABLE IF NOT EXISTS community_status_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  community_id INTEGER NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  changed_by   INTEGER REFERENCES users(id),
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_comm_history ON community_status_history(community_id, created_at);

INSERT OR IGNORE INTO app_settings (key, value, description) VALUES
  ('pickup.require_photo',        '1', 'Require a photo to mark a pickup completed'),
  ('pickup.require_issue_photo',  '0', 'Require a photo when reporting an issue'),
  ('promo.reserve_on_waitlist',   '0', 'Waiting-list signups reserve a promo spot (1) or only count at activation (0)');
