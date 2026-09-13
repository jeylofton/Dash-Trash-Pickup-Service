/* Demo coupons + service credits, including migrating the intro offer
   onto the real coupon system (replacing the frontend-only counter). */
import { migrate, one, all, run, tx } from './index.js';
import { migrateAdmin } from './migrate_admin.js';

// The seeding logic lives in an exported function (rather than running
// straight at module scope) so tests can call it against a real, freshly
// migrated database and assert on what it actually inserts — the only way
// to catch a seed value drifting from the schema, as happened here.
export function seedDiscounts() {
  migrate(); migrateAdmin();

  if (one('SELECT id FROM coupons LIMIT 1')) {
    console.log('  coupons already present — nothing seeded');
    return;
  }

  const plan = (code) => one('SELECT * FROM plans WHERE code = ?', code);
  const admin = one(`SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1`);

  tx(() => {
    /* ---- The launch special, now a real coupon ---- */
    const intro = run(
      `INSERT INTO coupons (code, name, description, discount_type, discount_value,
                            starts_at, ends_at, max_redemptions, per_customer_limit,
                            eligible_customer_type, allow_stacking, is_intro,
                            duration_periods, created_by)
       VALUES ('DASHLAUNCH', 'Dash Launch Special',
               'Introductory $18/month rate for the first 100 customers.',
               'promo_price', 1800,
               datetime('now','-60 days'), NULL, 100, 'once', 'new', 0, 1,
               12, ?)`,
      // duration_periods = 12: the promotion is "$18/month for 12 months,
      // then $28/month" — enrol() copies this onto
      // subscriptions.promo_periods_remaining at signup. Leaving it NULL
      // means "the promotional rate never ends", silently turning the
      // 12-month intro offer into $18/month forever.
      admin?.id ?? null).lastInsertRowid;

    const welcome = run(
      `INSERT INTO coupons (code, name, description, discount_type, discount_value,
                            starts_at, ends_at, max_redemptions, per_customer_limit,
                            eligible_customer_type, created_by)
       VALUES ('WELCOME5', 'Welcome $5 Off', '$5 off the first month for new customers.',
               'fixed', 500, datetime('now','-45 days'), datetime('now','+45 days'),
               500, 'once', 'new', ?)`, admin?.id ?? null).lastInsertRowid;
    // duration_periods left NULL: WELCOME5 is a one-time $5-off fixed
    // discount (per_customer_limit 'once'), not a multi-period promotional
    // rate — there is no term to carry.

    const loyal = run(
      `INSERT INTO coupons (code, name, description, discount_type, discount_value,
                            starts_at, ends_at, max_redemptions, per_customer_limit,
                            eligible_customer_type, created_by)
       VALUES ('LOYAL10', 'Loyalty 10% Off', '10% off for existing customers who upgrade.',
               'percent', 10, datetime('now','-30 days'), datetime('now','+60 days'),
               200, 'once', 'existing', ?)`, admin?.id ?? null).lastInsertRowid;
    // duration_periods left NULL: LOYAL10 is also a single-use percent-off
    // discount, applied once at upgrade — not a recurring promotional term.

    // an expired one, so the status logic has something to show
    run(`INSERT INTO coupons (code, name, description, discount_type, discount_value,
                              starts_at, ends_at, max_redemptions, created_by)
         VALUES ('SPRING24', 'Spring 2026 Promo', 'Expired seasonal promotion.',
                 'fixed', 300, datetime('now','-180 days'), datetime('now','-90 days'), 50, ?)`,
        admin?.id ?? null);
    // duration_periods left NULL: another one-time fixed discount.

    // annual-only coupon, to exercise plan eligibility
    const annual = plan('Annual');
    if (annual) run('INSERT INTO coupon_plans (coupon_id, plan_id) VALUES (?, ?)', loyal, annual.id);

    /* ---- Backfill redemptions for customers already on the intro rate ---- */
    const introPlan = plan('Introductory');
    const introCustomers = all(`
      SELECT c.id, s.id AS sub_id, s.locked_price_cents
        FROM customers c
        JOIN subscriptions s ON s.customer_id = c.id AND s.plan_id = ?
       WHERE c.is_intro = 1`, introPlan?.id ?? -1);

    const monthly = plan('Monthly');
    for (const c of introCustomers) {
      const original = monthly?.price_cents ?? 2800;
      run(`INSERT INTO coupon_redemptions
             (coupon_id, customer_id, subscription_id, original_price_cents,
              discount_cents, final_price_cents, customer_type, redeemed_at)
           VALUES (?, ?, ?, ?, ?, ?, 'new', datetime('now','-' || ? || ' days'))`,
          intro, c.id, c.sub_id, original, original - c.locked_price_cents,
          c.locked_price_cents, Math.floor(Math.random() * 55) + 3);
    }

    // a few WELCOME5 and LOYAL10 uses
    const others = all(`SELECT id FROM customers WHERE is_intro = 0 AND status='active' LIMIT 12`);
    others.forEach((c, i) => {
      const useWelcome = i % 3 !== 0;
      const couponId = useWelcome ? welcome : loyal;
      const original = useWelcome ? 2800 : 27600;
      const discount = useWelcome ? 500 : Math.round(original * 0.10);
      run(`INSERT INTO coupon_redemptions
             (coupon_id, customer_id, original_price_cents, discount_cents,
              final_price_cents, customer_type, redeemed_at)
           VALUES (?, ?, ?, ?, ?, ?, datetime('now','-' || ? || ' days'))`,
          couponId, c.id, original, discount, original - discount,
          useWelcome ? 'new' : 'existing', (i * 4) + 1);
    });

    /* ---- Service credits ---- */
    const employees = all(`SELECT e.id, e.user_id FROM employees e JOIN users u ON u.id=e.user_id
                            WHERE e.status='active' ORDER BY e.id LIMIT 3`);
    const customers = all(`SELECT c.id, u.id AS user_id FROM customers c JOIN users u ON u.id=c.user_id
                            WHERE c.status='active' LIMIT 20`);
    const communities = all('SELECT id FROM communities');
    const reasons = ['missed_pickup','late_pickup','service_error','customer_complaint','courtesy'];

    let n = 0;
    customers.slice(0, 14).forEach((c, i) => {
      const emp = employees[i % employees.length];
      if (!emp) return;
      const big = i % 7 === 3;                       // a few above the $5 limit
      const cents = big ? [1000, 1500, 800][i % 3] : [300, 500, 400, 500][i % 4];
      const status = big ? (i % 2 === 0 ? 'pending' : 'modified') : 'auto_approved';
      const approved = status === 'auto_approved' ? cents
                     : status === 'modified' ? Math.round(cents * 0.7) : null;

      run(`INSERT INTO service_credits
             (customer_id, requested_by_user_id, requested_by_employee_id, approved_by_user_id,
              requested_cents, approved_cents, reason, notes, community_id, status,
              requested_at, decided_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now','-' || ? || ' days'),
                   CASE WHEN ? IS NULL THEN NULL ELSE datetime('now','-' || ? || ' days') END)`,
          c.id, emp.user_id, emp.id, approved != null ? (admin?.id ?? null) : null,
          cents, approved, reasons[i % reasons.length],
          big ? 'Two pickups missed in the same week.' : 'Pickup missed; apologised on site.',
          communities[i % communities.length]?.id ?? null, status,
          (i * 3) + 1, approved, (i * 3));
      n++;
    });
    console.log(`  service credits: ${n}`);
  });

  const c = (t) => one(`SELECT COUNT(*) n FROM ${t}`).n;
  console.log(`
  Discounts demo data seeded:
    coupons              ${c('coupons')}
    coupon redemptions   ${c('coupon_redemptions')}
    service credits      ${c('service_credits')}
`);
}

// Only run when invoked directly (`node db/seed_discounts.js`), not when
// imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  seedDiscounts();
}
