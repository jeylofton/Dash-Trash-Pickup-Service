import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.PAYMENT_PROVIDER = 'demo';
const { db, migrate, one } = await import('../db/index.js');
migrate();
// A customer-available weekly plan — the path that was impossible under the old
// whole-month `interval_months` model.
db.exec(`INSERT INTO plans (code,name,interval_unit,interval_count,price_cents,is_intro,status,customer_available)
         VALUES ('Weekly','Weekly','week',1,800,0,'active',1)`);
const { enrol } = await import('../lib/signup.js');

test('demo signup on a weekly plan locks $8 and bills one week out', async () => {
  const res = await enrol({
    plan: 'Weekly', firstName: 'Wk', lastName: 'Ly', email: 'wk@test.local',
    phone: '7065550111', password: 'CorrectHorse9', street: '1 A St', unit: 'Unit 1',
    community: 'Testville', zip: '31900', startDate: '2026-03-01', outcome: 'success',
  });
  assert.equal(res.ok, true);
  const sub = one(`SELECT * FROM subscriptions WHERE id = ?`, res.subscriptionId);
  assert.equal(sub.locked_price_cents, 800);
  assert.equal(sub.status, 'active');
  assert.equal(sub.next_billing_date, '2026-03-08'); // exactly one week after the start date
});
