/* ============================================================
   Demo login credentials - a development convenience only.

   The live site must never advertise a working password, so this
   endpoint answers outside production alone. In production it 404s
   and the password is never serialised into a response at all. The
   login page fetches this and, only if it succeeds, renders its
   demo block - so nothing about the demo ships in production HTML.

   The accounts are read from the database, one per role that really
   exists, so a demo-data reset or reseed can never leave the hint
   pointing at a login that no longer works. Each role is seeded with
   its OWN password (db/seed.js): the owner keeps a real password while
   the training customer and employee use intentionally simple ones.
   The hint therefore reports a password PER account - advertising one
   shared password made every account but the owner's fail to log in.
   These mirror the literals in db/seed.js (kept as literals rather than
   imported because seed.js runs seeding work on import).
   ============================================================ */

import { one } from '../db/index.js';

// role -> the plaintext that role is seeded with, mirroring db/seed.js.
const DEMO_PASSWORD = {
  admin: 'DashDemo2026',
  employee: 'employee',
  customer: 'customer',
};
const ROLES = ['admin', 'employee', 'customer'];

export function devDemoCreds(req, res) {
  if (process.env.NODE_ENV === 'production') {
    return res.status(404).json({ error: 'Not found.' });
  }
  const accounts = [];
  for (const role of ROLES) {
    const row = one(
      `SELECT email FROM users WHERE role = ? AND status = 'active' ORDER BY id LIMIT 1`,
      role
    );
    if (row) accounts.push({ email: row.email, role, password: DEMO_PASSWORD[role] });
  }
  res.json({ accounts });
}
