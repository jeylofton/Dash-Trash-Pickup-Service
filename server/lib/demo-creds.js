/* ============================================================
   Demo login credentials - a development convenience only.

   The live site must never advertise a working password, so this
   endpoint answers outside production alone. In production it 404s
   and the password is never serialised into a response at all. The
   login page fetches this and, only if it succeeds, renders its
   demo block - so nothing about the demo ships in production HTML.

   The accounts are read from the database, one per role that really
   exists, so a demo-data reset or reseed can never leave the hint
   pointing at a login that no longer works. The password mirrors
   DEMO_PASSWORD in db/seed.js (kept as a literal rather than imported
   because seed.js runs seeding work on import).
   ============================================================ */

import { one } from '../db/index.js';

const DEMO_PASSWORD = 'DashDemo2026';
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
    if (row) accounts.push({ email: row.email, role });
  }
  res.json({ password: DEMO_PASSWORD, accounts });
}
