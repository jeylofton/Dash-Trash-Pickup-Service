/* ============================================================
   Roles & permissions, and full route management.

   Two rules run through everything here:
     1. Permissions are enforced server-side; hiding a control is
        never the security boundary.
     2. Editing current configuration must not rewrite history —
        route changes are versioned by effective date.
   ============================================================ */

import { Router } from 'express';
import { one, all, run, tx } from '../db/index.js';
import { requirePermission, permissionsFor } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';
import { DAY_NAMES, today } from '../lib/schedule.js';
import { deletability, assertDeletable } from '../lib/deletable.js';

export const router = Router();

const SYSTEM_ROLES = ['admin', 'manager', 'employee', 'customer'];
const ROUTE_STATUS = ['draft', 'scheduled', 'active', 'on_hold', 'inactive', 'archived'];

const diff = (before, after) => {
  const out = {};
  for (const k of Object.keys(after)) {
    if (after[k] !== undefined && String(before[k] ?? '') !== String(after[k] ?? '')) {
      out[k] = { from: before[k] ?? null, to: after[k] };
    }
  }
  return out;
};

/* ============================================================
   Roles
   ============================================================ */

/** The permission catalog, grouped for a checkbox UI. */
router.get('/permissions', requirePermission('system.roles.manage', 'system.permissions.manage'), (req, res) => {
  const perms = all('SELECT * FROM permissions ORDER BY sort_order');
  const categories = [];
  for (const p of perms) {
    let c = categories.find(x => x.name === p.category);
    if (!c) { c = { name: p.category, permissions: [] }; categories.push(c); }
    c.permissions.push({ key: p.key, label: p.label });
  }
  res.json({ categories, total: perms.length });
});

router.get('/', requirePermission('system.roles.manage'), (req, res) => {
  res.json(all('SELECT * FROM roles ORDER BY is_system DESC, name').map(r => ({
    ...r,
    isSystem: Boolean(r.is_system),
    permissionCount: one(`SELECT COUNT(*) AS n FROM role_permissions
                           WHERE role_key = ? AND allowed = 1`, r.key).n,
    userCount: one(`SELECT COUNT(*) AS n FROM users WHERE role = ?`, r.key).n,
    // Admin holds everything implicitly.
    grantsEverything: r.key === 'admin',
  })));
});

router.get('/:key', requirePermission('system.roles.manage'), (req, res) => {
  const role = one('SELECT * FROM roles WHERE key = ?', req.params.key);
  if (!role) return res.status(404).json({ error: 'Role not found.' });
  res.json({
    role: { ...role, isSystem: Boolean(role.is_system), grantsEverything: role.key === 'admin' },
    permissions: Object.fromEntries(
      all('SELECT permission, allowed FROM role_permissions WHERE role_key = ?', role.key)
        .map(r => [r.permission, Boolean(r.allowed)])),
    users: all(`SELECT id, first_name, last_name, email FROM users WHERE role = ?`, role.key),
  });
});

router.post('/', requirePermission('system.roles.manage'), (req, res) => {
  const { key, name, description, permissions = [], copyFrom } = req.body || {};
  const roleKey = String(key || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
  if (!roleKey || !name) return res.status(400).json({ error: 'A key and a name are required.' });
  if (one('SELECT id FROM roles WHERE key = ?', roleKey)) {
    return res.status(409).json({ error: 'A role with that key already exists.' });
  }

  const id = tx(() => {
    const rid = run(`INSERT INTO roles (key, name, description, is_system, created_by)
                     VALUES (?, ?, ?, 0, ?)`, roleKey, name, description ?? null, req.user.id).lastInsertRowid;

    // Duplicating an existing role copies its grants as a starting point.
    const source = copyFrom
      ? all('SELECT permission FROM role_permissions WHERE role_key = ? AND allowed = 1', copyFrom)
          .map(r => r.permission)
      : permissions;

    for (const p of source) {
      if (!one('SELECT key FROM permissions WHERE key = ?', p)) continue;  // ignore unknown keys
      run(`INSERT OR IGNORE INTO role_permissions (role_key, permission, allowed) VALUES (?, ?, 1)`,
          roleKey, p);
    }
    return rid;
  });

  audit(req, 'role.created', {
    entityType: 'role', entityId: id,
    detail: { key: roleKey, name, copiedFrom: copyFrom ?? null,
              permissionCount: one(`SELECT COUNT(*) AS n FROM role_permissions
                                     WHERE role_key = ? AND allowed = 1`, roleKey).n },
  });
  res.status(201).json({ id, key: roleKey });
});

router.patch('/:key', requirePermission('system.roles.manage'), (req, res) => {
  const role = one('SELECT * FROM roles WHERE key = ?', req.params.key);
  if (!role) return res.status(404).json({ error: 'Role not found.' });
  if (role.key === 'admin') {
    return res.status(400).json({ error: 'The Admin role cannot be modified.' });
  }
  const { name, description, status } = req.body || {};
  if (status && role.is_system && status !== 'active') {
    return res.status(400).json({ error: 'A built-in role cannot be deactivated or archived.' });
  }
  if (status && !['active', 'inactive', 'archived'].includes(status)) {
    return res.status(400).json({ error: 'Unknown status.' });
  }
  if (status && status !== 'active') {
    const inUse = one('SELECT COUNT(*) AS n FROM users WHERE role = ?', role.key).n;
    if (inUse) {
      return res.status(409).json({
        error: `${inUse} user(s) still hold this role. Reassign them first.`,
      });
    }
  }

  const changes = diff({ name: role.name, description: role.description, status: role.status },
                       { name, description, status });
  run(`UPDATE roles SET name = COALESCE(?, name), description = COALESCE(?, description),
                        status = COALESCE(?, status) WHERE key = ?`,
      name ?? null, description ?? null, status ?? null, role.key);

  audit(req, 'role.updated', { entityType: 'role', entityId: role.id,
                               detail: { key: role.key, changes } });
  res.json({ ok: true, changes });
});

/** Set the whole permission set for a role in one call. */
router.put('/:key/permissions', requirePermission('system.permissions.manage'), (req, res) => {
  const role = one('SELECT * FROM roles WHERE key = ?', req.params.key);
  if (!role) return res.status(404).json({ error: 'Role not found.' });
  if (role.key === 'admin') {
    return res.status(400).json({ error: 'Admin permissions cannot be restricted.' });
  }
  const wanted = new Set(req.body?.permissions || []);

  const before = new Set(all(`SELECT permission FROM role_permissions
                               WHERE role_key = ? AND allowed = 1`, role.key).map(r => r.permission));
  const catalog = all('SELECT key FROM permissions').map(p => p.key);

  tx(() => {
    for (const key of catalog) {
      const allow = wanted.has(key) ? 1 : 0;
      run(`INSERT INTO role_permissions (role_key, permission, allowed) VALUES (?, ?, ?)
           ON CONFLICT(role_key, permission) DO UPDATE SET allowed = excluded.allowed`,
          role.key, key, allow);
    }
  });

  const added = [...wanted].filter(p => !before.has(p));
  const removed = [...before].filter(p => !wanted.has(p));
  audit(req, 'role.permissions_changed', {
    entityType: 'role', entityId: role.id,
    detail: { key: role.key, added, removed },
  });
  res.json({ ok: true, added, removed });
});

/** What the signed-in user may do — the UI renders from this. */
router.get('/me/permissions', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  res.json(permissionsFor(req.user));
});

/* ============================================================
   Route management
   ============================================================ */

function currentDriver(routeId, onDate = today()) {
  return one(`SELECT ra.employee_id, u.first_name, u.last_name
                FROM route_assignments ra
                JOIN employees e ON e.id = ra.employee_id
                JOIN users u ON u.id = e.user_id
               WHERE ra.route_id = ? AND ra.effective_date <= ?
                 AND (ra.end_date IS NULL OR ra.end_date >= ?)
               ORDER BY ra.effective_date DESC LIMIT 1`, routeId, onDate, onDate);
}

/** Record a new version whenever the configuration meaningfully changes. */
function recordVersion(route, { changes, effectiveDate, userId, note, driverId }) {
  run(`UPDATE route_versions SET end_date = date(?, '-1 day')
        WHERE route_id = ? AND end_date IS NULL`, effectiveDate, route.id);
  run(`INSERT INTO route_versions
         (route_id, name, description, day_of_week, start_time, estimated_end_time,
          service_area, status, driver_employee_id, notes, effective_date, changed_by,
          change_note, changes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      route.id, route.name, route.description, route.day_of_week, route.start_time,
      route.estimated_end_time, route.service_area, route.status,
      driverId ?? currentDriver(route.id)?.employee_id ?? null, route.notes,
      effectiveDate, userId, note ?? null, JSON.stringify(changes));
}

router.get('/routes/all', requirePermission('routes.view'), (req, res) => {
  const { status } = req.query;
  res.json(all(`
    SELECT r.*,
           (SELECT COUNT(*) FROM route_stops rs WHERE rs.route_id = r.id) AS stop_count,
           (SELECT COUNT(*) FROM route_versions v WHERE v.route_id = r.id) AS version_count
      FROM routes r
     ${status ? 'WHERE r.status = ?' : "WHERE r.status != 'archived'"}
     ORDER BY r.day_of_week, r.name`, ...(status ? [status] : []))
    .map(r => {
      const d = currentDriver(r.id);
      return { ...r, dayName: DAY_NAMES[r.day_of_week],
               driver: d ? { id: d.employee_id, name: `${d.first_name} ${d.last_name}` } : null };
    }));
});

router.get('/routes/:id', requirePermission('routes.view'), (req, res) => {
  const route = one('SELECT * FROM routes WHERE id = ?', req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found.' });
  const d = currentDriver(route.id);

  res.json({
    route: { ...route, dayName: DAY_NAMES[route.day_of_week] },
    driver: d ? { id: d.employee_id, name: `${d.first_name} ${d.last_name}` } : null,
    stops: all(`SELECT rs.*, com.name AS community_name, com.status AS community_status,
                       un.label AS unit_label
                  FROM route_stops rs
                  LEFT JOIN communities com ON com.id = rs.community_id
                  LEFT JOIN units un ON un.id = rs.unit_id
                 WHERE rs.route_id = ? ORDER BY rs.sort_order`, route.id),
    crew: all(`SELECT rc.*, u.first_name, u.last_name FROM route_crew rc
                 JOIN employees e ON e.id = rc.employee_id
                 JOIN users u ON u.id = e.user_id
                WHERE rc.route_id = ? AND rc.end_date IS NULL`, route.id),
    assignments: all(`SELECT ra.*, u.first_name, u.last_name FROM route_assignments ra
                        JOIN employees e ON e.id = ra.employee_id
                        JOIN users u ON u.id = e.user_id
                       WHERE ra.route_id = ? ORDER BY ra.effective_date DESC`, route.id),
    versions: all(`SELECT v.*, u.first_name, u.last_name,
                          du.first_name AS driver_first, du.last_name AS driver_last
                     FROM route_versions v
                     LEFT JOIN users u ON u.id = v.changed_by
                     LEFT JOIN employees de ON de.id = v.driver_employee_id
                     LEFT JOIN users du ON du.id = de.user_id
                    WHERE v.route_id = ? ORDER BY v.effective_date DESC, v.id DESC`, route.id)
      .map(v => ({ ...v, changes: v.changes ? JSON.parse(v.changes) : null,
                   dayName: v.day_of_week != null ? DAY_NAMES[v.day_of_week] : null })),
    serviceHistory: one(`SELECT COUNT(*) AS pickups,
                                MIN(service_date) AS first_date,
                                MAX(service_date) AS last_date
                           FROM pickup_records WHERE route_id = ?`, route.id),
  });
});

router.post('/routes', requirePermission('routes.create'), (req, res) => {
  const b = req.body || {};
  if (!b.name || b.dayOfWeek == null) {
    return res.status(400).json({ error: 'A route name and service day are required.' });
  }
  const status = ROUTE_STATUS.includes(b.status) ? b.status : 'draft';
  const effective = b.effectiveDate || today();

  const id = tx(() => {
    const rid = run(
      `INSERT INTO routes (name, description, day_of_week, start_time, estimated_end_time,
                           service_area, status, effective_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.name, b.description ?? null, Number(b.dayOfWeek), b.startTime ?? null,
      b.estimatedEndTime ?? null, b.serviceArea ?? null, status, effective, b.notes ?? null
    ).lastInsertRowid;

    (b.stops || []).forEach((s, i) =>
      run(`INSERT INTO route_stops (route_id, community_id, unit_id, sort_order) VALUES (?, ?, ?, ?)`,
          rid, s.communityId ?? null, s.unitId ?? null, i));

    if (b.driverEmployeeId) {
      run(`INSERT INTO route_assignments (route_id, employee_id, effective_date, assigned_by)
           VALUES (?, ?, ?, ?)`, rid, b.driverEmployeeId, effective, req.user.id);
    }

    const route = one('SELECT * FROM routes WHERE id = ?', rid);
    recordVersion(route, { changes: {}, effectiveDate: effective, userId: req.user.id,
                           note: 'Route created', driverId: b.driverEmployeeId ?? null });
    return rid;
  });

  audit(req, 'route.created', { entityType: 'route', entityId: id,
                                detail: { name: b.name, status, effectiveDate: effective } });
  res.status(201).json({ id, status });
});

/** Duplicate a route, including stops. The copy starts as a draft. */
router.post('/routes/:id/duplicate', requirePermission('routes.create'), (req, res) => {
  const src = one('SELECT * FROM routes WHERE id = ?', req.params.id);
  if (!src) return res.status(404).json({ error: 'Route not found.' });
  const { name, dayOfWeek } = req.body || {};

  const id = tx(() => {
    const rid = run(
      `INSERT INTO routes (name, description, day_of_week, start_time, estimated_end_time,
                           service_area, status, effective_date, notes)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', date('now'), ?)`,
      name || `${src.name} (copy)`, src.description,
      dayOfWeek != null ? Number(dayOfWeek) : src.day_of_week,
      src.start_time, src.estimated_end_time, src.service_area, src.notes).lastInsertRowid;

    for (const s of all('SELECT * FROM route_stops WHERE route_id = ? ORDER BY sort_order', src.id)) {
      run(`INSERT INTO route_stops (route_id, community_id, unit_id, sort_order) VALUES (?, ?, ?, ?)`,
          rid, s.community_id, s.unit_id, s.sort_order);
    }
    const route = one('SELECT * FROM routes WHERE id = ?', rid);
    recordVersion(route, { changes: {}, effectiveDate: today(), userId: req.user.id,
                           note: `Duplicated from route ${src.id}` });
    return rid;
  });

  audit(req, 'route.duplicated', { entityType: 'route', entityId: id,
                                   detail: { from: src.name, to: name || `${src.name} (copy)` } });
  res.status(201).json({ id });
});

/**
 * Edit a route. Changes take effect on `effectiveDate` (default today)
 * and the previous configuration is closed off, never overwritten.
 */
router.patch('/routes/:id', requirePermission('routes.edit'), (req, res) => {
  const route = one('SELECT * FROM routes WHERE id = ?', req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found.' });
  const b = req.body || {};
  if (b.status && !ROUTE_STATUS.includes(b.status)) {
    return res.status(400).json({ error: `Status must be one of: ${ROUTE_STATUS.join(', ')}.` });
  }
  const effective = b.effectiveDate || today();

  const changes = diff(
    { name: route.name, description: route.description, day_of_week: route.day_of_week,
      start_time: route.start_time, estimated_end_time: route.estimated_end_time,
      service_area: route.service_area, status: route.status, notes: route.notes },
    { name: b.name, description: b.description, day_of_week: b.dayOfWeek,
      start_time: b.startTime, estimated_end_time: b.estimatedEndTime,
      service_area: b.serviceArea, status: b.status, notes: b.notes });

  let driverChange = null;
  if (b.driverEmployeeId !== undefined) {
    const current = currentDriver(route.id, effective);
    if (Number(b.driverEmployeeId) !== (current?.employee_id ?? null)) {
      // Store NAMES in the change log; an employee id means nothing to a reader.
      const next = one(`SELECT u.first_name, u.last_name FROM employees e
                          JOIN users u ON u.id = e.user_id WHERE e.id = ?`, b.driverEmployeeId);
      driverChange = {
        from: current ? `${current.first_name} ${current.last_name}` : null,
        to: next ? `${next.first_name} ${next.last_name}` : String(b.driverEmployeeId),
      };
    }
  }

  if (!Object.keys(changes).length && !driverChange) {
    return res.json({ ok: true, changes: {}, message: 'Nothing changed.' });
  }

  tx(() => {
    run(`UPDATE routes SET name = COALESCE(?, name), description = COALESCE(?, description),
                           day_of_week = COALESCE(?, day_of_week),
                           start_time = COALESCE(?, start_time),
                           estimated_end_time = COALESCE(?, estimated_end_time),
                           service_area = COALESCE(?, service_area),
                           status = COALESCE(?, status), notes = COALESCE(?, notes),
                           effective_date = ?
          WHERE id = ?`,
        b.name ?? null, b.description ?? null, b.dayOfWeek ?? null, b.startTime ?? null,
        b.estimatedEndTime ?? null, b.serviceArea ?? null, b.status ?? null, b.notes ?? null,
        effective, route.id);

    if (driverChange) {
      // End the old assignment the day before the new one begins, so the
      // record of who drove it before this date is untouched.
      run(`UPDATE route_assignments SET end_date = date(?, '-1 day')
            WHERE route_id = ? AND end_date IS NULL`, effective, route.id);
      run(`INSERT INTO route_assignments (route_id, employee_id, effective_date, assigned_by, reason)
           VALUES (?, ?, ?, ?, ?)`,
          route.id, b.driverEmployeeId, effective, req.user.id, b.changeNote ?? 'Route edit');
    }

    const updated = one('SELECT * FROM routes WHERE id = ?', route.id);
    recordVersion(updated, {
      changes: { ...changes, ...(driverChange ? { driver: driverChange } : {}) },
      effectiveDate: effective, userId: req.user.id, note: b.changeNote ?? null,
      driverId: b.driverEmployeeId ?? currentDriver(route.id, effective)?.employee_id ?? null,
    });
  });

  audit(req, 'route.updated', {
    entityType: 'route', entityId: route.id,
    detail: { name: route.name, changes: { ...changes, ...(driverChange ? { driver: driverChange } : {}) },
              effectiveDate: effective },
  });
  // Report the driver reassignment too — it is the change most often made.
  res.json({ ok: true, effectiveDate: effective,
             changes: { ...changes, ...(driverChange ? { driver: driverChange } : {}) } });
});

/** Archive rather than delete. Deletion is only for a route never used. */
router.post('/routes/:id/archive', requirePermission('routes.archive'), (req, res) => {
  const route = one('SELECT * FROM routes WHERE id = ?', req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found.' });

  const history = one(`SELECT COUNT(*) AS n FROM pickup_records WHERE route_id = ?`, route.id).n;
  tx(() => {
    run(`UPDATE routes SET status='archived' WHERE id = ?`, route.id);
    run(`UPDATE route_assignments SET end_date = date('now')
          WHERE route_id = ? AND end_date IS NULL`, route.id);
    recordVersion({ ...route, status: 'archived' }, {
      changes: { status: { from: route.status, to: 'archived' } },
      effectiveDate: today(), userId: req.user.id, note: req.body?.note ?? 'Route archived',
    });
  });

  audit(req, 'route.archived', { entityType: 'route', entityId: route.id,
                                 detail: { name: route.name, pickupRecordsPreserved: history } });
  res.json({ ok: true, pickupRecordsPreserved: history,
             message: `Route archived. ${history} pickup record(s) remain in history.` });
});

router.post('/routes/:id/restore', requirePermission('routes.archive'), (req, res) => {
  const route = one('SELECT * FROM routes WHERE id = ?', req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found.' });
  run(`UPDATE routes SET status = 'inactive' WHERE id = ?`, route.id);
  audit(req, 'route.restored', { entityType: 'route', entityId: route.id,
                                 detail: { name: route.name, to: 'inactive' } });
  res.json({ ok: true, status: 'inactive' });
});

/** Reorder stops — drag and drop writes here. */
router.put('/routes/:id/stops/order', requirePermission('routes.communities.edit'), (req, res) => {
  const { order } = req.body || {};
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array of stop ids.' });
  tx(() => order.forEach((stopId, i) =>
    run('UPDATE route_stops SET sort_order = ? WHERE id = ? AND route_id = ?', i, stopId, req.params.id)));
  audit(req, 'route.stops_reordered', { entityType: 'route', entityId: Number(req.params.id),
                                        detail: { count: order.length } });
  res.json({ ok: true });
});

router.post('/routes/:id/stops', requirePermission('routes.communities.edit'), (req, res) => {
  const { communityId, unitId } = req.body || {};
  if (!communityId && !unitId) return res.status(400).json({ error: 'A community or unit is required.' });
  const next = one('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM route_stops WHERE route_id = ?',
                   req.params.id).n;
  const id = run(`INSERT INTO route_stops (route_id, community_id, unit_id, sort_order)
                  VALUES (?, ?, ?, ?)`, req.params.id, communityId ?? null, unitId ?? null, next).lastInsertRowid;
  audit(req, 'route.stop_added', { entityType: 'route', entityId: Number(req.params.id),
                                   detail: { communityId: communityId ?? null, unitId: unitId ?? null } });
  res.status(201).json({ id });
});

router.delete('/routes/:id/stops/:stopId', requirePermission('routes.communities.edit'), (req, res) => {
  const stop = one('SELECT * FROM route_stops WHERE id = ? AND route_id = ?',
                   req.params.stopId, req.params.id);
  if (!stop) return res.status(404).json({ error: 'Stop not found.' });
  run('DELETE FROM route_stops WHERE id = ?', stop.id);
  audit(req, 'route.stop_removed', { entityType: 'route', entityId: Number(req.params.id),
                                     detail: { communityId: stop.community_id, unitId: stop.unit_id } });
  res.json({ ok: true });
});

/** Additional crew beyond the primary driver. */
router.post('/routes/:id/crew', requirePermission('routes.crew.assign'), (req, res) => {
  const { employeeId, effectiveDate } = req.body || {};
  if (!employeeId) return res.status(400).json({ error: 'employeeId is required.' });
  const id = run(`INSERT INTO route_crew (route_id, employee_id, effective_date, assigned_by)
                  VALUES (?, ?, ?, ?)`,
                 req.params.id, employeeId, effectiveDate || today(), req.user.id).lastInsertRowid;
  audit(req, 'route.crew_added', { entityType: 'route', entityId: Number(req.params.id),
                                   detail: { employeeId } });
  res.status(201).json({ id });
});

router.delete('/routes/:id/crew/:crewId', requirePermission('routes.crew.assign'), (req, res) => {
  run(`UPDATE route_crew SET end_date = date('now') WHERE id = ? AND route_id = ?`,
      req.params.crewId, req.params.id);
  audit(req, 'route.crew_removed', { entityType: 'route', entityId: Number(req.params.id) });
  res.json({ ok: true });
});


/* ============================================================
   Permanent deletion — only for records that were never used.
   ============================================================ */

/** The UI asks this to decide whether to show Delete or Archive. */
router.get('/routes/:id/deletable', requirePermission('routes.view'), (req, res) => {
  const route = one('SELECT * FROM routes WHERE id = ?', req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found.' });
  res.json({ ...deletability('route', route.id, route), name: route.name, status: route.status });
});

router.delete('/routes/:id', requirePermission('routes.archive'), (req, res) => {
  const route = one('SELECT * FROM routes WHERE id = ?', req.params.id);
  if (!route) return res.status(404).json({ error: 'Route not found.' });

  try {
    assertDeletable('route', route.id, route);
  } catch (err) {
    return res.status(err.status).json({
      error: err.message, code: err.code, blockers: err.blockers, suggestion: err.suggestion,
    });
  }

  tx(() => {
    run('DELETE FROM route_stops WHERE route_id = ?', route.id);
    run('DELETE FROM route_crew WHERE route_id = ?', route.id);
    run('DELETE FROM route_versions WHERE route_id = ?', route.id);
    run('DELETE FROM routes WHERE id = ?', route.id);
  });

  // The audit entry survives the record, so the deletion itself is traceable.
  audit(req, 'route.deleted', {
    entityType: 'route', entityId: route.id,
    detail: { name: route.name, status: route.status, note: 'permanently deleted — no history existed' },
  });
  res.json({ ok: true, message: `"${route.name}" was permanently deleted.` });
});

router.get('/:key/deletable', requirePermission('system.roles.manage'), (req, res) => {
  const role = one('SELECT * FROM roles WHERE key = ?', req.params.key);
  if (!role) return res.status(404).json({ error: 'Role not found.' });
  res.json({ ...deletability('role', role.key, role), name: role.name });
});

router.delete('/:key', requirePermission('system.roles.manage'), (req, res) => {
  const role = one('SELECT * FROM roles WHERE key = ?', req.params.key);
  if (!role) return res.status(404).json({ error: 'Role not found.' });

  try {
    assertDeletable('role', role.key, role);
  } catch (err) {
    return res.status(err.status).json({
      error: err.message, code: err.code, blockers: err.blockers, suggestion: err.suggestion,
    });
  }

  tx(() => {
    run('DELETE FROM role_permissions WHERE role_key = ?', role.key);
    run('DELETE FROM roles WHERE key = ?', role.key);
  });
  audit(req, 'role.deleted', { entityType: 'role', entityId: role.id,
                               detail: { key: role.key, name: role.name } });
  res.json({ ok: true, message: `The ${role.name} role was deleted.` });
});
