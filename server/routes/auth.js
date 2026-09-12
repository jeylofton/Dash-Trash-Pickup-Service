import { Router } from 'express';
import { one, run } from '../db/index.js';
import {
  hashPassword, verifyPassword, passwordProblem, createSession,
  destroySession, destroyAllSessions, cookieOptions, COOKIE_NAME,
} from '../lib/auth.js';
import { requireAuth } from '../lib/rbac.js';
import { audit } from '../lib/audit.js';

export const router = Router();

/* Sign-in attempt throttling, per IP+email. Keeps password guessing slow. */
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter(t => now - t < 15 * 60_000);
  attempts.set(key, list);
  return list.length >= 8;
}
const noteAttempt = (key) => attempts.get(key)?.push(Date.now()) ?? attempts.set(key, [Date.now()]);

router.post('/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const key = `${req.ip}:${email}`;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (tooManyAttempts(key)) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
  }

  const user = one('SELECT * FROM users WHERE email = ?', email);

  // Always run the hash comparison, even when the user does not exist, so
  // response timing does not reveal which emails are registered.
  const ok = await verifyPassword(password, user?.password_hash || 'scrypt$00$00');

  if (!user || !ok) {
    noteAttempt(key);
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: 'This account is not active. Contact your administrator.' });
  }

  attempts.delete(key);
  const { token } = createSession(user.id, { ip: req.ip, userAgent: req.headers['user-agent'] });
  run(`UPDATE users SET last_login_at = datetime('now') WHERE id = ?`, user.id);

  res.cookie(COOKIE_NAME, token, cookieOptions());
  req.user = user;
  audit(req, 'auth.login', { entityType: 'user', entityId: user.id });

  res.json({
    user: {
      id: user.id, email: user.email, role: user.role,
      firstName: user.first_name, lastName: user.last_name,
    },
    // Where the browser should go next. The server decides, not the client.
    redirect: { admin: '/dashboard/admin/', employee: '/dashboard/employee/', customer: '/dashboard/customer/' }[user.role],
  });
});

router.post('/logout', (req, res) => {
  if (req.user) audit(req, 'auth.logout', { entityType: 'user', entityId: req.user.id });
  destroySession(req.cookies?.[COOKIE_NAME]);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id, email: req.user.email, role: req.user.role,
    firstName: req.user.first_name, lastName: req.user.last_name, phone: req.user.phone,
  });
});

router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = one('SELECT * FROM users WHERE id = ?', req.user.id);

  if (!await verifyPassword(String(currentPassword || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Your current password is incorrect.' });
  }
  const problem = passwordProblem(newPassword);
  if (problem) return res.status(400).json({ error: problem });

  run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(newPassword), user.id);
  destroyAllSessions(user.id);            // sign out everywhere after a change
  audit(req, 'auth.password_changed', { entityType: 'user', entityId: user.id });
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true, message: 'Password updated. Please sign in again.' });
});
