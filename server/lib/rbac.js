/* ============================================================
   Role-based access control.

   The rule this file exists to enforce:
   a user must never reach another user's data by editing a URL.

   Two layers:
     1. requireRole  - is this role allowed on this route at all?
     2. ownership    - for customers and employees, does this
                       specific record belong to them?

   Layer 2 is the one that matters. Route-level checks alone still
   let customer #7 request /api/customer/invoices?customerId=9.
   Every customer query below is therefore scoped by the id from
   the SESSION, never from the request.
   ============================================================ */

import { one } from '../db/index.js';
import { userForToken, COOKIE_NAME } from './auth.js';

/** Attach req.user when a valid session cookie is present. */
export function attachUser(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  req.user = userForToken(token) || null;
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
  next();
}

/**
 * While must_change_password is set, block everything except changing it.
 * Without this, a temporary password would be a fully working login and the
 * "must change" requirement would be cosmetic.
 */
const PASSWORD_EXEMPT = new Set([
  '/api/auth/me', '/api/auth/logout', '/api/auth/change-password', '/api/auth/login',
]);

export function requirePasswordCurrent(req, res, next) {
  if (!req.user) return next();
  if (PASSWORD_EXEMPT.has(req.path) || PASSWORD_EXEMPT.has(req.originalUrl.split('?')[0])) return next();

  const u = one('SELECT must_change_password FROM users WHERE id = ?', req.user.id);
  if (u?.must_change_password) {
    return res.status(403).json({
      error: 'You must choose a new password before continuing.',
      code: 'PASSWORD_CHANGE_REQUIRED',
      redirect: '/dashboard/change-password.html',
    });
  }
  next();
}

/** requireRole('admin') or requireRole('admin', 'employee') */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
    if (!roles.includes(req.user.role)) {
      // 404, not 403: telling an attacker the resource exists is itself a leak.
      return res.status(404).json({ error: 'Not found.' });
    }
    next();
  };
}

/* ---------- Identity resolution ---------- */

/** The customer row for the signed-in user. Never trusts a URL param. */
export function currentCustomer(req) {
  if (req.user?.role !== 'customer') return null;
  return one('SELECT * FROM customers WHERE user_id = ?', req.user.id);
}

/** The employee row for the signed-in user. */
export function currentEmployee(req) {
  if (req.user?.role !== 'employee') return null;
  return one('SELECT * FROM employees WHERE user_id = ?', req.user.id);
}

export function requireCustomer(req, res, next) {
  const customer = currentCustomer(req);
  if (!customer) return res.status(404).json({ error: 'Not found.' });
  req.customer = customer;
  next();
}

export function requireEmployee(req, res, next) {
  const employee = currentEmployee(req);
  if (!employee) return res.status(404).json({ error: 'Not found.' });
  if (employee.status !== 'active') {
    return res.status(403).json({ error: 'This employee account is inactive.' });
  }
  req.employee = employee;
  next();
}

/* ---------- Ownership checks ---------- */

/**
 * Is this unit on a route assigned to this employee on this date?
 * An employee may only record a pickup for a stop that is actually theirs.
 */
export function employeeMayServiceUnit(employeeId, unitId, serviceDate) {
  const row = one(
    `SELECT 1
       FROM service_stops ss
       JOIN route_assignments ra ON ra.route_id = ss.route_id
      WHERE ss.unit_id = ?
        AND ss.service_date = ?
        AND ra.employee_id = ?
        AND ra.effective_date <= ?
        AND (ra.end_date IS NULL OR ra.end_date >= ?)
      LIMIT 1`,
    unitId, serviceDate, employeeId, serviceDate, serviceDate
  );
  return Boolean(row);
}

/** Does this pickup record belong to this customer? */
export function customerOwnsRecord(customerId, recordId) {
  return Boolean(one(
    'SELECT 1 FROM pickup_records WHERE id = ? AND customer_id = ? LIMIT 1',
    recordId, customerId
  ));
}

/** Who may look at a pickup photo: admins always; the customer it belongs to. */
export function mayViewPhoto(user, photoId) {
  if (!user) return false;
  if (user.role === 'admin') return true;

  const row = one(
    `SELECT pr.customer_id, pr.employee_id
       FROM pickup_photos p
       JOIN pickup_records pr ON pr.id = p.pickup_record_id
      WHERE p.id = ?`,
    photoId
  );
  if (!row) return false;

  if (user.role === 'customer') {
    const c = one('SELECT id FROM customers WHERE user_id = ?', user.id);
    return Boolean(c && row.customer_id === c.id);
  }
  if (user.role === 'employee') {
    const e = one('SELECT id FROM employees WHERE user_id = ?', user.id);
    return Boolean(e && row.employee_id === e.id);   // only their own submissions
  }
  return false;
}
