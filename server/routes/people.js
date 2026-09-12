/* ============================================================
   Employee management + central account administration.
   ADMIN ONLY.

   Password rules enforced here:
     * An admin can never read or recover an existing password —
       only issue a NEW temporary one, shown once, or force a change.
     * A temporary password sets must_change_password, which blocks
       every other route until the user picks their own.
     * Nothing is ever stored in plain text; the hash is scrypt.
   ============================================================ */

import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { one, all, run, tx } from '../db/index.js';
import { requirePermission } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';
import { hashPassword, passwordProblem, destroyAllSessions } from '../lib/auth.js';
import { rateOn, currentPayPeriod, entryPayCents, MINUTES_SQL } from '../lib/timeclock.js';
import { laborByEmployee, dollars } from '../lib/finance.js';
import { today, DAY_NAMES } from '../lib/schedule.js';
import { deletability, assertDeletable } from '../lib/deletable.js';

export const router = Router();
router.use(requirePermission('employees.view','system.users.manage'));

const EMP_STATUS = ['active', 'inactive', 'on_leave', 'terminated', 'archived'];
/* Roles are data now, so a hardcoded list would go stale the moment an
   admin creates a custom one. Validate against the table instead. */
const isValidRole = (key) =>
  Boolean(one(`SELECT 1 FROM roles WHERE key = ? AND status = 'active'`, key));

/** Record only what changed, so the audit entry is readable. */
function diff(before, after) {
  const out = {};
  for (const k of Object.keys(after)) {
    if (after[k] !== undefined && String(before[k] ?? '') !== String(after[k] ?? '')) {
      out[k] = { from: before[k] ?? null, to: after[k] };
    }
  }
  return out;
}

/* ============================================================
   Employees
   ============================================================ */

router.get('/employees', (req, res) => {
  const { q, status } = req.query;
  const where = [], params = [];
  if (q) { where.push('(u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR e.employee_code LIKE ?)');
           params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  if (status) { where.push('e.status = ?'); params.push(status); }

  res.json(all(`
    SELECT e.id, e.employee_code, e.hire_date, e.status, e.end_date,
           u.id AS user_id, u.first_name, u.last_name, u.email, u.phone,
           u.status AS account_status, u.last_login_at, u.locked_until, u.must_change_password,
           p.job_title,
           (SELECT COUNT(*) FROM route_assignments ra
             WHERE ra.employee_id = e.id AND ra.end_date IS NULL) AS active_routes
      FROM employees e
      JOIN users u ON u.id = e.user_id
      LEFT JOIN employee_profiles p ON p.employee_id = e.id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY CASE e.status WHEN 'active' THEN 0 ELSE 1 END, u.last_name`, ...params));
});

/** Full detail page: profile, pay, time, routes, performance, account, notes. */
router.get('/employees/:id', (req, res) => {
  const emp = one(`
    SELECT e.*, u.id AS user_id, u.first_name, u.last_name, u.email, u.phone,
           u.status AS account_status, u.last_login_at, u.locked_until,
           u.must_change_password, u.password_changed_at
      FROM employees e JOIN users u ON u.id = e.user_id WHERE e.id = ?`, req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });

  const period = currentPayPeriod();
  const periodEntries = all(
    `SELECT *, ${MINUTES_SQL} AS minutes FROM time_entries
      WHERE employee_id = ? AND work_date BETWEEN ? AND ? AND clock_out_at IS NOT NULL`,
    emp.id, period.start, period.end);

  const weekStart = (() => { const d = new Date(); d.setDate(d.getDate() - d.getDay()); return d.toISOString().slice(0, 10); })();
  const sum = (rows) => rows.reduce((a, r) => a + (r.minutes || 0), 0);

  res.json({
    employee: emp,
    profile: one('SELECT * FROM employee_profiles WHERE employee_id = ?', emp.id) || {},
    pay: {
      current: rateOn(emp.id, today()),
      history: all(`SELECT * FROM employee_compensation WHERE employee_id = ?
                     ORDER BY effective_date DESC`, emp.id),
      payPeriod: {
        ...period,
        minutes: sum(periodEntries),
        hours: Math.round(sum(periodEntries) / 6) / 10,
        shifts: periodEntries.length,
        estimatedPay: dollars(periodEntries.reduce((a, e) => a + entryPayCents(e), 0)),
      },
    },
    time: {
      todayMinutes: sum(all(`SELECT *, ${MINUTES_SQL} AS minutes FROM time_entries
                              WHERE employee_id = ? AND work_date = ?`, emp.id, today())),
      weekMinutes: sum(all(`SELECT *, ${MINUTES_SQL} AS minutes FROM time_entries
                             WHERE employee_id = ? AND work_date >= ?`, emp.id, weekStart)),
      entries: all(`SELECT te.*, ${MINUTES_SQL} AS minutes, r.name AS route_name
                      FROM time_entries te LEFT JOIN routes r ON r.id = te.route_id
                     WHERE te.employee_id = ? ORDER BY te.clock_in_at DESC LIMIT 40`, emp.id)
                .map(t => ({ ...t, pay: dollars(entryPayCents(t)) })),
    },
    routes: {
      assignments: all(`
        SELECT ra.*, r.name, r.day_of_week FROM route_assignments ra
          JOIN routes r ON r.id = ra.route_id
         WHERE ra.employee_id = ? ORDER BY ra.end_date IS NULL DESC, ra.effective_date DESC`, emp.id)
        .map(a => ({ ...a, dayName: DAY_NAMES[a.day_of_week], current: !a.end_date })),
      communities: all(`
        SELECT DISTINCT com.id, com.name FROM route_assignments ra
          JOIN route_stops rs ON rs.route_id = ra.route_id
          JOIN communities com ON com.id = rs.community_id
         WHERE ra.employee_id = ? AND ra.end_date IS NULL`, emp.id),
    },
    performance: one(`
      SELECT (SELECT COUNT(*) FROM pickup_records WHERE employee_id = ?) AS completed,
             (SELECT COUNT(*) FROM pickup_records WHERE employee_id = ? AND status='issue') AS issues,
             (SELECT COUNT(*) FROM pickup_photos ph JOIN pickup_records pr ON pr.id = ph.pickup_record_id
               WHERE pr.employee_id = ?) AS photos`, emp.id, emp.id, emp.id),
    recentPickups: all(`
      SELECT pr.*, un.label AS unit_label, com.name AS community_name,
             (SELECT ph.id FROM pickup_photos ph WHERE ph.pickup_record_id = pr.id LIMIT 1) AS photo_id
        FROM pickup_records pr
        JOIN units un ON un.id = pr.unit_id
        LEFT JOIN communities com ON com.id = un.community_id
       WHERE pr.employee_id = ? ORDER BY pr.completed_at DESC LIMIT 20`, emp.id),
    notes: all(`SELECT n.*, u.first_name, u.last_name FROM employee_notes n
                  LEFT JOIN users u ON u.id = n.author_user_id
                 WHERE n.employee_id = ? ORDER BY n.created_at DESC`, emp.id),
    passwordEvents: all(`SELECT pe.*, u.first_name AS actor_first, u.last_name AS actor_last
                           FROM password_reset_events pe
                           LEFT JOIN users u ON u.id = pe.actor_user_id
                          WHERE pe.user_id = ? ORDER BY pe.created_at DESC LIMIT 10`, emp.user_id),
  });
});

/** Create an employee: user account + employee row + profile, in one transaction. */
router.post('/employees', requirePermission('employees.create'), async (req, res) => {
  const b = req.body || {};
  if (!b.firstName || !b.lastName || !b.email) {
    return res.status(400).json({ error: 'First name, last name, and email are required.' });
  }
  if (one('SELECT id FROM users WHERE email = ?', b.email)) {
    return res.status(409).json({ error: 'That email is already in use.' });
  }

  // If no password is supplied, issue a temporary one the employee must change.
  const temporary = !b.password;
  const password = b.password || ('Dash' + randomBytes(4).toString('hex') + '!1');
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ error: problem });
  const hash = await hashPassword(password);

  const id = tx(() => {
    const uid = run(
      `INSERT INTO users (email, password_hash, role, first_name, last_name, phone,
                          must_change_password, password_changed_at)
       VALUES (?, ?, 'employee', ?, ?, ?, ?, datetime('now'))`,
      b.email, hash, b.firstName, b.lastName, b.phone ?? null, temporary ? 1 : 0).lastInsertRowid;

    const eid = run(
      `INSERT INTO employees (user_id, employee_code, hire_date, status)
       VALUES (?, ?, ?, ?)`,
      uid, b.employeeCode ?? null, b.hireDate ?? today(), b.status ?? 'active').lastInsertRowid;

    run(`INSERT INTO employee_profiles
           (employee_id, address, city, state, zip, emergency_contact_name,
            emergency_contact_phone, job_title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        eid, b.address ?? null, b.city ?? 'Columbus', b.state ?? 'GA', b.zip ?? null,
        b.emergencyContactName ?? null, b.emergencyContactPhone ?? null,
        b.jobTitle ?? 'Pickup Technician');

    if (b.payType && b.payRate != null) {
      run(`INSERT INTO employee_compensation (employee_id, pay_type, rate_cents, effective_date, created_by)
           VALUES (?, ?, ?, ?, ?)`,
          eid, b.payType, Math.round(Number(b.payRate) * 100), b.payEffectiveDate || today(), req.user.id);
    }
    if (temporary) {
      run(`INSERT INTO password_reset_events (user_id, actor_user_id, kind, expires_at)
           VALUES (?, ?, 'temporary_password', datetime('now','+7 days'))`, uid, req.user.id);
    }
    return eid;
  });

  audit(req, 'employee.created', {
    entityType: 'employee', entityId: id,
    detail: { email: b.email, name: `${b.firstName} ${b.lastName}`, temporaryPassword: temporary },
  });

  // The temporary password is returned ONCE and never stored in readable form.
  res.status(201).json({ id, temporaryPassword: temporary ? password : undefined });
});

/** Edit an employee: user fields, employee fields, and profile in one call. */
router.patch('/employees/:id', requirePermission('employees.edit'), (req, res) => {
  const emp = one(`SELECT e.*, u.first_name, u.last_name, u.email, u.phone, u.status AS account_status
                     FROM employees e JOIN users u ON u.id = e.user_id WHERE e.id = ?`, req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  const b = req.body || {};

  if (b.status && !EMP_STATUS.includes(b.status)) {
    return res.status(400).json({ error: `Status must be one of: ${EMP_STATUS.join(', ')}.` });
  }
  if (b.email && one('SELECT id FROM users WHERE email = ? AND id != ?', b.email, emp.user_id)) {
    return res.status(409).json({ error: 'That email is already in use.' });
  }

  const profileBefore = one('SELECT * FROM employee_profiles WHERE employee_id = ?', emp.id) || {};

  const changes = tx(() => {
    const userChanges = diff(
      { first_name: emp.first_name, last_name: emp.last_name, email: emp.email, phone: emp.phone },
      { first_name: b.firstName, last_name: b.lastName, email: b.email, phone: b.phone });

    if (Object.keys(userChanges).length) {
      run(`UPDATE users SET first_name = COALESCE(?, first_name), last_name = COALESCE(?, last_name),
                            email = COALESCE(?, email), phone = COALESCE(?, phone) WHERE id = ?`,
          b.firstName ?? null, b.lastName ?? null, b.email ?? null, b.phone ?? null, emp.user_id);
    }

    const empChanges = diff(
      { status: emp.status, employee_code: emp.employee_code, hire_date: emp.hire_date },
      { status: b.status, employee_code: b.employeeCode, hire_date: b.hireDate });

    if (Object.keys(empChanges).length) {
      run(`UPDATE employees SET status = COALESCE(?, status),
                                employee_code = COALESCE(?, employee_code),
                                hire_date = COALESCE(?, hire_date),
                                end_date = CASE WHEN ? IN ('terminated','archived')
                                                THEN COALESCE(end_date, date('now')) ELSE NULL END
            WHERE id = ?`,
          b.status ?? null, b.employeeCode ?? null, b.hireDate ?? null, b.status ?? emp.status, emp.id);

      // Leaving 'active' must also close the login, or a terminated employee
      // could still sign in and record pickups.
      if (b.status && b.status !== 'active') {
        run(`UPDATE users SET status = 'deactivated' WHERE id = ?`, emp.user_id);
        destroyAllSessions(emp.user_id);
      } else if (b.status === 'active') {
        run(`UPDATE users SET status = 'active' WHERE id = ?`, emp.user_id);
      }
    }

    const profileFields = {
      address: b.address, city: b.city, state: b.state, zip: b.zip,
      emergency_contact_name: b.emergencyContactName,
      emergency_contact_phone: b.emergencyContactPhone,
      job_title: b.jobTitle, drivers_license: b.driversLicense,
      vehicle_assignment: b.vehicleAssignment, uniform_size: b.uniformSize,
      training_completed: b.trainingCompleted,
      background_check_status: b.backgroundCheckStatus,
    };
    const profileChanges = diff(profileBefore, profileFields);
    if (Object.keys(profileChanges).length) {
      const sets = Object.keys(profileFields).filter(k => profileFields[k] !== undefined);
      run(`UPDATE employee_profiles SET ${sets.map(k => `${k} = ?`).join(', ')},
                                        updated_at = datetime('now')
            WHERE employee_id = ?`, ...sets.map(k => profileFields[k]), emp.id);
    }

    return { ...userChanges, ...empChanges, ...profileChanges };
  });

  if (Object.keys(changes).length) {
    audit(req, 'employee.updated', {
      entityType: 'employee', entityId: emp.id,
      detail: { employee: `${emp.first_name} ${emp.last_name}`, changes },
    });
  }
  res.json({ ok: true, changes });
});

router.post('/employees/:id/notes', (req, res) => {
  const body = String(req.body?.body || '').trim();
  if (!body) return res.status(400).json({ error: 'Note cannot be empty.' });
  const id = run(`INSERT INTO employee_notes (employee_id, author_user_id, body) VALUES (?, ?, ?)`,
                 req.params.id, req.user.id, body).lastInsertRowid;
  audit(req, 'employee.note_added', { entityType: 'employee', entityId: Number(req.params.id) });
  res.status(201).json({ id });
});

/* ============================================================
   Accounts + passwords
   ============================================================ */

router.get('/accounts', requirePermission('system.users.manage'), (req, res) => {
  const { role, status, q } = req.query;
  const where = [], params = [];
  if (role)   { where.push('u.role = ?'); params.push(role); }
  if (q)      { where.push('(u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ?)');
                params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (status === 'locked') where.push(`u.locked_until IS NOT NULL AND u.locked_until > datetime('now')`);
  else if (status)         { where.push('u.status = ?'); params.push(status); }

  res.json(all(`
    SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.phone, u.status,
           u.last_login_at, u.locked_until, u.must_change_password, u.created_at,
           (SELECT id FROM employees e WHERE e.user_id = u.id) AS employee_id,
           (SELECT id FROM customers c WHERE c.user_id = u.id) AS customer_id
      FROM users u
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY u.role, u.last_name, u.first_name LIMIT 500`, ...params)
    .map(u => ({ ...u, isLocked: Boolean(u.locked_until && new Date(u.locked_until) > new Date()) })));
});

/** Issue a temporary password. Returned once; the employee must change it. */
router.post('/accounts/:userId/temporary-password', requirePermission('system.passwords.reset','employees.password.reset'), async (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });

  const password = 'Dash' + randomBytes(5).toString('hex') + '!7';
  run(`UPDATE users SET password_hash = ?, must_change_password = 1,
                        password_changed_at = datetime('now'), locked_until = NULL
        WHERE id = ?`, await hashPassword(password), user.id);
  destroyAllSessions(user.id);   // existing sessions must not survive a reset
  run(`INSERT INTO password_reset_events (user_id, actor_user_id, kind, expires_at)
       VALUES (?, ?, 'temporary_password', datetime('now','+7 days'))`, user.id, req.user.id);

  audit(req, 'account.temporary_password_issued', {
    entityType: 'user', entityId: user.id,
    detail: { email: user.email, note: 'password value is never stored or logged' },
  });
  res.json({
    ok: true, temporaryPassword: password,
    message: 'Give this to the employee. It is shown once and cannot be recovered.',
  });
});

router.post('/accounts/:userId/force-password-change', requirePermission('system.passwords.reset'), (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  run('UPDATE users SET must_change_password = 1 WHERE id = ?', user.id);
  run(`INSERT INTO password_reset_events (user_id, actor_user_id, kind) VALUES (?, ?, 'force_change')`,
      user.id, req.user.id);
  audit(req, 'account.force_password_change', { entityType: 'user', entityId: user.id, detail: { email: user.email } });
  res.json({ ok: true });
});

router.post('/accounts/:userId/lock', requirePermission('system.users.manage'), (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot lock your own account.' });

  const days = Number(req.body?.days) || 3650;
  run(`UPDATE users SET locked_until = datetime('now','+' || ? || ' days') WHERE id = ?`, String(days), user.id);
  destroyAllSessions(user.id);
  run(`INSERT INTO password_reset_events (user_id, actor_user_id, kind) VALUES (?, ?, 'lock')`, user.id, req.user.id);
  audit(req, 'account.locked', { entityType: 'user', entityId: user.id, detail: { email: user.email, days } });
  res.json({ ok: true });
});

router.post('/accounts/:userId/unlock', requirePermission('system.users.manage'), (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  run('UPDATE users SET locked_until = NULL WHERE id = ?', user.id);
  run(`INSERT INTO password_reset_events (user_id, actor_user_id, kind) VALUES (?, ?, 'unlock')`, user.id, req.user.id);
  audit(req, 'account.unlocked', { entityType: 'user', entityId: user.id, detail: { email: user.email } });
  res.json({ ok: true });
});

router.patch('/accounts/:userId', requirePermission('system.users.manage'), (req, res) => {
  const user = one('SELECT * FROM users WHERE id = ?', req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found.' });
  const b = req.body || {};

  if (b.role && b.role !== user.role) {
    // A role change rewrites what this person can see. Require an explicit
    // acknowledgement so it cannot happen from a stray click.
    if (b.confirm !== 'CHANGE ROLE') {
      return res.status(400).json({
        error: 'Changing a role requires confirmation.',
        requiresConfirmation: true,
        confirmPhrase: 'CHANGE ROLE',
      });
    }
    if (!isValidRole(b.role)) return res.status(400).json({ error: 'Unknown or inactive role.' });
    if (user.id === req.user.id) return res.status(400).json({ error: 'You cannot change your own role.' });
  }

  const changes = diff(
    { email: user.email, status: user.status, role: user.role,
      first_name: user.first_name, last_name: user.last_name, phone: user.phone },
    { email: b.email, status: b.status, role: b.role,
      first_name: b.firstName, last_name: b.lastName, phone: b.phone });

  if (!Object.keys(changes).length) return res.json({ ok: true, changes: {} });

  run(`UPDATE users SET email = COALESCE(?, email), status = COALESCE(?, status),
                        role = COALESCE(?, role), first_name = COALESCE(?, first_name),
                        last_name = COALESCE(?, last_name), phone = COALESCE(?, phone)
        WHERE id = ?`,
      b.email ?? null, b.status ?? null, b.role ?? null,
      b.firstName ?? null, b.lastName ?? null, b.phone ?? null, user.id);

  /* Keep user_roles in step with the primary role. Without this the old
     role link survives, and the user silently keeps permissions from a
     role the admin believed they had replaced. */
  if (changes.role) {
    run(`DELETE FROM user_roles WHERE user_id = ? AND role_key = ?`, user.id, user.role);
    run(`INSERT OR IGNORE INTO user_roles (user_id, role_key, is_primary, assigned_by)
         VALUES (?, ?, 1, ?)`, user.id, b.role, req.user.id);
    run(`UPDATE user_roles SET is_primary = (role_key = ?) WHERE user_id = ?`, b.role, user.id);
  }

  if (changes.role || changes.status) destroyAllSessions(user.id);

  audit(req, changes.role ? 'account.role_changed' : 'account.updated', {
    entityType: 'user', entityId: user.id, detail: { email: user.email, changes },
  });
  res.json({ ok: true, changes });
});

/* ---------- Audit log with readable before/after ---------- */

router.get('/audit', requirePermission('system.audit.view'), (req, res) => {
  const { action, entityType, limit = 200 } = req.query;
  const where = [], params = [];
  if (action) { where.push('a.action LIKE ?'); params.push(`%${action}%`); }
  if (entityType) { where.push('a.entity_type = ?'); params.push(entityType); }

  res.json(all(`
    SELECT a.*, u.first_name, u.last_name, u.email, u.role AS actor_role_now
      FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.created_at DESC LIMIT ?`, ...params, Number(limit))
    .map(a => ({ ...a, detail: a.detail ? JSON.parse(a.detail) : null })));
});


/* ---------- permanent deletion ---------- */

router.get('/employees/:id/deletable', requirePermission('employees.view'), (req, res) => {
  const e = one(`SELECT e.*, u.first_name, u.last_name FROM employees e
                   JOIN users u ON u.id = e.user_id WHERE e.id = ?`, req.params.id);
  if (!e) return res.status(404).json({ error: 'Employee not found.' });
  res.json({ ...deletability('employee', e.id, e),
             name: `${e.first_name} ${e.last_name}`, status: e.status });
});

router.delete('/employees/:id', requirePermission('employees.archive'), (req, res) => {
  const e = one(`SELECT e.*, u.id AS user_id, u.first_name, u.last_name, u.email
                   FROM employees e JOIN users u ON u.id = e.user_id WHERE e.id = ?`, req.params.id);
  if (!e) return res.status(404).json({ error: 'Employee not found.' });
  if (e.user_id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });

  try {
    assertDeletable('employee', e.id, e);
  } catch (err) {
    return res.status(err.status).json({
      error: err.message, code: err.code, blockers: err.blockers, suggestion: err.suggestion,
    });
  }

  tx(() => {
    run('DELETE FROM employee_profiles WHERE employee_id = ?', e.id);
    run('DELETE FROM employee_notes WHERE employee_id = ?', e.id);
    run('DELETE FROM employees WHERE id = ?', e.id);
    run('DELETE FROM user_roles WHERE user_id = ?', e.user_id);
    run('DELETE FROM sessions WHERE user_id = ?', e.user_id);
    run('DELETE FROM password_reset_events WHERE user_id = ?', e.user_id);
    run('DELETE FROM users WHERE id = ?', e.user_id);
  });

  audit(req, 'employee.deleted', {
    entityType: 'employee', entityId: e.id,
    detail: { name: `${e.first_name} ${e.last_name}`, email: e.email,
              note: 'permanently deleted — never worked a shift' },
  });
  res.json({ ok: true, message: `${e.first_name} ${e.last_name} was permanently deleted.` });
});
