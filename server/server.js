/* ============================================================
   Dash Trash Pickup - Square payment backend

   Endpoints
     GET  /api/config            publishable Square IDs for the browser
     GET  /api/intro-spots       how many introductory spots are used
     GET  /api/service-area      ZIP coverage check
     POST /api/checkout          customer -> card on file -> subscription
     POST /api/webhooks/square   Square tells us about renewals/failures
     GET  /api/health

   Run:  cp .env.example .env && npm install && npm start
   ============================================================ */

import 'dotenv/config';
import express from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createCustomer, saveCard, createSubscription,
         verifyCredentials, SquareError, squareEnvironment } from './lib/payments/square.js';
import { getIntroClaimed, reserveIntroSpot, releaseIntroSpot, recordSignup } from './store.js';
import { migrate } from './db/index.js';
import { attachUser } from './lib/rbac.js';
import { purgeExpiredSessions } from './lib/auth.js';
import { router as authRouter }     from './routes/auth.js';
import { router as adminRouter }    from './routes/admin.js';
import { router as employeeRouter } from './routes/employee.js';
import { router as customerRouter } from './routes/customer.js';
import { router as photosRouter }   from './routes/photos.js';
import { router as financeRouter }  from './routes/finance.js';
import { attachDevReload } from './lib/devreload.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = express();
const PORT = process.env.PORT || 3000;

/* ---------- Business rules. Keep these in step with CONFIG in scripts.js. ---------- */
const INTRO_TOTAL_SPOTS = 100;
const SERVICE_ZIPS = new Set([
  '31901','31902','31903','31904','31905','31906',
  '31907','31908','31909','31914','31917',
]);

const PLAN_VARIATIONS = {
  Introductory: process.env.SQUARE_PLAN_INTRODUCTORY,
  Monthly:      process.env.SQUARE_PLAN_MONTHLY,
  Quarterly:    process.env.SQUARE_PLAN_QUARTERLY,
  Annual:       process.env.SQUARE_PLAN_ANNUAL,
};

/* ---------- Middleware ---------- */

// The webhook route needs the RAW body to verify Square's signature, so it is
// registered before express.json() and uses its own raw parser.
app.post('/api/webhooks/square',
  express.raw({ type: 'application/json' }),
  handleWebhook);

// Photos arrive as base64 in JSON from the phone camera, so this has to be
// larger than a typical API. storage.js still enforces the real per-file cap.
app.use(express.json({ limit: '12mb' }));

/* Minimal cookie parser - avoids a dependency for six lines of work. */
app.use((req, res, next) => {
  req.cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => {
      const i = c.indexOf('=');
      return i < 0 ? null : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
    }).filter(Boolean)
  );
  res.cookie = (name, value, opts = {}) => {
    const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${opts.path || '/'}`];
    if (opts.httpOnly) parts.push('HttpOnly');
    if (opts.secure) parts.push('Secure');
    if (opts.sameSite) parts.push(`SameSite=${opts.sameSite[0].toUpperCase() + opts.sameSite.slice(1)}`);
    if (opts.maxAge) parts.push(`Max-Age=${Math.floor(opts.maxAge / 1000)}`);
    res.append('Set-Cookie', parts.join('; '));
    return res;
  };
  res.clearCookie = (name, opts = {}) =>
    res.append('Set-Cookie', `${name}=; Path=${opts.path || '/'}; Max-Age=0`);
  next();
});

app.use(attachUser);

const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* Very small in-memory rate limit on checkout. Real deployments should use a
   proper limiter, but this stops trivial hammering of the Square API. */
const hits = new Map();
function rateLimit(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const window = 60_000, max = 10;
  const list = (hits.get(key) || []).filter(t => now - t < window);
  if (list.length >= max) {
    return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a minute.' });
  }
  list.push(now);
  hits.set(key, list);
  next();
}

/* ---------- Routes ---------- */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, environment: squareEnvironment });
});

/** Treat an unedited .env.example value as "not configured" rather than
 *  handing the browser a placeholder that Square will reject with a confusing
 *  error. Returning null puts the site cleanly into demo mode instead. */
const real = (v) => (v && !v.includes('...') && v.trim() !== '' ? v : null);

// Only publishable values. The access token is never sent here.
app.get('/api/config', (req, res) => {
  const applicationId = real(process.env.SQUARE_APPLICATION_ID);
  const locationId = real(process.env.SQUARE_LOCATION_ID);
  if (!applicationId || !locationId) {
    console.warn('[config] SQUARE_APPLICATION_ID / SQUARE_LOCATION_ID not set - site will run in demo mode');
  }
  res.json({ applicationId, locationId, environment: squareEnvironment });
});

app.get('/api/intro-spots', async (req, res) => {
  try {
    res.json({ claimed: await getIntroClaimed(), totalSpots: INTRO_TOTAL_SPOTS });
  } catch (err) {
    console.error('[intro-spots]', err);
    res.status(500).json({ error: 'Could not read spot count.' });
  }
});

app.get('/api/service-area', (req, res) => {
  const zip = String(req.query.zip || '').trim();
  res.json({ available: SERVICE_ZIPS.has(zip) });
});

app.post('/api/checkout', rateLimit, async (req, res) => {
  const {
    sourceId, plan, firstName, lastName, email, phone,
    street, unit, community, zip, startDate,
  } = req.body || {};

  /* --- validate before touching Square --- */
  const missing = Object.entries({
    sourceId, plan, firstName, lastName, email, phone, street, unit, community, zip,
  }).filter(([, v]) => !v).map(([k]) => k);

  if (missing.length) {
    return res.status(400).json({ ok: false, error: `Missing required fields: ${missing.join(', ')}` });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'That email address is not valid.' });
  }
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ ok: false, error: 'ZIP code must be 5 digits.' });
  }

  const planVariationId = PLAN_VARIATIONS[plan];
  if (!planVariationId) {
    return res.status(400).json({
      ok: false,
      error: `No Square plan configured for "${plan}". Set the matching SQUARE_PLAN_* value in .env.`,
    });
  }

  /* --- reserve the introductory spot BEFORE charging ---
     Reserving first means we never charge someone the intro rate when the
     100 are gone. If Square then fails, we hand the spot back below. */
  const wantsIntro = plan === 'Introductory';
  let introReserved = false;

  if (wantsIntro) {
    introReserved = await reserveIntroSpot(INTRO_TOTAL_SPOTS);
    if (!introReserved) {
      return res.status(409).json({
        ok: false,
        code: 'INTRO_SOLD_OUT',
        error: 'The introductory offer just sold out. Please choose another plan.',
      });
    }
  }

  try {
    const customer = await createCustomer({
      firstName, lastName, email, phone,
      address: { street, unit, community, zip, city: 'Columbus', state: 'GA' },
    });

    const card = await saveCard({
      sourceId,
      customerId: customer.id,
      cardholderName: `${firstName} ${lastName}`,
      billingZip: zip,
    });

    const subscription = await createSubscription({
      planVariationId,
      customerId: customer.id,
      cardId: card.id,
      startDate: normalizeStartDate(startDate),
      locationId: process.env.SQUARE_LOCATION_ID,
    });

    await recordSignup({
      subscriptionId: subscription.id,
      customerId: customer.id,
      plan, email, community, zip,
      introApplied: introReserved,
    });

    res.json({
      ok: true,
      confirmationId: subscription.id,
      introApplied: introReserved,
      startDate: subscription.start_date || null,
    });

  } catch (err) {
    // Charging failed, so the reserved spot must go back to the pool.
    if (introReserved) await releaseIntroSpot();

    if (err instanceof SquareError) {
      console.error('[checkout] Square error', err.endpoint, err.errors);
      return res.status(402).json({ ok: false, error: err.publicMessage() });
    }
    console.error('[checkout]', err);
    res.status(500).json({ ok: false, error: 'Something went wrong. You have not been charged.' });
  }
});

/* ---------- Dashboard (authenticated) ---------- */

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = join(HERE, '..');

app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);
app.use('/api/employee', employeeRouter);
app.use('/api/customer', customerRouter);
app.use('/api/photos', photosRouter);
app.use('/api/finance', financeRouter);   // admin-only, enforced inside the router

/* Gate the dashboard HTML itself. Without this a signed-out visitor could
   load the admin page shell; the API would refuse its calls, but the page
   should not render at all. Role is checked here too, so an employee cannot
   open /dashboard/admin/ by typing the URL. */
const ROLE_FOR_PREFIX = {
  '/dashboard/admin': 'admin',
  '/dashboard/employee': 'employee',
  '/dashboard/customer': 'customer',
};

app.use('/dashboard', (req, res, next) => {
  const path = '/dashboard' + req.path.replace(/\/$/, '');
  const needed = Object.entries(ROLE_FOR_PREFIX).find(([prefix]) => path.startsWith(prefix))?.[1];
  if (!needed) return next();                       // login page and shared assets

  if (!req.user) return res.redirect('/dashboard/login.html');
  if (req.user.role !== needed) {
    return res.redirect(`/dashboard/${req.user.role}/`);   // send them to their own
  }
  next();
});

/* Live reload in development. Must come before EVERY express.static mount so
   it can inject its snippet into the HTML rather than the raw file going out. */
const DEV = process.env.NODE_ENV !== 'production' && process.env.DEV_RELOAD !== '0';
if (DEV) attachDevReload(app, SITE_ROOT);

app.use('/dashboard', express.static(join(SITE_ROOT, 'dashboard'), { extensions: ['html'] }));

/* Block private directories BEFORE static serving.
   A setHeaders hook cannot do this - it can set a status code but the file
   body is still streamed, which would serve the source code and the database
   itself (password hashes, customer PII) to anyone who asked. */
const PRIVATE_PATH = /^\/(server|node_modules|\.git|\.vscode)(\/|$)/i;

app.use((req, res, next) => {
  if (PRIVATE_PATH.test(req.path)) return res.status(404).json({ error: 'Not found.' });
  next();
});

/* The public marketing site. */
app.use(express.static(SITE_ROOT, {
  index: 'index.html',
  dotfiles: 'ignore',   // never serve .env, .git, etc.
}));

/* ---------- Webhook ---------- */

function handleWebhook(req, res) {
  const key = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;
  const url = process.env.WEBHOOK_URL;

  if (!key || !url) {
    console.warn('[webhook] not configured; ignoring');
    return res.sendStatus(200);
  }

  // Square signs `notification_url + raw_body` with HMAC-SHA256.
  const signature = req.headers['x-square-hmacsha256-signature'] || '';
  const expected = createHmac('sha256', key).update(url + req.body.toString('utf8')).digest('base64');

  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    console.warn('[webhook] bad signature - rejected');
    return res.sendStatus(403);
  }

  const event = JSON.parse(req.body.toString('utf8'));
  switch (event.type) {
    case 'invoice.payment_made':
      console.log('[webhook] renewal paid:', event.data?.id);
      break;
    case 'subscription.updated':
      console.log('[webhook] subscription updated:', event.data?.id);
      break;
    case 'invoice.scheduled_charge_failed':
      // TODO: email the customer, flag the account, pause service
      console.warn('[webhook] renewal FAILED:', event.data?.id);
      break;
    default:
      console.log('[webhook]', event.type);
  }
  res.sendStatus(200);
}

/* ---------- Helpers ---------- */

/** Square wants YYYY-MM-DD and will reject a date in the past. */
function normalizeStartDate(input) {
  const today = new Date().toISOString().slice(0, 10);
  if (!input || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return today;
  return input < today ? today : input;
}

/* ---------- Errors ----------
   Express's default handler renders the stack trace into the RESPONSE,
   which hands an attacker absolute file paths and internal structure.
   Log it server-side; tell the client nothing. */

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  console.error('[error]', req.method, req.originalUrl, err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Something went wrong. Please try again.' });
});

/* ---------- Boot ---------- */

migrate();
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();

app.listen(PORT, async () => {
  console.log(`\n  Dash Trash Pickup API`);
  console.log(`  http://localhost:${PORT}   [${squareEnvironment}]\n`);

  const unset = Object.entries(PLAN_VARIATIONS).filter(([, v]) => !v).map(([k]) => k);
  if (unset.length) {
    console.warn(`  ! No Square plan variation ID for: ${unset.join(', ')}`);
    console.warn(`    Those plans will be refused at checkout until you set them in .env\n`);
  }

  try {
    const locations = await verifyCredentials();
    console.log(`  Square credentials OK - ${locations.length} location(s) found`);
    const configured = locations.find(l => l.id === process.env.SQUARE_LOCATION_ID);
    console.log(configured
      ? `  Using location: ${configured.name} (${configured.id})\n`
      : `  ! SQUARE_LOCATION_ID does not match any location on this account\n`);
  } catch (err) {
    console.error(`  ! Square credentials failed: ${err.message}`);
    console.error(`    Check SQUARE_ACCESS_TOKEN and SQUARE_ENVIRONMENT in .env\n`);
  }
});
