/* ============================================================
   Clear operational/demo data so the owner can build their own.

     node db/reset-demo-data.js --dry-run   show what would go
     node db/reset-demo-data.js --confirm   actually do it

   This is DESTRUCTIVE and irreversible. It takes a backup first.

   The rule it follows: system CONFIGURATION stays, business
   RECORDS go. Anything that would have to be recreated by hand
   before a form works again is configuration.

   Deliberately a CLI, not an HTTP route. A reset that can be
   triggered over the network is a liability the moment a
   permission check is wrong; running it requires shell access to
   the server, which employees, managers and customers never have.
   ============================================================ */

import { db, one, all } from './index.js';

const DRY = process.argv.includes('--dry-run');
const CONFIRMED = process.argv.includes('--confirm');

if (!DRY && !CONFIRMED) {
  console.error(`
  This permanently deletes all customers, employees, communities, routes,
  pickups, payments, expenses and their history.

    node db/reset-demo-data.js --dry-run    preview
    node db/reset-demo-data.js --confirm    do it
`);
  process.exit(1);
}

/* What survives, and why. */
const KEEP = {
  users: "the admin account only - it is how you get back in",
  roles: 'role definitions',
  permissions: 'permission catalogue',
  role_permissions: 'which role may do what',
  user_roles: "the admin's own role link",
  plans: 'pricing architecture - signup needs these to exist',
  coupons: 'the Dash Launch Special only',
  coupon_plans: 'that promotion’s plan links',
  expense_categories: 'populates the Expenses form dropdown',
  app_settings: 'thresholds and system configuration',
  intro_counter: 'reset to zero, not dropped',
};

/* Cleared completely. Order is irrelevant - foreign keys are off
   for the transaction - but it is grouped to read like the dashboard. */
const CLEAR = [
  'service_stops', 'pickup_photos', 'pickup_records', 'pickup_schedules',
  'route_assignments', 'route_crew', 'route_stops', 'route_versions', 'routes',
  'community_waitlist', 'community_status_history', 'buildings', 'units', 'communities',
  'service_addresses', 'subscriptions', 'payments', 'payment_methods',
  'coupon_redemptions', 'service_credits',
  'customer_notes', 'employee_notes',
  'time_entries', 'pay_periods', 'employee_compensation', 'employee_profiles', 'employees',
  'expenses',
  'customers',
  'password_reset_events', 'sessions', 'audit_log',
];

const ADMIN = one(`SELECT id, email, first_name, last_name FROM users
                    WHERE role = 'admin' ORDER BY id LIMIT 1`);
if (!ADMIN) {
  console.error('\n  No admin account found. Refusing to reset - you would be locked out.\n');
  process.exit(1);
}

const INTRO = one(`SELECT id, code, name FROM coupons WHERE is_intro = 1 AND disabled = 0
                    ORDER BY id DESC LIMIT 1`);

console.log(`\n  ${DRY ? 'DRY RUN - nothing will change' : 'RESETTING'}\n`);
console.log(`  Keeping admin:     ${ADMIN.first_name} ${ADMIN.last_name} <${ADMIN.email}>`);
console.log(`  Keeping promotion: ${INTRO ? `${INTRO.code} - ${INTRO.name}` : '(none found)'}\n`);

const before = {};
for (const t of CLEAR) before[t] = one(`SELECT COUNT(*) n FROM ${t}`).n;
before.users = one(`SELECT COUNT(*) n FROM users`).n;
before.coupons = one(`SELECT COUNT(*) n FROM coupons`).n;

for (const [t, n] of Object.entries(before)) {
  if (n > 0) console.log(`    ${t.padEnd(28)} ${String(n).padStart(4)} rows`);
}

if (DRY) {
  console.log(`\n  Preserved: ${Object.keys(KEEP).join(', ')}\n`);
  process.exit(0);
}

/* Back up before touching anything. */
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = `data/backup-before-reset-${stamp}.db`;
db.exec(`VACUUM INTO '${backup}'`);
console.log(`\n  Backup: ${backup}`);

db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN');
try {
  for (const t of CLEAR) db.exec(`DELETE FROM ${t}`);

  // Every user except the admin, and their role links.
  db.prepare(`DELETE FROM user_roles WHERE user_id != ?`).run(ADMIN.id);
  db.prepare(`DELETE FROM users WHERE id != ?`).run(ADMIN.id);

  // Every coupon except the launch promotion.
  if (INTRO) {
    db.prepare(`DELETE FROM coupon_plans WHERE coupon_id != ?`).run(INTRO.id);
    db.prepare(`DELETE FROM coupons WHERE id != ?`).run(INTRO.id);
  }

  // The promotion starts over at zero used.
  db.exec(`UPDATE intro_counter SET claimed = 0`);

  // Autoincrement counters restart so the owner's first customer is #1.
  db.exec(`DELETE FROM sqlite_sequence
            WHERE name NOT IN ('users','roles','permissions','plans','coupons',
                               'expense_categories','app_settings')`);

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('\n  Reset failed, nothing was changed:', err.message, '\n');
  process.exit(1);
} finally {
  db.exec('PRAGMA foreign_keys = ON');
}

db.exec('VACUUM');

/* The reset is itself an auditable event - it is the first row in the new log. */
db.prepare(`INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, detail)
            VALUES (?, 'system.demo_data_reset', 'system', NULL, ?)`)
  .run(ADMIN.id, JSON.stringify({ backup, clearedTables: CLEAR.length }));

console.log('\n  Done. Remaining rows:\n');
for (const t of [...CLEAR, 'users', 'coupons', 'plans', 'expense_categories',
                 'app_settings', 'roles', 'permissions', 'role_permissions']) {
  const n = one(`SELECT COUNT(*) n FROM ${t}`).n;
  if (n > 0) console.log(`    ${t.padEnd(28)} ${String(n).padStart(4)}`);
}
console.log(`
  Everything else is empty. Sign in as ${ADMIN.email} and start adding
  communities, employees and customers.
`);
