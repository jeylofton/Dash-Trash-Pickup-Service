import { Router } from 'express';
import { one, all, run, tx } from '../db/index.js';
import { requireRole } from '../lib/rbac.js';
import { audit } from '../lib/audit.js';
import { hashPassword, passwordProblem } from '../lib/auth.js';
import { generateServiceDay, serviceDayStats, today, DAY_NAMES } from '../lib/schedule.js';

export const router = Router();
router.use(requireRole('admin'));          // every route below is admin-only

const money = (cents) => (cents / 100);
const like = (s) => `%${String(s).trim()}%`;

/* ---------- Overview ---------- */

router.get('/overview', (req, res) => {
  const date = req.query.date || today();
  generateServiceDay(date);                // make sure today's list exists
  const day = serviceDayStats(date);

  const activeCustomers = one(`SELECT COUNT(*) AS n FROM customers WHERE status='active'`).n;
  const introActive = one(
    `SELECT COUNT(*) AS n FROM customers c
       JOIN subscriptions s ON s.customer_id = c.id AND s.status IN ('active','past_due')
      WHERE c.is_intro = 1 AND c.status = 'active'`).n;
  const employeesAssigned = one(
    `SELECT COUNT(DISTINCT ra.employee_id) AS n
       FROM route_assignments ra
       JOIN routes r ON r.id = ra.route_id
      WHERE r.day_of_week = ? AND ra.effective_date <= ?
        AND (ra.end_date IS NULL OR ra.end_date >= ?)`,
    new Date(`${date}T12:00:00`).getDay(), date, date).n;

  const pay = one(`
    SELECT
      SUM(CASE WHEN status='paid'     THEN amount_cents ELSE 0 END) AS paid_cents,
      SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='past_due' THEN 1 ELSE 0 END) AS past_due,
      SUM(CASE WHEN status='failed'   THEN 1 ELSE 0 END) AS failed
    FROM payments`);

  // A promotional subscription still on its 12-month term bills at
  // promo_price_cents, not locked_price_cents - counting the standard rate
  // here would overstate MRR for every customer currently paying $18.
  const mrrCents = one(`
    SELECT COALESCE(SUM(
      CAST(CASE WHEN s.promo_periods_remaining > 0 THEN s.promo_price_cents ELSE s.locked_price_cents END AS REAL)
      / p.interval_months), 0) AS c
      FROM subscriptions s JOIN plans p ON p.id = s.plan_id
     WHERE s.status = 'active'`).c;

  /* Operations picture, not just today's numbers. */
  const photosToday = one(
    `SELECT COUNT(*) AS n FROM pickup_photos ph
       JOIN pickup_records pr ON pr.id = ph.pickup_record_id
      WHERE pr.service_date = ?`, date).n;

  const credits = one(`
    SELECT COALESCE(SUM(CASE WHEN status IN ('auto_approved','approved','modified','applied')
                             THEN COALESCE(approved_cents, requested_cents) END),0) AS granted_cents,
           COUNT(CASE WHEN status='pending' THEN 1 END) AS pending_count,
           COALESCE(SUM(CASE WHEN status='pending' THEN requested_cents END),0) AS pending_cents
      FROM service_credits
     WHERE strftime('%Y-%m', requested_at) = strftime('%Y-%m','now')`);

  const communities = one(`
    SELECT COUNT(CASE WHEN status='active' THEN 1 END) AS active,
           COUNT(CASE WHEN status IN ('waiting_list','lead') THEN 1 END) AS waiting,
           COUNT(CASE WHEN status='driver_needed' THEN 1 END) AS driver_needed,
           COUNT(CASE WHEN status='scheduled' THEN 1 END) AS scheduled
      FROM communities`);

  const upcoming = all(`
    SELECT id, name, status, tentative_start_date, unit_count_estimate
      FROM communities
     WHERE status != 'active' AND tentative_start_date IS NOT NULL
     ORDER BY tentative_start_date LIMIT 6`);

  const introCoupon = one(`SELECT * FROM coupons WHERE is_intro = 1 AND disabled = 0
                            ORDER BY id DESC LIMIT 1`);
  const introUsed = introCoupon
    ? one(`SELECT COUNT(*) AS n FROM coupon_redemptions
            WHERE coupon_id = ? AND status='completed'`, introCoupon.id).n : 0;

  res.json({
    day,
    photosToday,
    serviceCredits: {
      grantedThisMonth: money(credits.granted_cents),
      pendingCount: credits.pending_count,
      pendingAmount: money(credits.pending_cents),
    },
    communities: {
      active: communities.active, waitingList: communities.waiting,
      driverNeeded: communities.driver_needed, scheduled: communities.scheduled,
    },
    upcomingStarts: upcoming.map(c => ({
      id: c.id, name: c.name, status: c.status,
      tentativeStartDate: c.tentative_start_date, units: c.unit_count_estimate,
    })),
    promotion: introCoupon ? {
      code: introCoupon.code, used: introUsed,
      max: introCoupon.max_redemptions,
      remaining: introCoupon.max_redemptions == null ? null
        : Math.max(0, introCoupon.max_redemptions - introUsed),
    } : null,
    customers: { active: activeCustomers, introActive },
    // Live source, same one /api/intro-spots uses and the same value as
    // `promotion` above - intro_counter is written only by the seed
    // script and drifts from real signups immediately, so the tile must
    // never read it. (intro_counter itself is left in the schema for now;
    // it is dead and removable.)
    intro: introCoupon ? {
      claimed: introUsed, total: introCoupon.max_redemptions,
      remaining: introCoupon.max_redemptions == null ? null
        : Math.max(0, introCoupon.max_redemptions - introUsed),
    } : { claimed: 0, total: null, remaining: null },
    employeesAssigned,
    payments: {
      collectedDollars: money(pay.paid_cents || 0),
      pending: pay.pending || 0, pastDue: pay.past_due || 0, failed: pay.failed || 0,
    },
    mrrDollars: Math.round(mrrCents) / 100,
  });
});

/* ---------- Customers ---------- */

router.get('/customers', (req, res) => {
  const { q, status, plan, payment, limit = 100, offset = 0 } = req.query;
  const where = [], params = [];

  if (q)       { where.push('(u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR un.label LIKE ? OR com.name LIKE ?)');
                 params.push(like(q), like(q), like(q), like(q), like(q)); }
  if (status)  { where.push('c.status = ?'); params.push(status); }
  if (plan)    { where.push('p.code = ?'); params.push(plan); }
  if (payment) { where.push('sub.status = ?'); params.push(payment); }

  const sql = `
    SELECT c.id, c.status, c.is_intro,
           u.first_name, u.last_name, u.email, u.phone,
           un.id AS unit_id, un.label AS unit_label,
           com.id AS community_id, com.name AS community_name,
           p.code AS plan_code, sub.locked_price_cents, sub.promo_price_cents,
           sub.promo_periods_remaining, sub.status AS subscription_status,
           sub.next_billing_date
      FROM customers c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN service_addresses sa ON sa.customer_id = c.id AND sa.end_date IS NULL
      LEFT JOIN units un ON un.id = sa.unit_id
      LEFT JOIN communities com ON com.id = un.community_id
      LEFT JOIN subscriptions sub ON sub.customer_id = c.id AND sub.status != 'cancelled'
      LEFT JOIN plans p ON p.id = sub.plan_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY u.last_name, u.first_name
     LIMIT ? OFFSET ?`;

  const rows = all(sql, ...params, Number(limit), Number(offset));
  res.json(rows.map(r => {
    // The price actually in effect: the frozen promotional rate while its
    // term still has periods left, otherwise the standard rate - showing
    // locked_price_cents alone here told the owner every $18 customer was
    // paying $28.
    const onPromo = r.promo_periods_remaining > 0;
    return {
      ...r,
      price: r.locked_price_cents != null
        ? money(onPromo ? r.promo_price_cents : r.locked_price_cents) : null,
      afterPrice: onPromo ? money(r.locked_price_cents) : null,
    };
  }));
});

router.get('/customers/:id', (req, res) => {
  const c = one(`
    SELECT c.*, u.first_name, u.last_name, u.email, u.phone, u.status AS user_status, u.last_login_at
      FROM customers c JOIN users u ON u.id = c.user_id WHERE c.id = ?`, req.params.id);
  if (!c) return res.status(404).json({ error: 'Customer not found.' });

  res.json({
    customer: c,
    address: one(`
      SELECT sa.id, un.id AS unit_id, un.label, un.street, un.zip,
             b.name AS building, com.id AS community_id, com.name AS community
        FROM service_addresses sa
        JOIN units un ON un.id = sa.unit_id
        LEFT JOIN buildings b ON b.id = un.building_id
        LEFT JOIN communities com ON com.id = un.community_id
       WHERE sa.customer_id = ? AND sa.end_date IS NULL`, c.id),
    subscription: one(`
      SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.interval_months
        FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       WHERE s.customer_id = ? AND s.status != 'cancelled'
       ORDER BY s.id DESC LIMIT 1`, c.id),
    payments: all(`SELECT * FROM payments WHERE customer_id = ? ORDER BY created_at DESC LIMIT 24`, c.id),
    history: all(`
      SELECT pr.*, u.first_name AS emp_first, u.last_name AS emp_last,
             (SELECT COUNT(*) FROM pickup_photos ph WHERE ph.pickup_record_id = pr.id) AS photo_count
        FROM pickup_records pr
        LEFT JOIN employees e ON e.id = pr.employee_id
        LEFT JOIN users u ON u.id = e.user_id
       WHERE pr.customer_id = ? ORDER BY pr.service_date DESC, pr.completed_at DESC LIMIT 50`, c.id),
    notes: all(`
      SELECT n.*, u.first_name, u.last_name FROM customer_notes n
        LEFT JOIN users u ON u.id = n.author_user_id
       WHERE n.customer_id = ? ORDER BY n.created_at DESC`, c.id),
  });
});

router.patch('/customers/:id', (req, res) => {
  const c = one('SELECT * FROM customers WHERE id = ?', req.params.id);
  if (!c) return res.status(404).json({ error: 'Customer not found.' });

  const { firstName, lastName, email, phone, status } = req.body || {};
  tx(() => {
    if (firstName || lastName || email || phone) {
      run(`UPDATE users SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name),
                            email = COALESCE(?, email), phone = COALESCE(?, phone)
            WHERE id = ?`, firstName ?? null, lastName ?? null, email ?? null, phone ?? null, c.user_id);
    }
    if (status) run('UPDATE customers SET status = ? WHERE id = ?', status, c.id);
  });
  audit(req, 'customer.updated', { entityType: 'customer', entityId: c.id, detail: req.body });
  res.json({ ok: true });
});

router.post('/customers/:id/notes', (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Note cannot be empty.' });
  const id = run(`INSERT INTO customer_notes (customer_id, author_user_id, body, visible_to_customer)
                  VALUES (?, ?, ?, ?)`,
                 req.params.id, req.user.id, body, req.body?.visibleToCustomer ? 1 : 0).lastInsertRowid;
  audit(req, 'customer.note_added', { entityType: 'customer', entityId: Number(req.params.id) });
  res.status(201).json({ id });
});

/* ---------- Communities / buildings / units ---------- */

router.get('/communities', (req, res) => {
  res.json(all(`
    SELECT com.*,
           (SELECT COUNT(*) FROM units u WHERE u.community_id = com.id AND u.status='active') AS unit_count,
           (SELECT COUNT(*) FROM units u
              JOIN service_addresses sa ON sa.unit_id = u.id AND sa.end_date IS NULL
             WHERE u.community_id = com.id) AS occupied_count,
           (SELECT GROUP_CONCAT(day_of_week) FROM pickup_schedules ps
             WHERE ps.community_id = com.id AND ps.active = 1) AS schedule_days
      FROM communities com ORDER BY com.name`)
    .map(c => ({
      ...c,
      scheduleDays: (c.schedule_days || '').split(',').filter(Boolean).map(d => DAY_NAMES[Number(d)]),
    })));
});

router.post('/communities', (req, res) => {
  const { name, kind = 'apartment', street, zip, days = [] } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Community name is required.' });

  const id = tx(() => {
    const cid = run(`INSERT INTO communities (name, kind, street, zip) VALUES (?, ?, ?, ?)`,
                    name, kind, street ?? null, zip ?? null).lastInsertRowid;
    for (const d of days) run(`INSERT INTO pickup_schedules (community_id, day_of_week) VALUES (?, ?)`, cid, Number(d));
    return cid;
  });
  audit(req, 'community.created', { entityType: 'community', entityId: id, detail: { name } });
  res.status(201).json({ id });
});

router.get('/communities/:id', (req, res) => {
  const community = one('SELECT * FROM communities WHERE id = ?', req.params.id);
  if (!community) return res.status(404).json({ error: 'Community not found.' });
  res.json({
    community,
    schedule: all('SELECT day_of_week FROM pickup_schedules WHERE community_id = ? AND active = 1', community.id)
      .map(r => ({ day: r.day_of_week, name: DAY_NAMES[r.day_of_week] })),
    buildings: all('SELECT * FROM buildings WHERE community_id = ? ORDER BY sort_order, name', community.id),
    units: all(`
      SELECT u.*, b.name AS building_name,
             sa.customer_id, cu.first_name, cu.last_name
        FROM units u
        LEFT JOIN buildings b ON b.id = u.building_id
        LEFT JOIN service_addresses sa ON sa.unit_id = u.id AND sa.end_date IS NULL
        LEFT JOIN customers c ON c.id = sa.customer_id
        LEFT JOIN users cu ON cu.id = c.user_id
       WHERE u.community_id = ? ORDER BY b.sort_order, u.label`, community.id),
  });
});

router.post('/communities/:id/buildings', (req, res) => {
  const { name, sortOrder = 0 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Building name is required.' });
  const id = run(`INSERT INTO buildings (community_id, name, sort_order) VALUES (?, ?, ?)`,
                 req.params.id, name, Number(sortOrder)).lastInsertRowid;
  audit(req, 'building.created', { entityType: 'building', entityId: id });
  res.status(201).json({ id });
});

router.post('/units', (req, res) => {
  const { communityId, buildingId, label, street, zip } = req.body || {};
  if (!label) return res.status(400).json({ error: 'Unit label is required.' });
  if (!communityId && !street) {
    return res.status(400).json({ error: 'A standalone address needs a street.' });
  }
  const id = run(`INSERT INTO units (community_id, building_id, label, street, zip) VALUES (?, ?, ?, ?, ?)`,
                 communityId ?? null, buildingId ?? null, label, street ?? null, zip ?? null).lastInsertRowid;
  audit(req, 'unit.created', { entityType: 'unit', entityId: id, detail: { label } });
  res.status(201).json({ id });
});

/* ---------- Employees ---------- */

router.get('/employees', (req, res) => {
  res.json(all(`
    SELECT e.*, u.first_name, u.last_name, u.email, u.phone, u.status AS user_status, u.last_login_at,
           (SELECT COUNT(*) FROM route_assignments ra
             WHERE ra.employee_id = e.id AND ra.end_date IS NULL) AS active_routes
      FROM employees e JOIN users u ON u.id = e.user_id ORDER BY u.last_name`));
});

router.post('/employees', async (req, res) => {
  const { firstName, lastName, email, phone, password, employeeCode } = req.body || {};
  if (!firstName || !lastName || !email) {
    return res.status(400).json({ error: 'First name, last name, and email are required.' });
  }
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  if (one('SELECT id FROM users WHERE email = ?', email)) {
    return res.status(409).json({ error: 'That email is already in use.' });
  }

  const hash = await hashPassword(password);
  const id = tx(() => {
    const uid = run(`INSERT INTO users (email, password_hash, role, first_name, last_name, phone)
                     VALUES (?, ?, 'employee', ?, ?, ?)`,
                    email, hash, firstName, lastName, phone ?? null).lastInsertRowid;
    return run(`INSERT INTO employees (user_id, employee_code, hire_date)
                VALUES (?, ?, date('now'))`, uid, employeeCode ?? null).lastInsertRowid;
  });
  audit(req, 'employee.created', { entityType: 'employee', entityId: id, detail: { email } });
  res.status(201).json({ id });
});

router.patch('/employees/:id', (req, res) => {
  const e = one('SELECT * FROM employees WHERE id = ?', req.params.id);
  if (!e) return res.status(404).json({ error: 'Employee not found.' });
  const { status, phone, firstName, lastName } = req.body || {};
  tx(() => {
    if (status) {
      run('UPDATE employees SET status = ? WHERE id = ?', status, e.id);
      run(`UPDATE users SET status = ? WHERE id = ?`, status === 'active' ? 'active' : 'deactivated', e.user_id);
    }
    if (phone || firstName || lastName) {
      run(`UPDATE users SET phone = COALESCE(?, phone), first_name = COALESCE(?, first_name),
                            last_name = COALESCE(?, last_name) WHERE id = ?`,
          phone ?? null, firstName ?? null, lastName ?? null, e.user_id);
    }
  });
  audit(req, 'employee.updated', { entityType: 'employee', entityId: e.id, detail: req.body });
  res.json({ ok: true });
});

/* ---------- Routes ---------- */

router.get('/routes', (req, res) => {
  res.json(all(`
    SELECT r.*,
           (SELECT COUNT(*) FROM route_stops rs WHERE rs.route_id = r.id) AS stop_count,
           ra.employee_id, u.first_name, u.last_name
      FROM routes r
      LEFT JOIN route_assignments ra ON ra.route_id = r.id AND ra.end_date IS NULL
      LEFT JOIN employees e ON e.id = ra.employee_id
      LEFT JOIN users u ON u.id = e.user_id
     ORDER BY r.day_of_week, r.name`)
    .map(r => ({ ...r, dayName: DAY_NAMES[r.day_of_week] })));
});

router.post('/routes', (req, res) => {
  const { name, dayOfWeek, stops = [], employeeId } = req.body || {};
  if (!name || dayOfWeek == null) {
    return res.status(400).json({ error: 'Route name and day are required.' });
  }
  const id = tx(() => {
    const rid = run(`INSERT INTO routes (name, day_of_week) VALUES (?, ?)`, name, Number(dayOfWeek)).lastInsertRowid;
    stops.forEach((s, i) =>
      run(`INSERT INTO route_stops (route_id, community_id, unit_id, sort_order) VALUES (?, ?, ?, ?)`,
          rid, s.communityId ?? null, s.unitId ?? null, i));
    if (employeeId) {
      run(`INSERT INTO route_assignments (route_id, employee_id, assigned_by) VALUES (?, ?, ?)`,
          rid, employeeId, req.user.id);
    }
    return rid;
  });
  audit(req, 'route.created', { entityType: 'route', entityId: id, detail: { name } });
  res.status(201).json({ id });
});

router.get('/routes/:id', (req, res) => {
  const route = one('SELECT * FROM routes WHERE id = ?', req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found.' });
  res.json({
    route: { ...route, dayName: DAY_NAMES[route.day_of_week] },
    stops: all(`
      SELECT rs.*, com.name AS community_name, un.label AS unit_label
        FROM route_stops rs
        LEFT JOIN communities com ON com.id = rs.community_id
        LEFT JOIN units un ON un.id = rs.unit_id
       WHERE rs.route_id = ? ORDER BY rs.sort_order`, route.id),
    assignment: one(`
      SELECT ra.*, u.first_name, u.last_name FROM route_assignments ra
        JOIN employees e ON e.id = ra.employee_id JOIN users u ON u.id = e.user_id
       WHERE ra.route_id = ? AND ra.end_date IS NULL`, route.id),
  });
});

/** Drag-and-drop reorder writes the new order here. */
router.put('/routes/:id/stops/order', (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of stop ids.' });
  tx(() => order.forEach((stopId, i) =>
    run('UPDATE route_stops SET sort_order = ? WHERE id = ? AND route_id = ?', i, stopId, req.params.id)));
  audit(req, 'route.stops_reordered', { entityType: 'route', entityId: Number(req.params.id) });
  res.json({ ok: true });
});

/** Reassign a route - ends the current assignment and starts a new one. */
router.post('/routes/:id/assign', (req, res) => {
  const { employeeId, reason, effectiveDate } = req.body || {};
  if (!employeeId) return res.status(400).json({ error: 'employeeId is required.' });
  if (!one('SELECT id FROM employees WHERE id = ? AND status = ?', employeeId, 'active')) {
    return res.status(400).json({ error: 'That employee is not active.' });
  }
  const date = effectiveDate || today();

  tx(() => {
    run(`UPDATE route_assignments SET end_date = ? WHERE route_id = ? AND end_date IS NULL`,
        date, req.params.id);
    run(`INSERT INTO route_assignments (route_id, employee_id, effective_date, assigned_by, reason)
         VALUES (?, ?, ?, ?, ?)`, req.params.id, employeeId, date, req.user.id, reason ?? null);
  });
  audit(req, 'route.reassigned', {
    entityType: 'route', entityId: Number(req.params.id),
    detail: { employeeId, reason, effectiveDate: date },
  });
  res.json({ ok: true });
});

/* ---------- Pickups ---------- */

router.get('/pickups', (req, res) => {
  const date = req.query.date || today();
  generateServiceDay(date);
  res.json({
    stats: serviceDayStats(date),
    stops: all(`
      SELECT ss.*, un.label AS unit_label, com.name AS community_name,
             cu.first_name, cu.last_name,
             r.name AS route_name,
             pr.id AS record_id, pr.status AS record_status, pr.issue_code,
             pr.notes, pr.completed_at,
             eu.first_name AS emp_first, eu.last_name AS emp_last,
             (SELECT COUNT(*) FROM pickup_photos ph WHERE ph.pickup_record_id = pr.id) AS photo_count
        FROM service_stops ss
        JOIN units un ON un.id = ss.unit_id
        LEFT JOIN communities com ON com.id = un.community_id
        LEFT JOIN customers c ON c.id = ss.customer_id
        LEFT JOIN users cu ON cu.id = c.user_id
        LEFT JOIN routes r ON r.id = ss.route_id
        LEFT JOIN pickup_records pr ON pr.service_stop_id = ss.id
        LEFT JOIN employees e ON e.id = pr.employee_id
        LEFT JOIN users eu ON eu.id = e.user_id
       WHERE ss.service_date = ?
       ORDER BY com.name, un.label`, date),
  });
});

router.get('/pickups/issues', (req, res) => {
  res.json(all(`
    SELECT pr.*, un.label AS unit_label, com.name AS community_name,
           cu.first_name, cu.last_name, eu.first_name AS emp_first, eu.last_name AS emp_last,
           (SELECT COUNT(*) FROM pickup_photos ph WHERE ph.pickup_record_id = pr.id) AS photo_count
      FROM pickup_records pr
      JOIN units un ON un.id = pr.unit_id
      LEFT JOIN communities com ON com.id = un.community_id
      LEFT JOIN customers c ON c.id = pr.customer_id
      LEFT JOIN users cu ON cu.id = c.user_id
      LEFT JOIN employees e ON e.id = pr.employee_id
      LEFT JOIN users eu ON eu.id = e.user_id
     WHERE pr.status = 'issue'
     ORDER BY pr.service_date DESC, pr.completed_at DESC LIMIT 200`));
});

/* ---------- Payments ---------- */

router.get('/payments', (req, res) => {
  const { status, limit = 200 } = req.query;
  res.json(all(`
    SELECT p.*, u.first_name, u.last_name, u.email, pl.code AS plan_code, c.is_intro
      FROM payments p
      JOIN customers c ON c.id = p.customer_id
      JOIN users u ON u.id = c.user_id
      LEFT JOIN subscriptions s ON s.id = p.subscription_id
      LEFT JOIN plans pl ON pl.id = s.plan_id
     ${status ? 'WHERE p.status = ?' : ''}
     ORDER BY p.created_at DESC LIMIT ?`,
    ...(status ? [status] : []), Number(limit))
    // `demo` is derived from provider, not stored separately - one fact, one place.
    .map(p => ({ ...p, demo: p.provider === 'demo' })));
});

/* ---------- Audit ---------- */

router.get('/audit', (req, res) => {
  res.json(all(`
    SELECT a.*, u.first_name, u.last_name, u.email
      FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
     ORDER BY a.created_at DESC LIMIT ?`, Number(req.query.limit || 200)));
});
