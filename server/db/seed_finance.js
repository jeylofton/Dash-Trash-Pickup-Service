/* Demo payroll + expenses so the financial dashboard has real numbers. */
import { db, migrate, one, all, run, tx } from './index.js';
import { monthsEquivalent } from '../lib/billing.js';

migrate();

if (one(`SELECT id FROM time_entries LIMIT 1`)) {
  console.log('  finance demo data already present — nothing seeded');
  process.exit(0);
}

const employees = all(`SELECT e.id, u.first_name FROM employees e JOIN users u ON u.id = e.user_id ORDER BY e.id`);
if (!employees.length) { console.error('  run db/seed.js first'); process.exit(1); }

const COMP = [
  { pay_type: 'hourly', rate_cents: 1800 },   // Marcus  $18/hr
  { pay_type: 'daily',  rate_cents: 9000 },   // James   $90/shift
  { pay_type: 'hourly', rate_cents: 1650 },   // Mike    $16.50/hr
];

tx(() => {
  employees.forEach((e, i) => {
    const c = COMP[i % COMP.length];
    run(`INSERT INTO employee_compensation (employee_id, pay_type, rate_cents, effective_date, note)
         VALUES (?, ?, ?, date('now','-90 days'), 'Initial rate')`,
        e.id, c.pay_type, c.rate_cents);
  });

  /* --- 10 weeks of Tuesday/Thursday shifts --- */
  const routesByDay = {};
  for (const r of all(`SELECT id, day_of_week FROM routes`)) {
    (routesByDay[r.day_of_week] ||= []).push(r.id);
  }

  let shifts = 0;
  for (let back = 70; back >= 0; back--) {
    const d = new Date(); d.setDate(d.getDate() - back);
    const dow = d.getDay();
    if (dow !== 2 && dow !== 4) continue;            // Tue / Thu only
    const date = d.toISOString().slice(0, 10);
    const routes = routesByDay[dow] || [];

    routes.forEach((routeId, idx) => {
      const emp = employees[idx % employees.length];
      const comp = COMP[(employees.indexOf(emp)) % COMP.length];

      // Shifts run roughly 5:45pm–9:30pm, with some natural variation.
      const startH = 17, startM = 45 + Math.floor(Math.random() * 20);
      const minutes = 190 + Math.floor(Math.random() * 70);   // 3h10m – 4h20m
      const breakMin = Math.random() < 0.4 ? 15 : 0;
      const inAt = `${date} ${String(startH).padStart(2,'0')}:${String(startM % 60).padStart(2,'0')}:00`;
      const out = new Date(`${date}T${String(startH).padStart(2,'0')}:${String(startM % 60).padStart(2,'0')}:00`);
      out.setMinutes(out.getMinutes() + minutes);
      const outAt = out.toISOString().slice(0, 19).replace('T', ' ');

      run(`INSERT INTO time_entries
             (employee_id, route_id, work_date, clock_in_at, clock_out_at, break_minutes,
              pay_type_snapshot, rate_cents_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          emp.id, routeId, date, inAt, outAt, breakMin, comp.pay_type, comp.rate_cents);
      shifts++;
    });
  }

  /* --- expenses --- */
  const cat = Object.fromEntries(all('SELECT id, code FROM expense_categories').map(c => [c.code, c.id]));
  const routes = all('SELECT id, name FROM routes');
  const communities = all('SELECT id, name FROM communities');

  const monthly = [
    ['vehicle_ins',  'Commercial auto policy',        23000, 'Progressive', 'monthly'],
    ['vehicle_pmt',  'Truck payment',                 41500, 'Ally',        'monthly'],
    ['business_ins', 'General liability',             12000, 'Hiscox',      'monthly'],
    ['software',     'Route + billing software',       4900, 'RouteOps',    'monthly'],
    ['hosting',      'Website hosting and domain',     1800, 'Cloudflare',  'monthly'],
  ];

  for (let m = 2; m >= 0; m--) {
    const d = new Date(); d.setMonth(d.getMonth() - m, 5);
    const date = d.toISOString().slice(0, 10);
    for (const [code, desc, cents, vendor, rec] of monthly) {
      run(`INSERT INTO expenses (category_id, description, amount_cents, incurred_on, vendor, is_recurring, recurrence)
           VALUES (?, ?, ?, ?, ?, 1, ?)`, cat[code], desc, cents, date, vendor, rec);
    }
    // fuel is attributed to a route, so it lands in route profitability directly
    routes.forEach((r, i) => {
      run(`INSERT INTO expenses (category_id, description, amount_cents, incurred_on, vendor, route_id)
           VALUES (?, ?, ?, ?, 'Shell', ?)`,
          cat.fuel, `Fuel — ${r.name}`, 7500 + i * 1800, date, r.id);
    });
    // supplies attributed to a community
    communities.forEach((c, i) => {
      run(`INSERT INTO expenses (category_id, description, amount_cents, incurred_on, vendor, community_id)
           VALUES (?, ?, ?, ?, 'Uline', ?)`,
          cat.supplies, `Bags and liners — ${c.name}`, 3200 + i * 900, date, c.id);
    });
    run(`INSERT INTO expenses (category_id, description, amount_cents, incurred_on, vendor)
         VALUES (?, 'Card processing fees', ?, ?, 'PaySuite')`,
        cat.processing, 6400 + m * 300, date);
    run(`INSERT INTO expenses (category_id, description, amount_cents, incurred_on, vendor)
         VALUES (?, 'Local ads and door hangers', ?, ?, 'VistaPrint')`,
        cat.marketing, 9000, date);
  }

  /* --- recurring payments across the window ---
     The original seed wrote one payment per customer, which made 90-day
     revenue look like a single month's billing. Real subscriptions bill
     every period, so generate them. */
  run(`DELETE FROM payments`);
  const subs = all(`SELECT s.*, p.interval_unit, p.interval_count FROM subscriptions s
                      JOIN plans p ON p.id = s.plan_id
                     WHERE s.status IN ('active','past_due')`);
  let issued = 0;
  for (const sub of subs) {
    const cycleDays = Math.round(monthsEquivalent(sub.interval_unit, sub.interval_count) * 30);
    for (let back = 0; back <= 84; back += cycleDays) {
      // a small share of charges fail or sit unpaid, as they would in reality
      const roll = (sub.id + back) % 17;
      const status = roll === 3 ? 'failed' : roll === 7 ? 'past_due' : 'paid';
      run(`INSERT INTO payments (customer_id, subscription_id, amount_cents, status, provider,
                                 paid_at, created_at, failure_reason)
           VALUES (?, ?, ?, ?, 'demo',
                   CASE WHEN ? = 'paid' THEN datetime('now','-' || ? || ' days') ELSE NULL END,
                   datetime('now','-' || ? || ' days'),
                   CASE WHEN ? = 'failed' THEN 'Card declined' ELSE NULL END)`,
          sub.customer_id, sub.id, sub.locked_price_cents, status, status, back, back, status);
      issued++;
    }
  }
  console.log(`  payments issued: ${issued}`);

  console.log(`  shifts: ${shifts}`);
});

const money = (c) => '$' + (c / 100).toFixed(2);
console.log(`
  Finance demo data seeded:
    compensation rows  ${one('SELECT COUNT(*) n FROM employee_compensation').n}
    time entries       ${one('SELECT COUNT(*) n FROM time_entries').n}
    expenses           ${one('SELECT COUNT(*) n FROM expenses').n}  (${money(one('SELECT COALESCE(SUM(amount_cents),0) n FROM expenses').n)})
`);
