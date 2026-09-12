import { Router } from 'express';
import { one, all, run, tx } from '../db/index.js';
import { requireRole, requireEmployee, employeeMayServiceUnit } from '../lib/rbac.js';
import { audit } from '../lib/audit.js';
import { storage, uploadProblem, MAX_BYTES } from '../lib/storage.js';
import { generateServiceDay, today, DAY_NAMES } from '../lib/schedule.js';
import { setting } from '../lib/permissions.js';
import { clockIn, clockOut, openShift, shiftsFor, entryPayCents,
         currentPayPeriod, rateOn, MINUTES_SQL } from '../lib/timeclock.js';

export const router = Router();
router.use(requireRole('employee'), requireEmployee);

const ISSUE_CODES = [
  'no_trash_outside','unable_to_access','not_properly_bagged','oversized_item',
  'restricted_item','customer_not_home','incorrect_address','blocked_access',
  'animal_safety','property_issue','service_problem','customer_not_found','other',
];

/** Routes assigned to THIS employee on a date. Never takes an id from the URL. */
function myRoutes(employeeId, date) {
  return all(`
    SELECT r.* FROM routes r
      JOIN route_assignments ra ON ra.route_id = r.id
     WHERE ra.employee_id = ?
       AND r.day_of_week = ?
       AND r.status = 'active'
       AND ra.effective_date <= ?
       AND (ra.end_date IS NULL OR ra.end_date >= ?)`,
    employeeId, new Date(`${date}T12:00:00`).getDay(), date, date);
}

/* ---------- Today's route ---------- */

router.get('/today', (req, res) => {
  const date = req.query.date || today();
  generateServiceDay(date);

  const routes = myRoutes(req.employee.id, date);
  const routeIds = routes.map(r => r.id);

  if (!routeIds.length) {
    return res.json({ date, dayName: DAY_NAMES[new Date(`${date}T12:00:00`).getDay()],
                      routes: [], communities: [], progress: { done: 0, total: 0 } });
  }

  const placeholders = routeIds.map(() => '?').join(',');

  // Grouped by community so the phone screen shows stops, not 40 units.
  const groups = all(`
    SELECT COALESCE(com.id, -un.id)                      AS group_id,
           COALESCE(com.name, un.label)                  AS group_name,
           COALESCE(com.street, un.street)               AS street_line,
           COUNT(*)                                      AS total,
           SUM(CASE WHEN ss.status != 'pending' THEN 1 ELSE 0 END) AS done
      FROM service_stops ss
      JOIN units un ON un.id = ss.unit_id
      LEFT JOIN communities com ON com.id = un.community_id
     WHERE ss.service_date = ? AND ss.route_id IN (${placeholders})
     GROUP BY COALESCE(com.id, -un.id), COALESCE(com.name, un.label), COALESCE(com.street, un.street)
     ORDER BY group_name`, date, ...routeIds);

  const progress = groups.reduce((a, g) => ({ done: a.done + g.done, total: a.total + g.total }),
                                 { done: 0, total: 0 });

  res.json({
    date,
    dayName: DAY_NAMES[new Date(`${date}T12:00:00`).getDay()],
    routes: routes.map(r => ({ id: r.id, name: r.name })),
    communities: groups.map(g => ({ ...g, street: g.street_line, remaining: g.total - g.done })),
    progress,
  });
});

/** The unit checklist inside one community (or a standalone address). */
router.get('/stops', (req, res) => {
  const date = req.query.date || today();
  const groupId = Number(req.query.groupId);
  const routeIds = myRoutes(req.employee.id, date).map(r => r.id);
  if (!routeIds.length) return res.json({ units: [] });

  const placeholders = routeIds.map(() => '?').join(',');
  const scope = groupId > 0 ? 'un.community_id = ?' : 'un.id = ?';
  const scopeValue = groupId > 0 ? groupId : -groupId;

  const units = all(`
      SELECT ss.id AS stop_id, ss.status, ss.customer_id, un.id AS unit_id, un.label,
             b.name AS building, b.sort_order AS building_order,
             cu.first_name, cu.last_name,
             pr.id AS record_id, pr.status AS record_status, pr.issue_code, pr.notes, pr.completed_at
        FROM service_stops ss
        JOIN units un ON un.id = ss.unit_id
        LEFT JOIN buildings b ON b.id = un.building_id
        LEFT JOIN customers c ON c.id = ss.customer_id
        LEFT JOIN users cu ON cu.id = c.user_id
        LEFT JOIN pickup_records pr ON pr.service_stop_id = ss.id
       WHERE ss.service_date = ? AND ss.route_id IN (${placeholders}) AND ${scope}
       ORDER BY b.sort_order, un.label`, date, ...routeIds, scopeValue);

  // Group by building so a 52-unit property reads as a set of short lists.
  const buildings = [];
  for (const u of units) {
    const name = u.building || 'Addresses';
    let group = buildings.find(g => g.name === name);
    if (!group) { group = { name, units: [], done: 0 }; buildings.push(group); }
    group.units.push(u);
    if (u.status !== 'pending') group.done++;
  }

  res.json({
    date,
    units,
    buildings: buildings.map(b => ({ ...b, total: b.units.length, remaining: b.units.length - b.done })),
    progress: {
      done: units.filter(u => u.status !== 'pending').length,
      total: units.length,
    },
    requirePhoto: setting('pickup.require_photo', 1) === 1,
  });
});

/* ---------- Recording a pickup ---------- */

/**
 * Body: { unitId, status: 'completed'|'issue', issueCode?, notes?, photo? }
 * photo: { dataUrl, mimeType } - base64 from the phone camera.
 */
router.post('/pickups', async (req, res) => {
  const date = req.body?.serviceDate || today();
  const { unitId, status, issueCode, notes, photo, noteVisibleToCustomer } = req.body || {};

  if (!unitId || !['completed', 'issue'].includes(status)) {
    return res.status(400).json({ error: 'unitId and a valid status are required.' });
  }
  if (status === 'issue' && !ISSUE_CODES.includes(issueCode)) {
    return res.status(400).json({ error: 'Choose a reason for the issue.' });
  }

  /* Photo verification. A completed pickup is a claim that work was done,
     so it needs evidence. Both requirements are settings, not constants,
     so the rule can be relaxed without a code change. */
  const needPhoto = status === 'completed'
    ? setting('pickup.require_photo', 1) === 1
    : setting('pickup.require_issue_photo', 0) === 1;

  if (needPhoto && !photo?.dataUrl) {
    return res.status(400).json({
      error: status === 'completed'
        ? 'A photo is required to mark a pickup completed.'
        : 'A photo is required for this issue report.',
      code: 'PHOTO_REQUIRED',
    });
  }

  // THE ownership check: is this stop actually on this employee's route today?
  if (!employeeMayServiceUnit(req.employee.id, unitId, date)) {
    return res.status(403).json({ error: 'That stop is not on your route today.' });
  }

  const stop = one('SELECT * FROM service_stops WHERE service_date = ? AND unit_id = ?', date, unitId);
  if (!stop) return res.status(404).json({ error: 'Stop not found for that date.' });

  // Decode the photo before opening a transaction - file IO is async and
  // node:sqlite transactions are synchronous.
  let stored = null;
  if (photo?.dataUrl) {
    const base64 = String(photo.dataUrl).split(',').pop();
    const buffer = Buffer.from(base64, 'base64');
    const mimeType = photo.mimeType || 'image/jpeg';
    const problem = uploadProblem({ mimeType, bytes: buffer.length });
    if (problem) return res.status(400).json({ error: problem });
    try {
      stored = { key: await storage.put(buffer, { mimeType }), mimeType, bytes: buffer.length };
    } catch (err) {
      console.error('[employee] photo store failed', err);
      return res.status(500).json({ error: 'The photo could not be saved. Please try again.' });
    }
  }

  const recordId = tx(() => {
    const id = run(`
      INSERT INTO pickup_records
        (service_stop_id, service_date, unit_id, customer_id, employee_id, route_id,
         status, issue_code, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      stop.id, date, unitId, stop.customer_id, req.employee.id, stop.route_id,
      status, status === 'issue' ? issueCode : null, notes ?? null).lastInsertRowid;

    run('UPDATE service_stops SET status = ? WHERE id = ?',
        status === 'completed' ? 'completed' : 'issue', stop.id);

    if (stored) {
      run(`INSERT INTO pickup_photos (pickup_record_id, storage_key, mime_type, bytes, uploaded_by)
           VALUES (?, ?, ?, ?, ?)`, id, stored.key, stored.mimeType, stored.bytes, req.user.id);
    }
    return id;
  });

  // An employee note is internal by default; it reaches the customer only
  // when explicitly marked visible.
  if (notes && noteVisibleToCustomer && stop.customer_id) {
    run(`INSERT INTO customer_notes (customer_id, unit_id, author_user_id, body, visible_to_customer)
         VALUES (?, ?, ?, ?, 1)`, stop.customer_id, unitId, req.user.id, notes);
  }

  audit(req, 'pickup.recorded', {
    entityType: 'pickup_record', entityId: recordId,
    detail: { unitId, status, issueCode: issueCode ?? null, hasPhoto: Boolean(stored),
              noteShared: Boolean(notes && noteVisibleToCustomer) },
  });

  res.status(201).json({ ok: true, recordId, photoSaved: Boolean(stored) });
});

router.get('/completed', (req, res) => {
  res.json(all(`
    SELECT pr.*, un.label, com.name AS community_name,
           (SELECT COUNT(*) FROM pickup_photos ph WHERE ph.pickup_record_id = pr.id) AS photo_count
      FROM pickup_records pr
      JOIN units un ON un.id = pr.unit_id
      LEFT JOIN communities com ON com.id = un.community_id
     WHERE pr.employee_id = ?
     ORDER BY pr.service_date DESC, pr.completed_at DESC LIMIT 100`, req.employee.id));
});

router.get('/issues', (req, res) => {
  res.json(all(`
    SELECT pr.*, un.label, com.name AS community_name
      FROM pickup_records pr
      JOIN units un ON un.id = pr.unit_id
      LEFT JOIN communities com ON com.id = un.community_id
     WHERE pr.employee_id = ? AND pr.status = 'issue'
     ORDER BY pr.service_date DESC LIMIT 100`, req.employee.id));
});

router.get('/profile', (req, res) => {
  res.json({
    employee: req.employee,
    user: { firstName: req.user.first_name, lastName: req.user.last_name,
            email: req.user.email, phone: req.user.phone },
    routes: all(`
      SELECT r.id, r.name, r.day_of_week FROM routes r
        JOIN route_assignments ra ON ra.route_id = r.id
       WHERE ra.employee_id = ? AND ra.end_date IS NULL
       ORDER BY r.day_of_week`, req.employee.id)
      .map(r => ({ ...r, dayName: DAY_NAMES[r.day_of_week] })),
    maxPhotoBytes: MAX_BYTES,
  });
});


/* ============================================================
   Time clock

   An employee sees ONLY their own hours and their own estimated pay.
   Nothing here exposes another employee's rate, company revenue,
   expenses, or profit.
   ============================================================ */

router.get('/shift', (req, res) => {
  const open = openShift(req.employee.id);
  const period = currentPayPeriod();
  const rate = rateOn(req.employee.id, today());

  const totals = one(
    `SELECT COALESCE(SUM(CASE WHEN clock_out_at IS NOT NULL THEN ${MINUTES_SQL} ELSE 0 END),0) AS minutes,
            COUNT(CASE WHEN clock_out_at IS NOT NULL THEN 1 END) AS shifts
       FROM time_entries
      WHERE employee_id = ? AND work_date BETWEEN ? AND ?`,
    req.employee.id, period.start, period.end);

  const entries = all(
    `SELECT *, ${MINUTES_SQL} AS minutes FROM time_entries
      WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND clock_out_at IS NOT NULL`,
    req.employee.id, period.start, period.end);
  const periodPayCents = entries.reduce((a, e) => a + entryPayCents(e), 0);

  res.json({
    openShift: open ? { id: open.id, clockInAt: open.clock_in_at, minutes: open.minutes } : null,
    payPeriod: {
      ...period,
      minutes: totals.minutes,
      hours: Math.round(totals.minutes / 6) / 10,
      shifts: totals.shifts,
      estimatedPayCents: periodPayCents,
    },
    compensation: { payType: rate.pay_type, rateCents: rate.rate_cents },
  });
});

router.post('/clock-in', (req, res) => {
  const { routeId, lat, lng } = req.body || {};
  try {
    const entry = clockIn(req.employee.id, {
      routeId, lat, lng, device: req.headers['user-agent']?.slice(0, 200),
    });
    audit(req, 'timeclock.clock_in', {
      entityType: 'time_entry', entityId: entry.id,
      detail: { routeId: routeId ?? null, hasGps: Boolean(lat && lng) },
    });
    res.status(201).json({ ok: true, clockInAt: entry.clock_in_at });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/clock-out', (req, res) => {
  const { breakMinutes, lat, lng, note } = req.body || {};
  try {
    const entry = clockOut(req.employee.id, { breakMinutes, lat, lng, note });
    audit(req, 'timeclock.clock_out', {
      entityType: 'time_entry', entityId: entry.id,
      detail: { minutes: entry.minutes, breakMinutes: entry.break_minutes },
    });
    res.json({
      ok: true,
      clockOutAt: entry.clock_out_at,
      minutes: entry.minutes,
      payCents: entryPayCents(entry),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.get('/shifts', (req, res) => {
  res.json(shiftsFor(req.employee.id, Number(req.query.limit) || 30));
});
