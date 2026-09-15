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
import { encrypt, decrypt, encryptionAvailable } from '../lib/encryption.js';
import { availableActions, resolveAction } from '../lib/lifecycle.js';
import { WORKER_STATUSES, WORKER_LIFECYCLE, WORKER_ACTION_PERMISSION } from '../lib/worker_lifecycle.js';

export const router = Router();
router.use(requirePermission('employees.view','system.users.manage'));

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
  const { q, status, workerType } = req.query;
  const where = [], params = [];
  if (q) { where.push('(u.first_name LIKE ? OR u.last_name LIKE ? OR u.email LIKE ? OR e.employee_code LIKE ?)');
           params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
  // '__all__' shows every status (archived included). A specific status
  // filters to it. The default view hides archived workers.
  if (status === '__all__') { /* no status filter */ }
  else if (status) { where.push('e.status = ?'); params.push(status); }
  else { where.push("e.status != 'archived'"); }
  if (workerType && ['W2', '1099'].includes(workerType)) {
    where.push('e.worker_type = ?'); params.push(workerType);
  }
  where.push('e.is_demo = 0');

  res.json(all(`
    SELECT e.id, e.employee_code, e.hire_date, e.status, e.end_date, e.worker_type,
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
    banking: (() => {
      const b = one('SELECT * FROM employee_banking WHERE employee_id = ?', emp.id);
      if (!b) return null;
      return {
        accountHolderName: b.account_holder_name,
        bankName: b.bank_name,
        accountType: b.account_type,
        accountLast4: b.account_last4,
        routingLast4: b.routing_last4,
        directDeposit: Boolean(b.direct_deposit),
        updatedAt: b.updated_at,
      };
    })(),
    lifecycle: {
      statusLabel: WORKER_STATUSES[emp.status]?.label ?? emp.status,
      statusTone: WORKER_STATUSES[emp.status]?.tone ?? '',
      statusEffectiveDate: emp.status_effective_date,
      statusReason: emp.status_reason,
      endDate: emp.end_date,
      suspensionEndDate: emp.suspension_end_date,
      accountLogin: emp.account_status === 'active' ? 'enabled' : 'disabled',
    },
    statusHistory: workerStatusHistory(emp.id),
    periods: all(`SELECT * FROM employment_periods WHERE employee_id = ?
                   ORDER BY start_date DESC, id DESC`, emp.id),
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

    const workerType = b.workerType === '1099' ? '1099' : 'W2';
    const eid = run(
      `INSERT INTO employees (user_id, employee_code, hire_date, status, worker_type)
       VALUES (?, ?, ?, ?, ?)`,
      uid, b.employeeCode ?? null, b.hireDate ?? today(), b.status ?? 'active', workerType).lastInsertRowid;

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
    // Open the first employment period and log the hire, so the lifecycle
    // history is complete from day one.
    run(`INSERT INTO employment_periods (employee_id, worker_type, start_date) VALUES (?, ?, ?)`,
        eid, workerType, b.hireDate ?? today());
    run(`INSERT INTO employee_status_history
           (employee_id, from_status, to_status, action, effective_date, changed_by)
         VALUES (?, NULL, 'active', 'hire', ?, ?)`,
        eid, b.hireDate ?? today(), req.user.id);
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

  // Status is an employment-lifecycle change, not a plain field edit: it
  // moves only through the lifecycle actions, which capture the effective
  // date, reason and account effects and write status history.
  if (b.status !== undefined && b.status !== emp.status) {
    return res.status(400).json({
      error: 'Worker status changes go through Worker Actions, not the edit form.',
      lifecycleUrl: `/api/people/employees/${emp.id}/lifecycle`,
    });
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

    const validWorkerType = b.workerType && ['W2', '1099'].includes(b.workerType) ? b.workerType : undefined;
    const empChanges = diff(
      { employee_code: emp.employee_code, hire_date: emp.hire_date, worker_type: emp.worker_type },
      { employee_code: b.employeeCode, hire_date: b.hireDate, worker_type: validWorkerType });

    if (Object.keys(empChanges).length) {
      run(`UPDATE employees SET employee_code = COALESCE(?, employee_code),
                                hire_date = COALESCE(?, hire_date),
                                worker_type = COALESCE(?, worker_type)
            WHERE id = ?`,
          b.employeeCode ?? null, b.hireDate ?? null, validWorkerType ?? null, emp.id);
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
   Worker employment lifecycle: suspend, terminate, resign,
   end contract, archive, rehire — through the shared engine so
   the CURRENT status decides what is allowed, and the server
   re-checks every rule the UI drew. Nothing here deletes history.
   ============================================================ */

/** True if the caller may perform an action that needs `perm`. */
function mayDo(req, perm) {
  return req.user?.role === 'admin' ||
    one(`SELECT allowed FROM role_permissions WHERE role_key = ? AND permission = ?`,
        req.user?.role, perm)?.allowed === 1;
}

function loadWorker(id) {
  return one(`SELECT e.*, u.id AS user_id, u.first_name, u.last_name, u.email,
                     u.status AS account_status
                FROM employees e JOIN users u ON u.id = e.user_id WHERE e.id = ?`, id);
}

const workerStatusHistory = (id) => all(`
  SELECT h.*, u.first_name, u.last_name FROM employee_status_history h
    LEFT JOIN users u ON u.id = h.changed_by
   WHERE h.employee_id = ? ORDER BY h.created_at DESC, h.id DESC LIMIT 50`, id)
  .map(h => ({
    ...h,
    fromLabel: WORKER_STATUSES[h.from_status]?.label ?? h.from_status ?? 'New',
    toLabel: WORKER_STATUSES[h.to_status]?.label ?? h.to_status,
  }));

/** What may be done to this worker right now, plus status + history. */
router.get('/employees/:id/actions', (req, res) => {
  const emp = loadWorker(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });

  const ctx = { userId: req.user.id };
  const del = deletability('employee', emp.id, emp);
  const meta = WORKER_STATUSES[emp.status] ?? { label: emp.status, tone: '', description: '' };
  // Only offer actions the caller actually has permission to run.
  const actions = availableActions(WORKER_LIFECYCLE, emp, ctx)
    .filter(a => mayDo(req, WORKER_ACTION_PERMISSION[a.key]));

  res.json({
    name: `${emp.first_name} ${emp.last_name}`,
    worker: { id: emp.id, name: `${emp.first_name} ${emp.last_name}`,
              status: emp.status, workerType: emp.worker_type },
    status: { key: emp.status, ...meta },
    account: { login: emp.account_status === 'active' ? 'enabled' : 'disabled',
               status: emp.account_status },
    lifecycle: {
      statusEffectiveDate: emp.status_effective_date, statusReason: emp.status_reason,
      endDate: emp.end_date, suspensionEndDate: emp.suspension_end_date,
    },
    actions,
    statusHistory: workerStatusHistory(emp.id),
    periods: all(`SELECT * FROM employment_periods WHERE employee_id = ?
                   ORDER BY start_date DESC, id DESC`, emp.id),
    // Permanent deletion is never a lifecycle action — only offered for a
    // worker who has never been used at all.
    deletion: { ...del, url: `/api/people/employees/${emp.id}` },
  });
});

function performWorkerLifecycle(req, res, actionKey, input) {
  const emp = loadWorker(req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });

  const perm = WORKER_ACTION_PERMISSION[actionKey];
  // An unknown action, or one the caller cannot perform, simply does not
  // exist for them — never reveal it with a 403.
  if (!perm || !mayDo(req, perm)) return res.status(404).json({ error: 'Not found.' });

  const ctx = { userId: req.user.id, input };
  let resolved;
  try {
    resolved = resolveAction(WORKER_LIFECYCLE, emp, actionKey, input, ctx);
  } catch (err) {
    return res.status(err.status ?? 400).json({
      error: err.message, code: err.code, currentStatus: err.currentStatus, field: err.field,
    });
  }

  if (actionKey === 'reactivate') {
    const cents = Math.round(Number(resolved.values.payRate) * 100);
    if (!Number.isFinite(cents) || cents <= 0) {
      return res.status(400).json({ error: 'Pay rate must be a positive number.', field: 'payRate' });
    }
  }

  const { action, values, from, to } = resolved;
  const result = tx(() => {
    const out = action.run(emp, values, ctx) ?? {};
    run(`INSERT INTO employee_status_history
           (employee_id, from_status, to_status, changed_by, action,
            effective_date, reason, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        emp.id, from, to, req.user.id, actionKey,
        values.effectiveDate ?? values.lastWorkingDate ?? null,
        values.reason ?? null, values.notes ?? out.message ?? null);
    return out;
  });

  audit(req, `employee.${actionKey}`, {
    entityType: 'employee', entityId: emp.id,
    detail: { name: `${emp.first_name} ${emp.last_name}`, from, to,
              effectiveDate: values.effectiveDate ?? values.lastWorkingDate ?? null,
              reason: values.reason ?? null },
  });

  res.json({ ok: true, action: actionKey, from, to,
             statusLabel: WORKER_STATUSES[to]?.label ?? to, ...result });
}

router.post('/employees/:id/lifecycle', (req, res) => {
  const b = req.body || {};
  if (!b.action) return res.status(400).json({ error: 'Choose one action to perform.' });
  if (Array.isArray(b.action)) {
    return res.status(400).json({ error: 'Only one action can be performed at a time.' });
  }
  return performWorkerLifecycle(req, res, b.action, b);
});

/* ============================================================
   Banking
   ============================================================ */

router.get('/employees/:id/banking', requirePermission('employees.banking.view'), (req, res) => {
  const emp = one('SELECT id FROM employees WHERE id = ?', req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });

  const b = one('SELECT * FROM employee_banking WHERE employee_id = ?', emp.id);
  if (!b) return res.json(null);

  const result = {
    accountHolderName: b.account_holder_name,
    bankName: b.bank_name,
    accountType: b.account_type,
    accountLast4: b.account_last4,
    routingLast4: b.routing_last4,
    directDeposit: Boolean(b.direct_deposit),
    updatedAt: b.updated_at,
  };

  if (req.query.full === 'true' && encryptionAvailable()) {
    try {
      result.routingNumber = decrypt(b.routing_number_enc);
      result.accountNumber = decrypt(b.account_number_enc);
    } catch { /* decryption failure — return masked only */ }
  }

  res.json(result);
});

router.put('/employees/:id/banking', requirePermission('employees.banking.edit'), (req, res) => {
  if (!encryptionAvailable()) {
    return res.status(503).json({ error: 'Banking features require encryption configuration.' });
  }
  const emp = one('SELECT id FROM employees WHERE id = ?', req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });

  const b = req.body || {};
  if (!b.accountHolderName || !b.bankName || !b.accountType ||
      !b.routingNumber || !b.accountNumber || !b.confirmAccountNumber) {
    return res.status(400).json({ error: 'All banking fields are required.' });
  }
  if (!['checking', 'savings'].includes(b.accountType)) {
    return res.status(400).json({ error: 'Account type must be checking or savings.' });
  }
  if (!/^\d{9}$/.test(b.routingNumber)) {
    return res.status(400).json({ error: 'Routing number must be 9 digits.' });
  }
  if (!/^\d{4,17}$/.test(b.accountNumber)) {
    return res.status(400).json({ error: 'Account number must be 4–17 digits.' });
  }
  if (b.accountNumber !== b.confirmAccountNumber) {
    return res.status(400).json({ error: 'Account numbers do not match.' });
  }

  const routingEnc = encrypt(b.routingNumber);
  const accountEnc = encrypt(b.accountNumber);
  const routingLast4 = b.routingNumber.slice(-4);
  const accountLast4 = b.accountNumber.slice(-4);

  const existing = one('SELECT employee_id FROM employee_banking WHERE employee_id = ?', emp.id);
  if (existing) {
    run(`UPDATE employee_banking SET account_holder_name = ?, bank_name = ?, account_type = ?,
            routing_number_enc = ?, account_number_enc = ?, routing_last4 = ?, account_last4 = ?,
            direct_deposit = ?, updated_at = datetime('now')
          WHERE employee_id = ?`,
        b.accountHolderName, b.bankName, b.accountType,
        routingEnc, accountEnc, routingLast4, accountLast4,
        b.directDeposit ? 1 : 0, emp.id);
  } else {
    run(`INSERT INTO employee_banking (employee_id, account_holder_name, bank_name, account_type,
            routing_number_enc, account_number_enc, routing_last4, account_last4, direct_deposit)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        emp.id, b.accountHolderName, b.bankName, b.accountType,
        routingEnc, accountEnc, routingLast4, accountLast4,
        b.directDeposit ? 1 : 0);
  }

  audit(req, 'employee.banking_updated', {
    entityType: 'employee', entityId: emp.id,
    detail: { bankName: b.bankName, accountType: b.accountType, accountLast4 },
  });
  res.json({ ok: true });
});

router.patch('/employees/:id/banking', requirePermission('employees.banking.edit'), (req, res) => {
  const emp = one('SELECT id FROM employees WHERE id = ?', req.params.id);
  if (!emp) return res.status(404).json({ error: 'Employee not found.' });
  const existing = one('SELECT * FROM employee_banking WHERE employee_id = ?', emp.id);
  if (!existing) return res.status(404).json({ error: 'No banking information on file.' });

  const b = req.body || {};
  if (b.directDeposit !== undefined) {
    run('UPDATE employee_banking SET direct_deposit = ?, updated_at = datetime(?) WHERE employee_id = ?',
        b.directDeposit ? 1 : 0, 'now', emp.id);
    audit(req, 'employee.direct_deposit_toggled', {
      entityType: 'employee', entityId: emp.id,
      detail: { directDeposit: Boolean(b.directDeposit) },
    });
  }
  res.json({ ok: true });
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
  where.push('u.is_demo = 0');   // training accounts stay out of the owner's account list

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
    run('DELETE FROM employee_banking WHERE employee_id = ?', e.id);
    run('DELETE FROM employee_profiles WHERE employee_id = ?', e.id);
    run('DELETE FROM employee_notes WHERE employee_id = ?', e.id);
    run('DELETE FROM employee_status_history WHERE employee_id = ?', e.id);
    run('DELETE FROM employment_periods WHERE employee_id = ?', e.id);
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
