import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.DB_PATH = ':memory:';
const { migrate, all, run } = await import('../db/index.js');
const { migratePlans } = await import('../db/migrate_plans.js');
migrate(); migratePlans();

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, '..', p), 'utf8');

function mk(code, status, avail, order) {
  run(`INSERT INTO plans (code,name,price_cents,interval_unit,interval_count,status,customer_available,display_order)
       VALUES (?,?,?,?,?,?,?,?)`, code, code, 1000, 'month', 1, status, avail, order);
}

test('only active + customer_available plans are offered, in display_order', () => {
  mk('B', 'active', 1, 2);
  mk('A', 'active', 1, 1);
  mk('Draft', 'draft', 1, 3);      // hidden: not active
  mk('Hidden', 'active', 0, 4);    // hidden: not customer_available
  mk('Arch', 'archived', 1, 5);    // hidden

  // Mirror the route's offering query.
  const offered = all(`SELECT code FROM plans
                        WHERE status = 'active' AND customer_available = 1
                        ORDER BY display_order, id`).map(r => r.code);
  assert.deepEqual(offered, ['A', 'B']);
});

test('customer.js no longer references interval_months or the removed active column', () => {
  const src = read('routes/customer.js');
  assert.ok(!/interval_months/.test(src), 'customer.js still references interval_months');
  assert.ok(!/plans WHERE active = 1|FROM plans WHERE code = \? AND \(active = 1/.test(src),
    'customer.js still filters plans on the removed active column');
});
