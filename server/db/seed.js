/* ============================================================
   Fresh-install seed.

     node db/seed.js --reset

   Produces the experience a brand-new business owner should see:
   an EMPTY operational dashboard (no customers, communities, routes,
   employees, or revenue of their own), plus exactly two self-contained
   TRAINING accounts so the customer and employee experiences can be
   demonstrated:

     customer@email.com / customer
     employee@dashtrashpickup.com / employee

   Every row those two accounts rely on is flagged is_demo = 1, so the
   owner's dashboards and reports exclude them entirely (see the is_demo
   filters across the admin routes). The owner account itself is real:

     admin@dashtrashpickup.com / DashDemo2026   (Jey Lofton)

   Reference data (plans, the launch coupon) is real and shared - it is
   configuration a new business keeps, not another business's records.
   ============================================================ */

import { db, migrate, one, run, tx, migrateDemoFlags } from './index.js';
import { migrateAdmin, migrateCommunities, migrateIssueCodes, migrateAdminControls, migrateDynamicRoles } from './migrate_admin.js';
import { migrateCommunityLifecycle } from './migrate_lifecycle.js';
import { hashPassword } from '../lib/auth.js';

const RESET = process.argv.includes('--reset');

// Run the SAME migration chain the server boot runs, so the schema is final
// before seeding (in particular is_demo exists and later boots won't rebuild a
// table and drop the flags we set here).
migrate();
migrateAdmin(); migrateCommunities(); migrateIssueCodes(); migrateAdminControls(); migrateDynamicRoles();
migrateCommunityLifecycle();
migrateDemoFlags();

if (RESET) {
  const tables = ['pickup_photos', 'pickup_records', 'service_stops', 'route_assignments',
    'route_stops', 'routes', 'pickup_schedules', 'time_entries', 'employee_compensation',
    'pay_periods', 'payments', 'subscriptions', 'coupon_redemptions', 'service_credits',
    'service_addresses', 'units', 'buildings', 'communities', 'customer_notes',
    'employee_notes', 'audit_log', 'sessions', 'customers', 'employees', 'users',
    'coupons', 'plans'];
  db.exec('PRAGMA foreign_keys = OFF');
  for (const t of tables) { try { db.exec(`DELETE FROM ${t}`); } catch {} }
  db.exec(`DELETE FROM sqlite_sequence`);
  db.exec('PRAGMA foreign_keys = ON');
  console.log('  reset: all data cleared');
}

if (one('SELECT id FROM users LIMIT 1')) {
  console.log('  database already has users - nothing seeded (use --reset to rebuild)');
  process.exit(0);
}

const OWNER_PASSWORD = 'DashDemo2026';
const ownerHash = await hashPassword(OWNER_PASSWORD);
// Training accounts use intentionally simple passwords (see the white-label
// spec, "practice credentials are intentionally simple"). They are safe only
// because these accounts touch nothing but their own is_demo sandbox.
const custHash = await hashPassword('customer');
const empHash = await hashPassword('employee');

const mkUser = (email, hash, role, first, last, phone, demo = 0) =>
  run(`INSERT INTO users (email, password_hash, role, first_name, last_name, phone, is_demo)
       VALUES (?, ?, ?, ?, ?, ?, ?)`, email, hash, role, first, last, phone, demo).lastInsertRowid;

tx(() => {
  /* ---------- reference data (real, shared configuration) ---------- */
  const plans = [
    ['Introductory', 'Introductory Rate', 1, 1800, 1],
    ['Monthly', 'Monthly', 1, 2800, 0],
    ['Quarterly', 'Quarterly', 3, 7400, 0],
    ['Annual', 'Annual', 12, 27600, 0],
  ];
  const planId = {};
  for (const [code, name, months, cents, intro] of plans) {
    planId[code] = run(`INSERT INTO plans (code, name, interval_months, price_cents, is_intro)
                        VALUES (?, ?, ?, ?, ?)`, code, name, months, cents, intro).lastInsertRowid;
  }
  // The launch promotion (100 spots) so the public intro offer works. 0 used.
  run(`INSERT INTO coupons (code, name, discount_type, discount_value, max_redemptions,
                            eligible_customer_type, is_intro, duration_periods)
       VALUES ('DASHLAUNCH','Dash Launch Special','promo_price',1800,100,'new',1,12)`);

  /* ---------- the owner (real) ---------- */
  const ownerId = mkUser('admin@dashtrashpickup.com', ownerHash, 'admin', 'Jey', 'Lofton', '706-555-0148', 0);

  /* ---------- training CUSTOMER (is_demo) ---------- */
  const custUserId = mkUser('customer@email.com', custHash, 'customer', 'Sample', 'Customer', '706-555-0101', 1);
  const demoCommunity = run(
    `INSERT INTO communities (name, kind, street, city, state, zip, is_demo)
     VALUES ('Sample Apartments','apartment','100 Sample St','Columbus','GA','31901', 1)`).lastInsertRowid;
  // Scheduled every day so the training employee always has a stop to work,
  // whatever day they log in to practice.
  for (let dow = 0; dow <= 6; dow++) {
    run(`INSERT INTO pickup_schedules (community_id, day_of_week) VALUES (?, ?)`, demoCommunity, dow);
  }
  const demoUnits = [];
  for (let n = 101; n <= 105; n++) {
    demoUnits.push(run(`INSERT INTO units (community_id, label, zip, is_demo)
                        VALUES (?, ?, '31901', 1)`, demoCommunity, `Unit ${n}`).lastInsertRowid);
  }
  const custId = run(
    `INSERT INTO customers (user_id, provider, status, is_demo) VALUES (?, 'demo', 'active', 1)`,
    custUserId).lastInsertRowid;
  run(`INSERT INTO service_addresses (customer_id, unit_id) VALUES (?, ?)`, custId, demoUnits[0]);
  const custSub = run(
    `INSERT INTO subscriptions (customer_id, plan_id, locked_price_cents, status, provider,
                                started_at, next_billing_date, is_demo)
     VALUES (?, ?, ?, 'active', 'demo', date('now','-30 days'), date('now','+30 days'), 1)`,
    custId, planId.Monthly, 2800).lastInsertRowid;
  // A short billing history: two paid months.
  for (const ago of [58, 28]) {
    run(`INSERT INTO payments (customer_id, subscription_id, amount_cents, status, provider, paid_at, is_demo)
         VALUES (?, ?, 2800, 'paid', 'demo', datetime('now','-' || ? || ' days'), 1)`, custId, custSub, ago);
  }

  /* ---------- training EMPLOYEE (is_demo) ---------- */
  const empUserId = mkUser('employee@dashtrashpickup.com', empHash, 'employee', 'Sample', 'Employee', '706-555-0102', 1);
  const empId = run(`INSERT INTO employees (user_id, employee_code, hire_date, status, is_demo)
                     VALUES (?, 'EMP-DEMO', date('now','-60 days'), 'active', 1)`, empUserId).lastInsertRowid;
  run(`INSERT INTO employee_compensation (employee_id, pay_type, rate_cents, effective_date, created_by, note)
       VALUES (?, 'hourly', 1800, date('now','-60 days'), ?, 'Training rate')`, empId, ownerId);

  // A "Demo Route" for every weekday so the employee always has a route to
  // work today, whatever day it is. Each stops at the Sample Apartments.
  for (let dow = 0; dow <= 6; dow++) {
    const rid = run(`INSERT INTO routes (name, day_of_week, status, is_demo)
                     VALUES ('Demo Route', ?, 'active', 1)`, dow).lastInsertRowid;
    run(`INSERT INTO route_stops (route_id, community_id, sort_order, is_demo) VALUES (?, ?, 0, 1)`,
        rid, demoCommunity);
    run(`INSERT INTO route_assignments (route_id, employee_id, effective_date, assigned_by, is_demo)
         VALUES (?, ?, date('now','-30 days'), ?, 1)`, rid, empId, ownerId);
  }

  // A little timesheet history so Hours/Pay have something to show. Three
  // past completed shifts of ~3 hours each, at the snapshotted training rate.
  for (const ago of [7, 5, 2]) {
    run(`INSERT INTO time_entries
           (employee_id, work_date, clock_in_at, clock_out_at, source,
            pay_type_snapshot, rate_cents_snapshot, is_demo)
         VALUES (?, date('now','-' || ? || ' days'),
                 datetime('now','-' || ? || ' days','+8 hours'),
                 datetime('now','-' || ? || ' days','+11 hours'),
                 'employee','hourly',1800, 1)`, empId, ago, ago, ago);
  }

  // A couple of completed pickups so the customer's service history is not empty.
  for (const ago of [7, 2]) {
    run(`INSERT INTO pickup_records (service_date, unit_id, customer_id, employee_id, status, completed_at, is_demo)
         VALUES (date('now','-' || ? || ' days'), ?, ?, ?, 'completed', datetime('now','-' || ? || ' days','+9 hours'), 1)`,
        ago, demoUnits[0], custId, empId, ago);
  }

  run(`INSERT INTO audit_log (actor_user_id, actor_role, action, entity_type, detail)
       VALUES (?, 'admin', 'seed.database', 'system', ?)`,
      ownerId, JSON.stringify({ note: 'fresh install: owner + training accounts' }));
});

const count = (t, where = '') => one(`SELECT COUNT(*) AS n FROM ${t} ${where}`).n;
console.log(`
  Fresh install seeded.

  Owner (real, empty dashboard):
    admin@dashtrashpickup.com / ${OWNER_PASSWORD}

  Training accounts (is_demo, isolated from the owner's numbers):
    customer@email.com / customer
    employee@dashtrashpickup.com / employee

  Real business rows (all 0 -> blank slate):
    customers ${count('customers', 'WHERE is_demo=0')}   communities ${count('communities', 'WHERE is_demo=0')}   routes ${count('routes', 'WHERE is_demo=0')}   employees ${count('employees', 'WHERE is_demo=0')}
`);
