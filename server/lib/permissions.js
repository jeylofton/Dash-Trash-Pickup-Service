/* ============================================================
   Permission checks.

   Admin is allowed everything. Every other role is allowed only
   what role_permissions grants, so adding a Manager never silently
   hands out Admin access.
   ============================================================ */

import { one, all, run } from '../db/index.js';

export function hasPermission(user, permission) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const row = one('SELECT allowed FROM role_permissions WHERE role = ? AND permission = ?',
                  user.role, permission);
  return Boolean(row?.allowed);
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
    if (!hasPermission(req.user, permission)) {
      // 404 rather than 403: do not confirm what exists.
      return res.status(404).json({ error: 'Not found.' });
    }
    next();
  };
}

export function permissionsFor(role) {
  if (role === 'admin') return { all: true, permissions: {} };
  return {
    all: false,
    permissions: Object.fromEntries(
      all('SELECT permission, allowed FROM role_permissions WHERE role = ?', role)
        .map(r => [r.permission, Boolean(r.allowed)])),
  };
}

export const setting = (key, fallback = 0) => {
  const row = one('SELECT value FROM app_settings WHERE key = ?', key);
  return row ? Number(row.value) : fallback;
};

export const setSetting = (key, value, userId) =>
  run(`UPDATE app_settings SET value = ?, updated_by = ?, updated_at = datetime('now')
        WHERE key = ?`, String(value), userId ?? null, key);
