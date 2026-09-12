/* ============================================================
   Service-recovery credits.

   An employee may issue up to the configured limit ($5) on their
   own. Anything above it becomes a request that does nothing until
   a manager or admin approves it.

   The threshold is checked on the SERVER. A tampered client that
   posts $500 still lands in the approval queue.
   ============================================================ */

import { one, all, run, tx } from '../db/index.js';
import { setting } from './permissions.js';

export const REASONS = [
  'missed_pickup', 'late_pickup', 'service_error', 'damaged_property',
  'customer_complaint', 'billing_adjustment', 'courtesy', 'other',
];

export const REASON_LABELS = {
  missed_pickup: 'Missed pickup', late_pickup: 'Late pickup',
  service_error: 'Service error', damaged_property: 'Damaged property',
  customer_complaint: 'Customer complaint', billing_adjustment: 'Billing adjustment',
  courtesy: 'Courtesy credit', other: 'Other',
};

/** Statuses that represent money actually given to a customer. */
export const GRANTED = `status IN ('auto_approved','approved','modified','applied')`;

export function monthlyIssuedByEmployee(employeeId) {
  return one(
    `SELECT COALESCE(SUM(COALESCE(approved_cents, requested_cents)),0) AS cents
       FROM service_credits
      WHERE requested_by_employee_id = ? AND ${GRANTED}
        AND strftime('%Y-%m', requested_at) = strftime('%Y-%m','now')`,
    employeeId).cents;
}

export function monthlyReceivedByCustomer(customerId) {
  return one(
    `SELECT COALESCE(SUM(COALESCE(approved_cents, requested_cents)),0) AS cents
       FROM service_credits
      WHERE customer_id = ? AND ${GRANTED}
        AND strftime('%Y-%m', requested_at) = strftime('%Y-%m','now')`,
    customerId).cents;
}

/**
 * Create a credit. Returns the row; `status` tells the caller whether
 * it took effect immediately or needs approval.
 */
export function createCredit({
  customerId, userId, employeeId, amountCents, reason, notes,
  pickupRecordId, communityId, routeId, isPrivileged,
}) {
  if (!REASONS.includes(reason)) {
    throw Object.assign(new Error('Choose a valid reason.'), { status: 400 });
  }
  if (reason === 'other' && !String(notes || '').trim()) {
    throw Object.assign(new Error('Notes are required when the reason is "Other".'), { status: 400 });
  }
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw Object.assign(new Error('Enter a credit amount greater than zero.'), { status: 400 });
  }

  const employeeMax = setting('credit.employee_max_cents', 500);
  const employeeMonthlyCap = setting('credit.employee_monthly_cap_cents', 5000);
  const customerMonthlyCap = setting('credit.per_customer_monthly_cents', 2000);

  // A manager or admin issuing directly is approved on the spot.
  let status = isPrivileged ? 'approved' : 'pending';

  if (!isPrivileged) {
    if (amountCents <= employeeMax) {
      status = 'auto_approved';

      // Even within the per-credit limit, the monthly caps still apply —
      // otherwise $5 at a time adds up unchecked.
      if (employeeId && monthlyIssuedByEmployee(employeeId) + amountCents > employeeMonthlyCap) {
        status = 'pending';
      }
      if (monthlyReceivedByCustomer(customerId) + amountCents > customerMonthlyCap) {
        status = 'pending';
      }
    }
  }

  const approved = (status === 'auto_approved' || status === 'approved') ? amountCents : null;

  const id = run(
    `INSERT INTO service_credits
       (customer_id, requested_by_user_id, requested_by_employee_id, approved_by_user_id,
        requested_cents, approved_cents, reason, notes,
        pickup_record_id, community_id, route_id, status, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    customerId, userId ?? null, employeeId ?? null,
    approved != null ? (userId ?? null) : null,
    amountCents, approved, reason, notes ?? null,
    pickupRecordId ?? null, communityId ?? null, routeId ?? null,
    status, approved != null ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null
  ).lastInsertRowid;

  return one('SELECT * FROM service_credits WHERE id = ?', id);
}

/** Approve, modify the amount, or reject a pending request. */
export function decide({ creditId, decision, approvedCents, userId, decisionNotes }) {
  const credit = one('SELECT * FROM service_credits WHERE id = ?', creditId);
  if (!credit) throw Object.assign(new Error('Credit not found.'), { status: 404 });
  if (credit.status !== 'pending') {
    throw Object.assign(new Error(`That request is already ${credit.status.replace('_', ' ')}.`),
                        { status: 409 });
  }

  let status, finalCents = null;
  if (decision === 'approve') { status = 'approved'; finalCents = credit.requested_cents; }
  else if (decision === 'modify') {
    if (!Number.isInteger(approvedCents) || approvedCents <= 0) {
      throw Object.assign(new Error('Enter the amount to approve.'), { status: 400 });
    }
    if (approvedCents > credit.requested_cents) {
      throw Object.assign(new Error('The approved amount cannot exceed what was requested.'),
                          { status: 400 });
    }
    status = 'modified'; finalCents = approvedCents;
  }
  else if (decision === 'reject') { status = 'rejected'; }
  else throw Object.assign(new Error('Decision must be approve, modify, or reject.'), { status: 400 });

  run(`UPDATE service_credits
          SET status = ?, approved_cents = ?, approved_by_user_id = ?,
              decision_notes = ?, decided_at = datetime('now')
        WHERE id = ?`,
      status, finalCents, userId, decisionNotes ?? null, creditId);

  return { before: credit, after: one('SELECT * FROM service_credits WHERE id = ?', creditId) };
}

/** Credit balance a customer can see: granted, minus anything already applied. */
export function customerBalanceCents(customerId) {
  return one(`SELECT COALESCE(SUM(COALESCE(approved_cents, requested_cents)),0) AS cents
                FROM service_credits
               WHERE customer_id = ? AND status IN ('auto_approved','approved','modified')`,
             customerId).cents;
}
