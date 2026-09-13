import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db, migrate } = await import('../db/index.js');
migrate();

test('payment_methods exists with the columns the billing layer needs', () => {
  const cols = db.prepare(`PRAGMA table_info(payment_methods)`).all().map(c => c.name);
  for (const c of ['customer_id','provider','provider_customer_id','provider_method_id',
                   'brand','last_4','exp_month','exp_year','is_default','status']) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
});

test('subscriptions and coupons can express a promotional term', () => {
  const subCols = db.prepare(`PRAGMA table_info(subscriptions)`).all().map(c => c.name);
  assert.ok(subCols.includes('promo_price_cents'));
  assert.ok(subCols.includes('promo_periods_remaining'));
  const couponCols = db.prepare(`PRAGMA table_info(coupons)`).all().map(c => c.name);
  assert.ok(couponCols.includes('duration_periods'),
            'a discount must be able to say "for N periods"');
});

test('status is constrained so a typo cannot silently store garbage', () => {
  db.exec(`INSERT INTO users (email,password_hash,role,first_name,last_name)
           VALUES ('pm@test.local','x','customer','P','M')`);
  db.exec(`INSERT INTO customers (user_id) VALUES (last_insert_rowid())`);

  // Insert a valid status to prove the column accepts good values.
  // Without this positive case, a failing insert could be due to any unrelated reason
  // (e.g. a missing NOT NULL on a different column), making the constraint's actual
  // enforcement unverifiable. The valid insert proves the negative assert is attributable
  // to the CHECK, not an unrelated issue.
  db.exec(`
    INSERT INTO payment_methods (customer_id, provider, provider_method_id, status)
    VALUES (1,'demo','demo_pm_ok','active')`);

  // Now confirm the constraint rejects invalid status values.
  assert.throws(() => db.exec(`
    INSERT INTO payment_methods (customer_id, provider, provider_method_id, status)
    VALUES (1,'demo','demo_pm_1','banana')`));
});
