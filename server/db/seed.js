/* ============================================================
   Demo data so the dashboards have something to show.
     node db/seed.js            add demo data (safe to re-run)
     node db/seed.js --reset    wipe and rebuild
   ============================================================ */

import { db, migrate, one, all, run, tx } from './index.js';
import { hashPassword } from '../lib/auth.js';

const RESET = process.argv.includes('--reset');

migrate();

if (RESET) {
  const tables = ['pickup_photos','pickup_records','service_stops','route_assignments',
    'route_stops','routes','pickup_schedules','payments','subscriptions','plans',
    'service_addresses','units','buildings','communities','customer_notes',
    'employee_notes','audit_log','sessions','customers','employees','users'];
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of tables) db.exec(`DELETE FROM ${t}`);
  db.exec(`DELETE FROM sqlite_sequence`);
  db.exec(`UPDATE intro_counter SET claimed = 0`);
  db.exec('PRAGMA foreign_keys = ON');
  console.log('  reset: all data cleared');
}

if (one('SELECT id FROM users LIMIT 1')) {
  console.log('  database already has users - nothing seeded (use --reset to rebuild)');
  process.exit(0);
}

const DEMO_PASSWORD = 'DashDemo2026';
const pw = await hashPassword(DEMO_PASSWORD);

const mkUser = (email, role, first, last, phone) =>
  run(`INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
       VALUES (?, ?, ?, ?, ?, ?)`, email, pw, role, first, last, phone).lastInsertRowid;

tx(() => {
  /* ---- plans (prices match CONFIG in scripts.js) ---- */
  const plans = [
    ['Introductory', 'Introductory Rate', 1,  1800, 1],
    ['Monthly',      'Monthly',           1,  2800, 0],
    ['Quarterly',    'Quarterly',         3,  7400, 0],
    ['Annual',       'Annual',            12, 27600, 0],
  ];
  for (const [code, name, months, cents, intro] of plans) {
    run(`INSERT INTO plans (code, name, interval_months, price_cents, is_intro)
         VALUES (?, ?, ?, ?, ?)`, code, name, months, cents, intro);
  }

  /* ---- staff ---- */
  const adminUser = mkUser('admin@dashtrashpickup.com', 'admin', 'Jey', 'Lofton', '706-555-0148');

  const employees = [
    ['marcus@dashtrashpickup.com', 'Marcus', 'Reed',    '706-555-0112', 'EMP-001'],
    ['james@dashtrashpickup.com',  'James',  'Whitaker','706-555-0133', 'EMP-002'],
    ['mike@dashtrashpickup.com',   'Mike',   'Johnson', '706-555-0177', 'EMP-003'],
  ];
  const empIds = employees.map(([email, f, l, phone, code]) => {
    const uid = mkUser(email, 'employee', f, l, phone);
    return run(`INSERT INTO employees (user_id, employee_code, hire_date)
                VALUES (?, ?, date('now','-60 days'))`, uid, code).lastInsertRowid;
  });

  /* ---- communities, buildings, units ---- */
  const communities = [
    ['Creekside Apartments', 'apartment', '1400 Creekside Dr', '31904', ['Building 1','Building 2','Building 4'], 14],
    ['Riverwalk Townhomes',  'townhome',  '88 Riverwalk Way',  '31901', ['Row A','Row B'], 10],
    ['Oak Ridge Apartments', 'apartment', '2200 Oak Ridge Rd', '31907', ['Building A','Building B'], 12],
  ];

  const unitIds = [];
  const communityIds = [];

  for (const [name, kind, street, zip, buildingNames, unitCount] of communities) {
    const cid = run(`INSERT INTO communities (name, kind, street, zip) VALUES (?, ?, ?, ?)`,
                    name, kind, street, zip).lastInsertRowid;
    communityIds.push(cid);

    // Tuesday (2) and Thursday (4)
    for (const dow of [2, 4]) {
      run(`INSERT INTO pickup_schedules (community_id, day_of_week) VALUES (?, ?)`, cid, dow);
    }

    const bIds = buildingNames.map((bn, i) =>
      run(`INSERT INTO buildings (community_id, name, sort_order) VALUES (?, ?, ?)`, cid, bn, i)
        .lastInsertRowid);

    for (let i = 0; i < unitCount; i++) {
      const bId = bIds[i % bIds.length];
      const label = `Unit ${100 + Math.floor(i / bIds.length) * 100 + (i % bIds.length) + 1}`;
      unitIds.push(run(
        `INSERT INTO units (community_id, building_id, label, zip) VALUES (?, ?, ?, ?)`,
        cid, bId, label, zip
      ).lastInsertRowid);
    }
  }

  // two standalone houses
  for (const [label, street, zip] of [['1823 Oak Street','1823 Oak Street','31906'],
                                      ['945 Pine Hollow Rd','945 Pine Hollow Rd','31909']]) {
    const uid = run(`INSERT INTO units (label, street, zip) VALUES (?, ?, ?)`, label, street, zip).lastInsertRowid;
    unitIds.push(uid);
    for (const dow of [2, 4]) {
      run(`INSERT INTO pickup_schedules (unit_id, day_of_week) VALUES (?, ?)`, uid, dow);
    }
  }

  /* ---- customers on units ---- */
  const firstNames = ['John','Jane','Marcus','Ava','Liam','Noah','Olivia','Emma','Ethan','Sophia',
                      'Mason','Isabella','Lucas','Mia','Amelia','Harper','Elijah','Charlotte','Evelyn','Henry'];
  const lastNames  = ['Smith','Doe','Bell','Carter','Nguyen','Patel','Brooks','Rivera','Hayes','Foster',
                      'Coleman','Ward','Barnes','Ellis','Grant','Mercer','Boyd','Reyes','Fletcher','Shaw'];

  const planRows = all('SELECT * FROM plans');
  const planByCode = Object.fromEntries(planRows.map(p => [p.code, p]));
  let introUsed = 0;

  unitIds.forEach((unitId, i) => {
    if (i % 4 === 3) return;   // leave some units vacant

    const first = firstNames[i % firstNames.length];
    const last = lastNames[(i * 7) % lastNames.length];
    const email = `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`;
    const uid = mkUser(email, 'customer', first, last, `706-555-${String(1000 + i).slice(-4)}`);

    // First several customers are on the introductory rate.
    const intro = introUsed < 9;
    const plan = intro ? planByCode.Introductory
               : [planByCode.Monthly, planByCode.Quarterly, planByCode.Annual][i % 3];
    if (intro) introUsed++;

    const cid = run(
      `INSERT INTO customers (user_id, is_intro, provider, status) VALUES (?, ?, 'demo', 'active')`,
      uid, intro ? 1 : 0
    ).lastInsertRowid;

    run(`INSERT INTO service_addresses (customer_id, unit_id) VALUES (?, ?)`, cid, unitId);

    const subId = run(
      `INSERT INTO subscriptions (customer_id, plan_id, locked_price_cents, status, provider,
                                  started_at, next_billing_date)
       VALUES (?, ?, ?, ?, 'demo', date('now','-30 days'), date('now','+' || ? || ' days'))`,
      cid, plan.id, plan.price_cents, 'active', String(30 * plan.interval_months)
    ).lastInsertRowid;

    // payment history, with a few realistic problems
    const status = i % 11 === 5 ? 'past_due' : i % 13 === 7 ? 'failed' : 'paid';
    run(`INSERT INTO payments (customer_id, subscription_id, amount_cents, status, provider, paid_at)
         VALUES (?, ?, ?, ?, 'demo', CASE WHEN ? = 'paid' THEN datetime('now','-28 days') ELSE NULL END)`,
        cid, subId, plan.locked_price_cents ?? plan.price_cents, status, status);
    if (status !== 'paid') {
      run(`UPDATE subscriptions SET status = 'past_due' WHERE id = ?`, subId);
    }
  });

  run(`UPDATE intro_counter SET claimed = ?`, introUsed);

  /* ---- routes ---- */
  const routeDefs = [
    ['North Columbus Route', 2, empIds[0]],
    ['North Columbus Route', 4, empIds[0]],
    ['South Columbus Route', 2, empIds[1]],
    ['South Columbus Route', 4, empIds[2]],
  ];
  for (const [name, dow, empId] of routeDefs) {
    const rid = run(`INSERT INTO routes (name, day_of_week) VALUES (?, ?)`, name, dow).lastInsertRowid;
    const stops = name.startsWith('North') ? communityIds.slice(0, 2) : communityIds.slice(2);
    stops.forEach((cid, i) =>
      run(`INSERT INTO route_stops (route_id, community_id, sort_order) VALUES (?, ?, ?)`, rid, cid, i));
    if (!name.startsWith('North')) {
      // standalone houses ride along on the south route
      all(`SELECT id FROM units WHERE community_id IS NULL`).forEach((u, i) =>
        run(`INSERT INTO route_stops (route_id, unit_id, sort_order) VALUES (?, ?, ?)`, rid, u.id, 10 + i));
    }
    run(`INSERT INTO route_assignments (route_id, employee_id, effective_date, assigned_by)
         VALUES (?, ?, date('now','-30 days'), ?)`, rid, empId, adminUser);
  }

  run(`INSERT INTO audit_log (actor_user_id, actor_role, action, entity_type, detail)
       VALUES (?, 'admin', 'seed.database', 'system', ?)`,
      adminUser, JSON.stringify({ note: 'demo data seeded' }));
});

const count = (t) => one(`SELECT COUNT(*) AS n FROM ${t}`).n;
console.log(`
  Seeded:
    users          ${count('users')}
    customers      ${count('customers')}
    employees      ${count('employees')}
    communities    ${count('communities')}
    units          ${count('units')}
    routes         ${count('routes')}
    subscriptions  ${count('subscriptions')}
    intro claimed  ${one('SELECT claimed FROM intro_counter').claimed}

  Sign in with password: ${DEMO_PASSWORD}
    admin@dashtrashpickup.com     (admin)
    marcus@dashtrashpickup.com    (employee)
    ${one("SELECT email FROM users WHERE role='customer' ORDER BY id LIMIT 1").email}  (customer)
`);
