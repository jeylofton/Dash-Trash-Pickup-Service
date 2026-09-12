/* ============================================================
   Is this record safe to permanently delete?

   The rule: a record may be deleted only if nothing historical or
   operational points at it. Anything with real history is archived
   instead, never destroyed.

   The SERVER decides. The UI asks this before showing a Delete
   button, and the DELETE route asks it again before acting — so a
   hand-crafted request cannot destroy history either.
   ============================================================ */

import { one, all } from '../db/index.js';

const count = (sql, ...params) => one(sql, ...params)?.n ?? 0;

/** Each entity lists the relationships that block deletion. */
const RULES = {
  route: (id) => [
    { label: 'pickup records', n: count('SELECT COUNT(*) n FROM pickup_records WHERE route_id = ?', id) },
    { label: 'scheduled stops', n: count('SELECT COUNT(*) n FROM service_stops WHERE route_id = ?', id) },
    { label: 'time entries', n: count('SELECT COUNT(*) n FROM time_entries WHERE route_id = ?', id) },
    { label: 'driver assignments', n: count('SELECT COUNT(*) n FROM route_assignments WHERE route_id = ?', id) },
    { label: 'service credits', n: count('SELECT COUNT(*) n FROM service_credits WHERE route_id = ?', id) },
    { label: 'attributed expenses', n: count('SELECT COUNT(*) n FROM expenses WHERE route_id = ?', id) },
  ],

  community: (id) => [
    { label: 'customers at this property',
      n: count(`SELECT COUNT(*) n FROM units u JOIN service_addresses sa ON sa.unit_id = u.id
                 WHERE u.community_id = ?`, id) },
    { label: 'pickup records',
      n: count(`SELECT COUNT(*) n FROM units u JOIN pickup_records pr ON pr.unit_id = u.id
                 WHERE u.community_id = ?`, id) },
    { label: 'route stops', n: count('SELECT COUNT(*) n FROM route_stops WHERE community_id = ?', id) },
    { label: 'service credits', n: count('SELECT COUNT(*) n FROM service_credits WHERE community_id = ?', id) },
    { label: 'attributed expenses', n: count('SELECT COUNT(*) n FROM expenses WHERE community_id = ?', id) },
    { label: 'waiting-list entries', n: count('SELECT COUNT(*) n FROM community_waitlist WHERE community_id = ?', id) },
  ],

  employee: (id) => [
    { label: 'pickup records', n: count('SELECT COUNT(*) n FROM pickup_records WHERE employee_id = ?', id) },
    { label: 'time entries', n: count('SELECT COUNT(*) n FROM time_entries WHERE employee_id = ?', id) },
    { label: 'route assignments', n: count('SELECT COUNT(*) n FROM route_assignments WHERE employee_id = ?', id) },
    { label: 'service credits issued', n: count('SELECT COUNT(*) n FROM service_credits WHERE requested_by_employee_id = ?', id) },
    { label: 'pay rate history', n: count('SELECT COUNT(*) n FROM employee_compensation WHERE employee_id = ?', id) },
  ],

  coupon: (id) => [
    { label: 'redemptions', n: count(`SELECT COUNT(*) n FROM coupon_redemptions WHERE coupon_id = ?`, id) },
    { label: 'waiting-list holds', n: count('SELECT COUNT(*) n FROM community_waitlist WHERE coupon_id = ?', id) },
  ],

  unit: (id) => [
    { label: 'pickup records', n: count('SELECT COUNT(*) n FROM pickup_records WHERE unit_id = ?', id) },
    { label: 'customer assignments', n: count('SELECT COUNT(*) n FROM service_addresses WHERE unit_id = ?', id) },
    { label: 'scheduled stops', n: count('SELECT COUNT(*) n FROM service_stops WHERE unit_id = ?', id) },
  ],

  role: (key) => [
    { label: 'users holding this role', n: count('SELECT COUNT(*) n FROM users WHERE role = ?', key) },
    { label: 'role assignments', n: count('SELECT COUNT(*) n FROM user_roles WHERE role_key = ?', key) },
  ],

  expense: () => [],   // an expense has no dependents; a mistyped one can go
};

/** Records that are never deletable no matter what, by their nature. */
const NEVER = {
  role: (key, row) => row?.is_system ? 'Built-in roles cannot be deleted.' : null,
};

/**
 * @returns {{ deletable, blockers, reason, action }}
 *   action is what the UI should offer: 'delete' or 'archive'.
 */
export function deletability(entityType, id, row = null) {
  const rule = RULES[entityType];
  if (!rule) return { deletable: false, blockers: [], reason: 'Unknown record type.', action: 'archive' };

  const never = NEVER[entityType]?.(id, row);
  if (never) return { deletable: false, blockers: [], reason: never, action: 'archive' };

  const blockers = rule(id).filter(b => b.n > 0);
  if (blockers.length) {
    return {
      deletable: false,
      blockers,
      reason: `This record has history: ${blockers.map(b => `${b.n} ${b.label}`).join(', ')}.`,
      action: 'archive',
    };
  }
  return {
    deletable: true,
    blockers: [],
    reason: 'This record has never been used and can be permanently deleted.',
    action: 'delete',
  };
}

/** Throws a 409 if deletion is not safe. Used by every DELETE route. */
export function assertDeletable(entityType, id, row = null) {
  const result = deletability(entityType, id, row);
  if (!result.deletable) {
    throw Object.assign(new Error(result.reason), {
      status: 409,
      code: 'HAS_HISTORY',
      blockers: result.blockers,
      suggestion: 'Archive this record instead — its history stays intact.',
    });
  }
  return result;
}
