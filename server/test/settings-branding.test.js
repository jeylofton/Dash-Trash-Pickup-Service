/* ============================================================
   Business Profile settings + public branding endpoint, attacked
   over HTTP against the real app.

   - /api/branding is public and exposes only the public fields.
   - Reading/editing the profile is permission-gated (system.settings.view
     / business.profile.edit); admin is absolute, a plain employee is not.
   - A save validates, updates the live branding, and writes an audit row.
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

const PW = 'Passw0rd99';
const pwHash = await hashPassword(PW);
run(`INSERT INTO users (email,password_hash,role,first_name,last_name)
     VALUES ('admin@t.local',?,'admin','Ad','Min')`, pwHash);
run(`INSERT INTO users (email,password_hash,role,first_name,last_name)
     VALUES ('emp@t.local',?,'employee','Em','Ploy')`, pwHash);
run(`INSERT INTO employees (user_id, employee_code, status)
     VALUES ((SELECT id FROM users WHERE email='emp@t.local'), 'E1', 'active')`);

const server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function login(email) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  return (r.headers.get('set-cookie') || '').split(';')[0] || null;
}
async function api(method, path, { cookie, body } = {}) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null; const raw = await r.text();
  try { json = JSON.parse(raw); } catch {}
  return { status: r.status, json, raw };
}

const admin = await login('admin@t.local');
const emp = await login('emp@t.local');

test('GET /api/branding is public and exposes only public fields', async () => {
  const r = await api('GET', '/api/branding');
  assert.equal(r.status, 200);
  assert.equal(r.json.name, 'Dash Trash Pickup');
  assert.ok('supportEmail' in r.json && 'website' in r.json);
  assert.ok(!('email' in r.json), 'internal email must not be public');
  assert.ok(!('phone' in r.json), 'internal phone must not be public');
});

test('reading the business profile needs system.settings.view', async () => {
  assert.equal((await api('GET', '/api/settings/business', { cookie: emp })).status, 404);
  const asAdmin = await api('GET', '/api/settings/business', { cookie: admin });
  assert.equal(asAdmin.status, 200);
  assert.equal(asAdmin.json.name, 'Dash Trash Pickup');
  assert.ok('email' in asAdmin.json, 'the edit view includes internal fields');
});

test('editing needs business.profile.edit; a plain employee is refused', async () => {
  assert.equal((await api('PATCH', '/api/settings/business',
    { cookie: emp, body: { name: 'Hacked' } })).status, 404);
});

test('an admin can rename the business, and it flows to branding', async () => {
  const r = await api('PATCH', '/api/settings/business',
    { cookie: admin, body: { name: 'Premier Valet Waste', supportEmail: 'help@premier.test' } });
  assert.equal(r.status, 200);
  assert.equal((await api('GET', '/api/branding')).json.name, 'Premier Valet Waste');
  assert.equal((await api('GET', '/api/settings/business', { cookie: admin })).json.supportEmail, 'help@premier.test');
  const log = one(`SELECT action FROM audit_log WHERE action = 'settings.business_profile_updated' ORDER BY id DESC LIMIT 1`);
  assert.ok(log, 'a settings change is audited');
});

test('an invalid email is rejected and nothing changes', async () => {
  const before = (await api('GET', '/api/branding')).json.name;
  const r = await api('PATCH', '/api/settings/business',
    { cookie: admin, body: { name: 'Should Not Save', supportEmail: 'not-an-email' } });
  assert.equal(r.status, 400);
  assert.equal((await api('GET', '/api/branding')).json.name, before, 'the whole change is rejected');
});

test('an empty business name is rejected', async () => {
  const r = await api('PATCH', '/api/settings/business', { cookie: admin, body: { name: '   ' } });
  assert.equal(r.status, 400);
});

test('a served HTML page reflects the configured name with no raw token leaking', async () => {
  await api('PATCH', '/api/settings/business', { cookie: admin, body: { name: 'Acme Waste Co' } });
  const page = await api('GET', '/dashboard/login.html');
  assert.equal(page.status, 200);
  assert.ok(page.raw.includes('Acme Waste Co'), 'the page shows the configured business name');
  assert.ok(!page.raw.includes('{{brand.name}}'), 'no raw {{brand.*}} token reaches the browser');
  assert.ok(!page.raw.includes('Dash Trash Pickup'), 'the old default name is gone');
});

test('a business name containing markup is escaped in served HTML', async () => {
  await api('PATCH', '/api/settings/business', { cookie: admin, body: { name: '<b>x</b>' } });
  const page = await api('GET', '/dashboard/login.html');
  assert.ok(!page.raw.includes('<b>x</b>'), 'raw markup must not be injected');
  assert.match(page.raw, /&lt;b&gt;x&lt;\/b&gt;/);
});
