/* ============================================================
   The PUBLIC plan feed that the marketing homepage and the Start
   Service signup read from — the same DB table the Admin manages, so
   there is one source of truth. It must expose only plans a visitor
   may actually buy (active + customer-available, never the intro promo
   row), in the admin-configured display order, shaped with everything
   the cards render (price, billing frequency, label).
   ============================================================ */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DB_PATH = ':memory:';
const { migrate, run } = await import('../db/index.js');
const { migratePlans } = await import('../db/migrate_plans.js');
migrate();
migratePlans();
const { listPublicPlans } = await import('../lib/plans.js');

const insert = (code, name, unit, count, cents, status, avail, order, label, intro) =>
  run(`INSERT INTO plans (code,name,interval_unit,interval_count,price_cents,
                          status,customer_available,display_order,label,is_intro)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    code, name, unit, count, cents, status, avail, order, label, intro);

// Deliberately out of display order, and a spread of things that must be hidden.
insert('Annual',       'Annual',            'year',  1, 27600, 'active',   1, 3, null,         0);
insert('Monthly',      'Monthly',           'month', 1,  2800, 'active',   1, 1, null,         0);
insert('Quarterly',    'Quarterly',         'month', 3,  7400, 'active',   1, 2, 'Best Value', 0);
insert('Draft',        'Draft',             'month', 1,  5000, 'draft',    1, 4, null,         0); // not active
insert('Hidden',       'Hidden',            'month', 1,  5000, 'active',   0, 5, null,         0); // not available
insert('Archived',     'Archived',          'month', 1,  5000, 'archived', 1, 6, null,         0); // archived
insert('Introductory', 'Introductory Rate', 'month', 1,  1800, 'inactive', 0, 7, null,         1); // promo, inactive

test('returns only active, customer-available, non-intro plans, in display order', () => {
  assert.deepEqual(listPublicPlans().map(p => p.code), ['Monthly', 'Quarterly', 'Annual']);
});

test('shapes each plan with the fields the public cards and signup render', () => {
  const q = listPublicPlans().find(p => p.code === 'Quarterly');
  assert.equal(q.name, 'Quarterly');
  assert.equal(q.priceCents, 7400);
  assert.equal(q.price, 74);
  assert.equal(q.intervalUnit, 'month');
  assert.equal(q.intervalCount, 3);
  assert.equal(q.perLabel, '/ 3 months');
  assert.equal(q.frequency, 'every 3 months');
  assert.equal(q.label, 'Best Value');
  assert.equal(q.displayOrder, 2);
});

const app = express();
app.get('/api/subscription-plans/public', (req, res) => res.json({ plans: listPublicPlans() }));
const server = app.listen(0);
const url = `http://127.0.0.1:${server.address().port}/api/subscription-plans/public`;

test('GET /api/subscription-plans/public serves the same public plans as JSON', async () => {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.plans.map(p => p.code), ['Monthly', 'Quarterly', 'Annual']);
});

test.after(() => server.close());
