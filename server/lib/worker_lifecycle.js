/* ============================================================
   What can happen to a worker, and what each thing does.

   Read this as the answer to "an admin is looking at a worker in
   status X — what may they do about it?". Nothing here deletes
   history. Suspend, terminate, resign, end-contract and archive
   all work the same way: stop FUTURE work from an effective date,
   disable the login, write down who decided it and why, and leave
   every pickup, time entry, route, photo, credit and pay record
   exactly as it was. A rehire opens a NEW employment period and
   keeps the old one intact.

   The status enum lives here (application-validated), so the CURRENT
   status decides which actions exist and the server re-checks the
   same rules through the shared lifecycle engine.
   ============================================================ */

import { one, all, run } from '../db/index.js';
import { field } from './lifecycle.js';
import { today } from './schedule.js';
import { destroyAllSessions } from './auth.js';

/* ---------- the statuses a worker can be in ---------- */

export const WORKER_STATUSES = {
  active:         { label: 'Active',         tone: 'ok',    working: true,
                    description: 'Normal working employee or contractor.' },
  suspended:      { label: 'Suspended',      tone: 'warn',  working: false,
                    description: 'Temporarily prevented from working and signing in.' },
  inactive:       { label: 'Inactive',       tone: 'muted', working: false,
                    description: 'Not currently working, but not formally ended.' },
  on_leave:       { label: 'On Leave',       tone: 'warn',  working: false,
                    description: 'Away on leave. Work access is paused.' },
  resigned:       { label: 'Resigned',       tone: 'bad',   working: false,
                    description: 'The worker voluntarily left.' },
  terminated:     { label: 'Terminated',     tone: 'bad',   working: false,
                    description: 'The company ended employment.' },
  contract_ended: { label: 'Contract Ended', tone: 'bad',   working: false,
                    description: 'The 1099 contractor relationship ended.' },
  archived:       { label: 'Archived',       tone: 'muted', working: false,
                    description: 'Filed away — hidden from everyday views, all records kept.' },
};

export const isWorking = (status) => WORKER_STATUSES[status]?.working === true;

/* What every stop-work action leaves untouched. Shown on the confirm
   screen so nobody thinks employment actions delete data. */
const PRESERVED = [
  'Worker profile, worker type and role history',
  'Pay type, pay rate history and payroll records',
  'Banking status and payroll linkage',
  'Clock-in / clock-out records and time entries',
  'Assigned routes, completed pickups and photos',
  'Service issues, service credits and customer interactions',
  'The audit trail',
];

/* ---------- reason lists ---------- */

const SUSPENSION_REASONS = [
  { value: 'investigation', label: 'Under investigation' },
  { value: 'disciplinary',  label: 'Disciplinary' },
  { value: 'attendance',    label: 'Attendance' },
  { value: 'other',         label: 'Other (explain in notes)' },
];
const INACTIVE_REASONS = [
  { value: 'seasonal', label: 'Seasonal / temporary' },
  { value: 'personal', label: 'Personal leave' },
  { value: 'no_hours', label: 'No hours available right now' },
  { value: 'other',    label: 'Other (explain in notes)' },
];
const RESIGNATION_REASONS = [
  { value: 'new_job',    label: 'Took another job' },
  { value: 'personal',   label: 'Personal reasons' },
  { value: 'relocation', label: 'Relocation' },
  { value: 'schedule',   label: 'Schedule / hours' },
  { value: 'other',      label: 'Other (explain in notes)' },
];
const TERMINATION_REASONS = [
  { value: 'performance',   label: 'Performance' },
  { value: 'attendance',    label: 'Attendance / reliability' },
  { value: 'misconduct',    label: 'Misconduct / policy violation' },
  { value: 'restructuring', label: 'Restructuring / layoff' },
  { value: 'end_of_need',   label: 'Work no longer needed' },
  { value: 'other',         label: 'Other (explain in notes)' },
];
const CONTRACT_END_REASONS = [
  { value: 'project_complete',  label: 'Project / contract complete' },
  { value: 'no_longer_needed',  label: 'Services no longer needed' },
  { value: 'contractor_ended',  label: 'Contractor ended the relationship' },
  { value: 'performance',       label: 'Performance' },
  { value: 'other',             label: 'Other (explain in notes)' },
];
const WORKER_TYPES = [
  { value: 'W2',   label: 'W-2 Employee' },
  { value: '1099', label: '1099 Contractor' },
];
const PAY_TYPES = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily',  label: 'Daily / shift' },
];

const labelFor = (options, value) => options.find(o => o.value === value)?.label ?? value ?? null;
const dateField = (name, label, hint, extra = {}) => field(name, label, 'date', { hint, ...extra });
const workerName = (e) => `${e.first_name ?? ''} ${e.last_name ?? ''}`.trim() || 'this worker';

/* ---------- effects that touch the worker + their account ---------- */

const ENDED = new Set(['terminated', 'resigned', 'contract_ended', 'archived']);

/**
 * Move the worker to a new status and bring the login account with it.
 * `account`: 'suspended' | 'deactivated' | 'active'. Both non-active
 * account states block sign-in (auth checks status === 'active') and
 * end any live session, so a former worker cannot keep working.
 */
function applyStatus(emp, status, { effectiveDate = null, reason = null, account }) {
  const end = ENDED.has(status) ? (effectiveDate || today()) : null;
  run(`UPDATE employees SET status = ?, status_effective_date = ?, status_reason = ?, end_date = ?
        WHERE id = ?`,
      status, effectiveDate || null, reason, end, emp.id);

  if (account === 'suspended' || account === 'deactivated') {
    run(`UPDATE users SET status = ? WHERE id = ?`, account, emp.user_id);
    destroyAllSessions(emp.user_id);
  } else if (account === 'active') {
    run(`UPDATE users SET status = 'active' WHERE id = ?`, emp.user_id);
  }
}

/** End any open route assignments so the worker drops off future work. */
function endActiveAssignments(emp, effective) {
  const active = all(`SELECT ra.id, r.name FROM route_assignments ra
                        JOIN routes r ON r.id = ra.route_id
                       WHERE ra.employee_id = ? AND ra.end_date IS NULL`, emp.id);
  if (active.length) {
    run(`UPDATE route_assignments SET end_date = ?
          WHERE employee_id = ? AND end_date IS NULL`, effective || today(), emp.id);
  }
  return active.map(a => a.name);
}

/** Close the currently-open employment period, preserving it forever. */
function closePeriod(emp, endDate, action, reason) {
  run(`UPDATE employment_periods
          SET end_date = COALESCE(end_date, ?), end_action = ?, end_reason = ?
        WHERE employee_id = ? AND end_date IS NULL`,
      endDate || today(), action, reason ?? null, emp.id);
}

/** Open a fresh employment period for a rehire. */
function openPeriod(emp, startDate, workerType) {
  run(`INSERT INTO employment_periods (employee_id, worker_type, start_date)
       VALUES (?, ?, ?)`, emp.id, workerType || emp.worker_type, startDate || today());
}

const routeNote = (routes) =>
  routes.length
    ? `${routes.length} active route assignment(s) were ended and need reassignment: ${routes.join(', ')}.`
    : null;

/* ---------- the actions ---------- */

export const WORKER_LIFECYCLE = {
  entity: 'worker',
  statusField: 'status',
  statuses: WORKER_STATUSES,

  actions: {
    suspend: {
      label: 'Suspend Worker',
      description: 'Temporarily stop this worker from working and signing in.',
      tone: 'warn',
      from: ['active', 'on_leave', 'inactive'],
      to: 'suspended',
      fields: () => [
        dateField('effectiveDate', 'Effective date', 'The first day the worker is suspended.'),
        field('reason', 'Reason', 'select', { options: SUSPENSION_REASONS }),
        dateField('endDate', 'Expected return / review date', 'Optional.', { required: false }),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (e) => `Suspend ${workerName(e)}?`,
      effects: ['Login and work access stop immediately.',
                'Removed from new route assignments and cannot clock in.',
                'Can be reinstated later.'],
      preserves: PRESERVED,
      run(e, v) {
        const routes = endActiveAssignments(e, v.effectiveDate);
        applyStatus(e, 'suspended', {
          effectiveDate: v.effectiveDate, reason: labelFor(SUSPENSION_REASONS, v.reason), account: 'suspended',
        });
        if (v.endDate) run(`UPDATE employees SET suspension_end_date = ? WHERE id = ?`, v.endDate, e.id);
        return { message: `Suspended effective ${v.effectiveDate}.`, routesEnded: routes, warning: routeNote(routes) };
      },
    },

    reinstate: {
      label: 'Reinstate Worker',
      description: 'Lift a suspension and restore work access.',
      tone: 'primary',
      from: ['suspended'],
      to: 'active',
      fields: () => [
        dateField('effectiveDate', 'Reinstatement date'),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (e) => `Reinstate ${workerName(e)}?`,
      effects: ['Login and work access are restored.',
                'The worker can be assigned to routes and clock in again.'],
      run(e, v) {
        applyStatus(e, 'active', { effectiveDate: v.effectiveDate, reason: null, account: 'active' });
        run(`UPDATE employees SET suspension_end_date = NULL WHERE id = ?`, e.id);
        return { message: `Reinstated effective ${v.effectiveDate}.` };
      },
    },

    mark_inactive: {
      label: 'Mark Inactive',
      description: 'Not currently working, but not formally terminated.',
      tone: 'warn',
      from: ['active', 'on_leave', 'suspended'],
      to: 'inactive',
      fields: () => [
        dateField('effectiveDate', 'Effective date'),
        field('reason', 'Reason', 'select', { options: INACTIVE_REASONS, required: false }),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (e) => `Mark ${workerName(e)} inactive?`,
      effects: ['Work access stops, but the worker is not terminated.',
                'Removed from new route assignments.',
                'Can be reactivated later.'],
      preserves: PRESERVED,
      run(e, v) {
        const routes = endActiveAssignments(e, v.effectiveDate);
        applyStatus(e, 'inactive', {
          effectiveDate: v.effectiveDate, reason: labelFor(INACTIVE_REASONS, v.reason), account: 'deactivated',
        });
        return { message: `Marked inactive effective ${v.effectiveDate}.`, routesEnded: routes, warning: routeNote(routes) };
      },
    },

    resign: {
      label: 'Record Resignation',
      description: 'The worker voluntarily left.',
      tone: 'warn',
      from: ['active', 'on_leave', 'suspended', 'inactive'],
      to: 'resigned',
      fields: () => [
        dateField('lastWorkingDate', 'Last working date'),
        field('reason', 'Reason', 'select', { options: RESIGNATION_REASONS, required: false }),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (e) => `Record resignation for ${workerName(e)}?`,
      effects: ['Login is disabled and future route work is removed.',
                'Historical records remain intact.'],
      preserves: PRESERVED,
      run(e, v) {
        const routes = endActiveAssignments(e, v.lastWorkingDate);
        applyStatus(e, 'resigned', {
          effectiveDate: v.lastWorkingDate, reason: labelFor(RESIGNATION_REASONS, v.reason), account: 'deactivated',
        });
        closePeriod(e, v.lastWorkingDate, 'resigned', labelFor(RESIGNATION_REASONS, v.reason));
        return { message: `Resignation recorded. Last working day ${v.lastWorkingDate}.`,
                 routesEnded: routes, warning: routeNote(routes) };
      },
    },

    terminate: {
      label: 'Terminate Employment',
      description: 'The company is ending this W-2 employee’s employment.',
      tone: 'danger',
      from: ['active', 'on_leave', 'suspended', 'inactive'],
      to: 'terminated',
      // W-2 employees are terminated; contractors have their contract ended.
      visible: (e) => e.worker_type !== '1099',
      fields: () => [
        dateField('effectiveDate', 'Termination date'),
        field('reason', 'Reason', 'select', { options: TERMINATION_REASONS }),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (e) => `Terminate ${workerName(e)}?`,
      effects: ['Employee login is disabled.',
                'Future clock-ins are prevented.',
                'Removed from future route assignments.',
                'Historical records remain intact.'],
      preserves: PRESERVED,
      run(e, v) {
        const routes = endActiveAssignments(e, v.effectiveDate);
        applyStatus(e, 'terminated', {
          effectiveDate: v.effectiveDate, reason: labelFor(TERMINATION_REASONS, v.reason), account: 'deactivated',
        });
        closePeriod(e, v.effectiveDate, 'terminated', labelFor(TERMINATION_REASONS, v.reason));
        return { message: `Employment terminated effective ${v.effectiveDate}.`,
                 routesEnded: routes, warning: routeNote(routes) };
      },
    },

    end_contract: {
      label: 'End Contractor Relationship',
      description: 'End this 1099 contractor’s relationship with the company.',
      tone: 'danger',
      from: ['active', 'on_leave', 'suspended', 'inactive'],
      to: 'contract_ended',
      visible: (e) => e.worker_type === '1099',
      fields: () => [
        dateField('effectiveDate', 'Contract end date'),
        field('reason', 'Reason', 'select', { options: CONTRACT_END_REASONS }),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (e) => `End the contract with ${workerName(e)}?`,
      effects: ['Contractor work access is disabled.',
                'Removed from future route assignments.',
                'Historical records remain intact.'],
      preserves: PRESERVED,
      run(e, v) {
        const routes = endActiveAssignments(e, v.effectiveDate);
        applyStatus(e, 'contract_ended', {
          effectiveDate: v.effectiveDate, reason: labelFor(CONTRACT_END_REASONS, v.reason), account: 'deactivated',
        });
        closePeriod(e, v.effectiveDate, 'contract_ended', labelFor(CONTRACT_END_REASONS, v.reason));
        return { message: `Contract ended effective ${v.effectiveDate}.`,
                 routesEnded: routes, warning: routeNote(routes) };
      },
    },

    archive: {
      label: 'Archive Worker',
      description: 'Move a former worker out of everyday views. All records stay.',
      tone: 'warn',
      from: ['resigned', 'terminated', 'contract_ended', 'inactive'],
      to: 'archived',
      fields: () => [
        field('notes', 'Why is it being archived?', 'textarea', { required: false }),
      ],
      confirmTitle: (e) => `Archive ${workerName(e)}?`,
      effects: ['Removed from everyday workforce views.',
                'Still searchable under Archived / All Workers.',
                'Every record is kept and stays reportable.'],
      preserves: PRESERVED,
      run(e) {
        applyStatus(e, 'archived', { effectiveDate: today(), reason: null, account: 'deactivated' });
        return { message: 'Worker archived. All records remain available.' };
      },
    },

    reactivate: {
      label: 'Rehire / Reactivate Worker',
      description: 'Bring a former worker back. Starts a new employment period.',
      tone: 'primary',
      from: ['resigned', 'terminated', 'contract_ended', 'inactive', 'archived'],
      to: 'active',
      fields: (e) => [
        dateField('effectiveDate', 'Rehire / reactivation date'),
        field('workerType', 'Worker type', 'select',
              { options: WORKER_TYPES, hint: `Currently ${e.worker_type === '1099' ? '1099 Contractor' : 'W-2 Employee'}.` }),
        field('payType', 'Pay type', 'select', { options: PAY_TYPES }),
        field('payRate', 'Pay rate', 'number', { hint: 'Dollars, e.g. 18.00' }),
        field('notes', 'Notes', 'textarea', { required: false }),
      ],
      confirmTitle: (e) => `Rehire ${workerName(e)}?`,
      effects: ['A new active employment period begins.',
                'Login and work access are restored.',
                'The previous employment period is preserved exactly as it was.'],
      preserves: PRESERVED,
      run(e, v, ctx) {
        openPeriod(e, v.effectiveDate, v.workerType);
        run(`UPDATE employees SET status = 'active', status_effective_date = ?, status_reason = NULL,
               end_date = NULL, suspension_end_date = NULL, hire_date = ?, worker_type = ?
             WHERE id = ?`, v.effectiveDate, v.effectiveDate, v.workerType, e.id);
        run(`UPDATE users SET status = 'active' WHERE id = ?`, e.user_id);
        run(`INSERT INTO employee_compensation (employee_id, pay_type, rate_cents, effective_date, created_by)
             VALUES (?, ?, ?, ?, ?)`,
            e.id, v.payType, Math.round(Number(v.payRate) * 100), v.effectiveDate, ctx.userId ?? null);
        return { message: `Rehired effective ${v.effectiveDate}. Previous history preserved.` };
      },
    },
  },
};

/** Which permission each action needs. */
export const WORKER_ACTION_PERMISSION = {
  suspend: 'employees.suspend',
  reinstate: 'employees.suspend',
  mark_inactive: 'employees.terminate',
  resign: 'employees.terminate',
  terminate: 'employees.terminate',
  end_contract: 'employees.terminate',
  archive: 'employees.archive',
  reactivate: 'employees.reactivate',
};
