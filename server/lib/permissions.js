/* ============================================================
   Permission checks.

   Admin is allowed everything. Every other role — built-in or
   custom — is allowed only what role_permissions grants.

   ENFORCED ON THE SERVER. Hiding a button is presentation; this is
   the actual gate, so a hand-crafted request is refused too.
   ============================================================ */

import { one, all, run } from '../db/index.js';

/** Roles held by a user. users.role is primary; user_roles allows more later. */
export function rolesFor(user) {
  if (!user) return [];
  const extra = all('SELECT role_key FROM user_roles WHERE user_id = ?', user.id)
    .map(r => r.role_key);
  return [...new Set([user.role, ...extra])].filter(Boolean);
}

export function hasPermission(user, permission) {
  if (!user) return false;
  const roles = rolesFor(user);
  if (roles.includes('admin')) return true;          // admin is absolute

  for (const key of roles) {
    // An archived or inactive role grants nothing.
    const role = one(`SELECT status FROM roles WHERE key = ?`, key);
    if (role && role.status !== 'active') continue;
    const row = one('SELECT allowed FROM role_permissions WHERE role_key = ? AND permission = ?',
                    key, permission);
    if (row?.allowed) return true;                   // any role granting it is enough
  }
  return false;
}

/** requirePermission('routes.edit') — or several, any of which suffices. */
export function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Sign in required.' });
    if (permissions.some(p => hasPermission(req.user, p))) return next();
    // 404 rather than 403: do not confirm what exists.
    return res.status(404).json({ error: 'Not found.' });
  };
}

/** Every permission this user actually has — what the UI should render. */
export function permissionsFor(roleOrUser) {
  const user = typeof roleOrUser === 'string' ? { role: roleOrUser, id: -1 } : roleOrUser;
  const roles = typeof roleOrUser === 'string' ? [roleOrUser] : rolesFor(user);
  if (roles.includes('admin')) {
    return {
      roles, all: true,
      permissions: Object.fromEntries(all('SELECT key FROM permissions').map(p => [p.key, true])),
    };
  }
  const granted = {};
  for (const key of roles) {
    const role = one('SELECT status FROM roles WHERE key = ?', key);
    if (role && role.status !== 'active') continue;
    for (const r of all('SELECT permission, allowed FROM role_permissions WHERE role_key = ?', key)) {
      if (r.allowed) granted[r.permission] = true;
    }
  }
  return { roles, all: false, permissions: granted };
}

export const setting = (key, fallback = 0) => {
  const row = one('SELECT value FROM app_settings WHERE key = ?', key);
  return row ? Number(row.value) : fallback;
};

export const setSetting = (key, value, userId) =>
  run(`UPDATE app_settings SET value = ?, updated_by = ?, updated_at = datetime('now')
        WHERE key = ?`, String(value), userId ?? null, key);
