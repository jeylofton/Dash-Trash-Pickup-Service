/* ============================================================
   Practice/sandbox isolation: everything flagged is_demo = 1 is
   invisible to the owner's dashboards and reports, while real rows
   still show. Proven by seeding one real customer/employee/community
   alongside a full demo set and asserting the owner sees only the
   real one (and, for a truly fresh install, zero).
   ============================================================ */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.DB_PATH = ':memory:';
process.env.DEV_RELOAD = '0';
process.env.NODE_ENV = 'test';
process.env.PAYMENT_PROVIDER = 'demo';

const { one, run } = await import('../db/index.js');
const { hashPassword } = await import('../lib/auth.js');
const { app } = await import('../server.js');

const pw = await hashPassword('Passw0rd99');
run(`INSERT INTO plans (code,name,interval_unit,interval_count,price_cents,is_intro,status,customer_available) VALUES ('Monthly','Monthly','month',1,2800,0,'active',1)`);
const monthly = one(`SELECT id FROM plans WHERE code='Monthly'`).id;
const adminId = run(`INSERT INTO users (email,password_hash,role,first_name,last_name)
  VALUES ('owner@t.local',?,'admin','Own','Er')`, pw).lastInsertRowid;

const todayDow = new Date().getDay();

/* Seed a customer/community/employee pair - one real, one demo - so the
   test proves demo rows are hidden AND real rows survive. */
function seedTriple({ demo, tag }) {
  const cu = run(`INSERT INTO users (email,password_hash,role,first_name,last_name,is_demo)
    VALUES (?,?,'customer','C',?,?)`, `cust-${tag}@t.local`, pw, tag, demo).lastInsertRowid;
  const comm = run(`INSERT INTO communities (name,kind,zip,status,is_demo)
    VALUES (?, 'apartment','31901','active',?)`, `Comm ${tag}`, demo).lastInsertRowid;
  const unit = run(`INSERT INTO units (community_id,label,zip,is_demo) VALUES (?,?, '31901',?)`, comm, `U-${tag}`, demo).lastInsertRowid;
  const cust = run(`INSERT INTO customers (user_id,provider,status,is_demo) VALUES (?, 'demo','active',?)`, cu, demo).lastInsertRowid;
  run(`INSERT INTO service_addresses (customer_id,unit_id) VALUES (?,?)`, cust, unit);
  const sub = run(`INSERT INTO subscriptions (customer_id,plan_id,locked_price_cents,status,provider,started_at,next_billing_date,is_demo)
    VALUES (?,?,2800,'active','demo',date('now','-30 days'),date('now','+30 days'),?)`, cust, monthly, demo).lastInsertRowid;
  run(`INSERT INTO payments (customer_id,subscription_id,amount_cents,status,provider,paid_at,is_demo)
    VALUES (?,?,2800,'paid','demo',datetime('now','-10 days'),?)`, cust, sub, demo);

  const eu = run(`INSERT INTO users (email,password_hash,role,first_name,last_name,is_demo)
    VALUES (?,?,'employee','E',?,?)`, `emp-${tag}@t.local`, pw, tag, demo).lastInsertRowid;
  const emp = run(`INSERT INTO employees (user_id,employee_code,status,is_demo) VALUES (?,?, 'active',?)`, eu, `E-${tag}`, demo).lastInsertRowid;
  const route = run(`INSERT INTO routes (name,day_of_week,status,is_demo) VALUES (?,?, 'active',?)`, `Route ${tag}`, todayDow, demo).lastInsertRowid;
  run(`INSERT INTO route_assignments (route_id,employee_id,effective_date,is_demo)
    VALUES (?,?,date('now','-10 days'),?)`, route, emp, demo);
  run(`INSERT INTO time_entries (employee_id,work_date,clock_in_at,clock_out_at,source,pay_type_snapshot,rate_cents_snapshot,is_demo)
    VALUES (?,date('now','-2 days'),datetime('now','-2 days','+8 hours'),datetime('now','-2 days','+11 hours'),'employee','hourly',1800,?)`, emp, demo);
  return { cust, emp, comm };
}

seedTriple({ demo: 1, tag: 'demo' });     // must be hidden from the owner
const real = seedTriple({ demo: 0, tag: 'real' });  // must remain visible

const server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function login(email) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Passw0rd99' }) });
  return (r.headers.get('set-cookie') || '').split(';')[0];
}
async function get(path, cookie) {
  const r = await fetch(`${base}${path}`, { headers: { Cookie: cookie } });
  let json = null; try { json = JSON.parse(await r.text()); } catch {}
  return { status: r.status, json };
}
const admin = await login('owner@t.local');

test('overview counts exclude demo rows', async () => {
  const { json: o } = await get('/api/admin/overview', admin);
  assert.equal(o.customers.active, 1, 'only the real customer is counted');
  assert.equal(o.payments.collectedDollars, 28, 'only the real payment is collected');
  assert.equal(o.mrrDollars, 28, 'MRR excludes the demo subscription');
  assert.equal(o.communities.active, 1, 'only the real community is active');
  assert.equal(o.employeesAssigned, 1, 'only the real employee is assigned today');
});

test('the customers list excludes demo customers', async () => {
  const { json } = await get('/api/admin/customers', admin);
  const rows = Array.isArray(json) ? json : (json.customers || json.rows || []);
  assert.equal(rows.length, 1, 'only the real customer is listed');
});

test('the communities list excludes demo communities', async () => {
  const { json } = await get('/api/communities', admin);
  const rows = Array.isArray(json) ? json : (json.communities || json.rows || []);
  assert.ok(!rows.some(c => /demo/i.test(c.name)), 'no demo community is listed');
  assert.ok(rows.some(c => /real/i.test(c.name)), 'the real community is listed');
});

test('the employees list excludes demo employees', async () => {
  const { json } = await get('/api/people/employees', admin);
  const rows = Array.isArray(json) ? json : (json.employees || json.rows || []);
  assert.equal(rows.length, 1, 'only the real employee is listed');
});

test('finance revenue excludes demo payments', async () => {
  const { json } = await get('/api/finance/summary', admin);
  // Whatever the shape, the demo payment (2800) must not double the total.
  const str = JSON.stringify(json);
  assert.ok(!str.includes('56'), 'revenue is not doubled by the demo payment');
});

test('the demo customer can still see their own account', async () => {
  const cookie = await login('cust-demo@t.local');
  const { status, json } = await get('/api/customer/account', cookie);
  assert.equal(status, 200);
  assert.ok(json.subscription, 'the demo customer sees their own subscription');
});

test("a demo employee's live clock-in is flagged demo and stays out of owner payroll", async () => {
  const cookie = await login('emp-demo@t.local');
  const r = await fetch(`${base}/api/employee/clock-in`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 201, 'the demo employee can clock in');

  const openDemo = one(`SELECT is_demo FROM time_entries WHERE clock_out_at IS NULL ORDER BY id DESC LIMIT 1`);
  assert.equal(openDemo.is_demo, 1, 'the new shift is flagged demo');

  const { json } = await get('/api/finance/summary', admin);
  assert.equal(json.employeesClockedIn, 0, "the owner's clocked-in count ignores the demo shift");
  assert.equal(json.activeCustomers, 1, "the owner's active-customer count stays real-only");
});
