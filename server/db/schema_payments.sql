-- Cards on file, provider-neutral.
--
-- A separate table rather than columns on `customers`, because replacing an
-- expired card must not erase the payment history that points at the old one.

CREATE TABLE IF NOT EXISTS payment_methods (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id          INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  provider             TEXT    NOT NULL,          -- 'demo' today
  provider_customer_id TEXT,
  provider_method_id   TEXT    NOT NULL,

  -- Display only. Never a full card number - no provider hands one back,
  -- and the demo provider is never given one.
  brand                TEXT,
  last_4               TEXT,
  exp_month            INTEGER,
  exp_year             INTEGER,

  is_default           INTEGER NOT NULL DEFAULT 1,
  status               TEXT    NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','expired','removed')),
  created_at           TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payment_methods_customer
  ON payment_methods(customer_id, status);
