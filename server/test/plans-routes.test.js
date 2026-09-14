import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.DB_PATH = ':memory:';
const { migrate, one, run } = await import('../db/index.js');
const { migratePlans } = await import('../db/migrate_plans.js');
migrate(); migratePlans();
const { router } = await import('../routes/plans.js');

// A REAL admin user, so audit_log.actor_user_id and plan_price_changes.created_by
// (both FK -> users(id)) resolve exactly as they do in production.
const adminId = run(`INSERT INTO users (email, password_hash, role, first_name, last_name)
                     VALUES ('admin@test.local', 'x', 'admin', 'A', 'D')`).lastInsertRowid;

// Minimal harness: inject the admin user, JSON body parsing, mount router.
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = { id: adminId, role: 'admin' }; next(); });
app.use('/api/admin/plans', router);

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}/api/admin/plans`;
const api = async (method, path = '', body) => {
  const res = await fetch(base + path, {
    method, headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('create -> list -> edit -> lifecycle -> price-change flow', async () => {
  // Create
  const created = await api('POST', '', { name: 'Weekly', priceDollars: 8,
    intervalUnit: 'week', intervalCount: 1, status: 'active', customerAvailable: true });
  assert.equal(created.status, 200);
  const id = created.json.plan.id;

  // List shows a human frequency + customer count
  const list = await api('GET');
  const row = list.json.plans.find(p => p.id === id);
  assert.equal(row.frequency, 'weekly');
  assert.equal(row.customers, 0);
  assert.equal(row.status, 'active');

  // Edit
  const edited = await api('PATCH', `/${id}`, { priceDollars: 9, label: 'Best Value' });
  assert.equal(edited.status, 200);
  assert.equal(one(`SELECT price_cents FROM plans WHERE id = ?`, id).price_cents, 900);

  // Lifecycle: deactivate
  const act = await api('POST', `/${id}/action`, { action: 'deactivate' });
  assert.equal(act.status, 200);
  assert.equal(one(`SELECT status FROM plans WHERE id = ?`, id).status, 'inactive');

  // Price change (existing_and_new) records a schedule row
  const pc = await api('POST', `/${id}/price-change`, { newPriceDollars: 12,
    appliesTo: 'existing_and_new', effectiveDate: '2999-01-01' });
  assert.equal(pc.status, 200);
  assert.equal(one(`SELECT price_cents FROM plans WHERE id = ?`, id).price_cents, 1200);
  assert.ok(one(`SELECT id FROM plan_price_changes WHERE plan_id = ?`, id));
});

test('an unknown action is rejected', async () => {
  const created = await api('POST', '', { name: 'X', priceDollars: 5,
    intervalUnit: 'month', intervalCount: 1, status: 'draft' });
  const id = created.json.plan.id;
  const res = await api('POST', `/${id}/action`, { action: 'bogus' });
  assert.equal(res.status, 400);
});

test.after(() => server.close());
