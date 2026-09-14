/* ============================================================
   Passwords and sessions.

   Passwords: scrypt from node:crypto. Deliberately slow, salted
   per user, and compared in constant time.

   Sessions: a random token in an httpOnly cookie. Only the SHA-256
   of the token is stored, so a database dump yields no usable
   sessions. httpOnly means page scripts cannot read it, which is
   what makes an XSS bug non-fatal.
   ============================================================ */

import { randomBytes, scrypt as _scrypt, scryptSync, timingSafeEqual, createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { one, run } from '../db/index.js';

const scrypt = promisify(_scrypt);
const KEYLEN = 64;
export const COOKIE_NAME = 'dash_session';

/* A stolen or forgotten privileged cookie is far more dangerous than a
   customer's, so staff sessions are short-lived while customers keep the
   long, convenience-oriented lifetime. An unknown role fails safe to the
   short one - we never hand out a two-week cookie to a role we can't name. */
const PRIVILEGED_DAYS = 1;
const CUSTOMER_DAYS = 14;
function sessionDaysFor(role) {
  return role === 'customer' ? CUSTOMER_DAYS : PRIVILEGED_DAYS;
}

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

/* Synchronous twin of hashPassword, producing the identical
   `scrypt$salt$key` format verifyPassword expects. Used by the boot-time
   seed (db/seed.js) so seeding needs no top-level await - a managed host
   like Hostinger/Passenger imports server.js, and a top-level await in that
   import graph can stall startup. Only ever used to seed fixed demo
   accounts, never on a request path, so the sync CPU cost is irrelevant. */
export function hashPasswordSync(password) {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hex) return false;
    const key = await scrypt(password, salt, KEYLEN);
    const expected = Buffer.from(hex, 'hex');
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

export function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters.';
  }
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return 'Password must contain both letters and numbers.';
  }
  return null;
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function createSession(userId, { ip, userAgent, role } = {}) {
  const token = randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + sessionDaysFor(role) * 86400_000).toISOString();
  run(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?, ?)`,
    randomUUID(), userId, sha256(token), expires, ip || null, userAgent || null
  );
  return { token, expires };
}

export function userForToken(token) {
  if (!token) return null;
  const row = one(
    `SELECT u.id, u.email, u.role, u.first_name, u.last_name, u.phone, u.status,
            s.id AS session_id, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
    sha256(token)
  );
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    run('DELETE FROM sessions WHERE id = ?', row.session_id);
    return null;
  }
  if (row.status !== 'active') return null;   // suspended mid-session
  return row;
}

export function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function destroyAllSessions(userId) {
  run('DELETE FROM sessions WHERE user_id = ?', userId);
}

export function purgeExpiredSessions() {
  run(`DELETE FROM sessions WHERE expires_at < datetime('now')`);
}

export function cookieOptions(role) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: sessionDaysFor(role) * 86400_000,
    path: '/',
  };
}
