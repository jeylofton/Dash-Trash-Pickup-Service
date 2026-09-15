/* ============================================================
   Dash Trash Pickup - payment backend

   Endpoints
     GET  /api/config            active payment provider info for the browser
     GET  /api/intro-spots       how many introductory spots are used
     GET  /api/service-area      ZIP coverage check
     POST /api/checkout          customer -> card on file -> subscription
     GET  /api/health

   Run:  cp .env.example .env && npm install && npm start
   ============================================================ */

import './loadenv.js';
import express from 'express';
import { migrate, one, migrateDemoFlags } from './db/index.js';
import { enrol } from './lib/signup.js';
import { payments, providerName } from './lib/payments/index.js';
import { migrateAdmin, migrateCommunities, migrateIssueCodes, migrateAdminControls, migrateDynamicRoles, migrateWorkerBanking } from './db/migrate_admin.js';
import { migrateCommunityLifecycle } from './db/migrate_lifecycle.js';
import { migratePlans, ensureDefaultPlans } from './db/migrate_plans.js';
import { applyDuePriceChanges, listPublicPlans } from './lib/plans.js';
import { seedFreshInstall } from './db/seed.js';
import { introCoupon } from './lib/coupons.js';
import { attachUser, requirePasswordCurrent } from './lib/rbac.js';
import { purgeExpiredSessions } from './lib/auth.js';
import { securityHeaders, forceHttps } from './lib/security.js';
import { devDemoCreds } from './lib/demo-creds.js';
import { router as authRouter }     from './routes/auth.js';
import { router as adminRouter }    from './routes/admin.js';
import { router as employeeRouter } from './routes/employee.js';
import { router as customerRouter } from './routes/customer.js';
import { router as photosRouter }   from './routes/photos.js';
import { router as financeRouter }  from './routes/finance.js';
import { router as peopleRouter }   from './routes/people.js';
import { router as discountRouter } from './routes/discounts.js';
import { router as communityRouter, publicCommunityRoutes } from './routes/communities.js';
import { router as rolesRouter } from './routes/roles.js';
import { router as settingsRouter } from './routes/settings.js';
import { router as plansRouter } from './routes/plans.js';
import { publicBranding } from './lib/branding.js';
import { attachDevReload, DEV_RELOAD_SNIPPET } from './lib/devreload.js';
import { attachBrandedHtml } from './lib/htmlserve.js';
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

/* ---------- Middleware ---------- */

// Behind a TLS proxy in production, express only trusts x-forwarded-* when
// told to. Without this req.secure is always false and req.ip is the proxy.
app.set('trust proxy', 1);

// Send every request to HTTPS in production, and stamp every response with
// the baseline hardening headers. Both run before anything else so no route
// or static file can slip out unprotected.
app.use(forceHttps);
app.use(securityHeaders);

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
app.use('/api', requirePasswordCurrent);

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
   proper limiter, but this stops trivial hammering of the payment provider. */
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
  res.json({ ok: true, provider: providerName });
});

// Tells the browser which provider is active and what its UI needs to show -
// e.g. whether to render card fields (collectsCard) or outcome buttons
// (simulates). Sourced entirely from the payments module, never from
// provider-specific env vars.
app.get('/api/config', (req, res) => {
  res.json({
    provider: providerName,
    collectsCard: payments.collectsCard,
    simulates: payments.simulates,
    outcomes: payments.OUTCOMES || [],
  });
});

// Public business identity for the browser to render (name, short name,
// website, support contacts, address). Never the internal email/phone.
app.get('/api/branding', (req, res) => {
  res.json(publicBranding());
});

// The public plan feed the marketing homepage and the Start Service signup
// render from — the SAME plans the admin manages (routes/plans.js), so there
// is one source of truth and an admin price/label/order edit flows to every
// customer-facing surface with no code change. Only active, customer-available,
// non-intro plans are exposed. See lib/plans.js#listPublicPlans.
app.get('/api/subscription-plans/public', (req, res) => {
  try {
    res.json({ plans: listPublicPlans() });
  } catch (err) {
    console.error('[public-plans]', err);
    res.status(500).json({ error: 'Could not load plans.' });
  }
});

app.get('/api/intro-spots', async (req, res) => {
  try {
    /* Read from the real coupon system. If an install has no launch coupon
       configured, fall back to counting intro customers straight from the
       database - the only other place that number is ever recorded. */
    const coupon = introCoupon();
    if (coupon) {
      return res.json({
        claimed: coupon.used,
        totalSpots: coupon.max_redemptions ?? INTRO_TOTAL_SPOTS,
        code: coupon.code,
        priceDollars: coupon.discount_type === 'promo_price'
          ? coupon.discount_value / 100 : null,
        status: coupon.status,
      });
    }
    const claimed = one(`SELECT COUNT(*) AS n FROM customers WHERE is_intro = 1`).n;
    res.json({ claimed, totalSpots: INTRO_TOTAL_SPOTS });
  } catch (err) {
    console.error('[intro-spots]', err);
    res.status(500).json({ error: 'Could not read spot count.' });
  }
});

// Demo login hint - answers outside production only (see lib/demo-creds.js).
// The login page renders its demo block solely from this, so the live site
// never ships the demo password.
app.get('/api/dev-demo', devDemoCreds);

app.get('/api/service-area', (req, res) => {
  const zip = String(req.query.zip || '').trim();
  res.json({ available: SERVICE_ZIPS.has(zip) });
});

app.post('/api/checkout', rateLimit, async (req, res) => {
  const result = await enrol({ ...req.body, outcome: req.body.outcome || 'success' });
  if (!result.ok) {
    // Pending is not a failure - the charge just hasn't settled yet, and
    // the subscription kept whatever promotional terms it was quoted. A
    // 4xx here would read as an error to the client when nothing failed.
    if (result.status === 'pending') {
      return res.status(202).json({
        ok: false,
        status: 'pending',
        message: "Your payment is still processing. We'll confirm once it clears.",
        confirmationId: result.paymentId,
        subscriptionId: result.subscriptionId,
        introApplied: result.introApplied,
        amountCents: result.amountCents,
      });
    }
    return res.status(result.status === 'failed' ? 402 : 400)
              .json({ ok: false, error: result.error, status: result.status });
  }
  res.json({
    ok: true,
    demo: providerName === 'demo',
    confirmationId: result.paymentId,
    subscriptionId: result.subscriptionId,
    status: result.status,
    // What was actually decided and charged server-side - the client must
    // show this, not derive its own guess from the plan it asked for (a
    // visitor past the promotion's 100-spot cap is charged 2800 even
    // though they requested the Introductory plan).
    introApplied: result.introApplied,
    amountCents: result.amountCents,
  });
});

/* ---------- Dashboard (authenticated) ---------- */

const HERE = dirname(fileURLToPath(import.meta.url));
// The static site lives inside the server package (server/public) so the app
// is fully self-contained: a host can set its deploy root to server/ and still
// get index.html, the dashboard, and all assets. Nothing is served from the
// repo root, so there is no "deploy the whole repo" requirement.
const SITE_ROOT = join(HERE, 'public');

app.use('/api/auth', authRouter);
app.use('/api/admin/plans', plansRouter); // subscription plans; per-permission inside. MUST precede /api/admin (prefix match)
app.use('/api/admin', adminRouter);
app.use('/api/employee', employeeRouter);
app.use('/api/customer', customerRouter);
app.use('/api/photos', photosRouter);
app.use('/api/finance', financeRouter);   // admin-only, enforced inside the router
app.use('/api/people', peopleRouter);     // admin-only, enforced inside the router
app.use('/api/promo', discountRouter);    // per-permission, enforced inside the router
app.use('/api/communities', communityRouter);
app.use('/api/roles', rolesRouter);       // roles, permissions, and route management
app.use('/api/settings', settingsRouter); // system settings; per-permission inside
publicCommunityRoutes(app);              // /api/service-check and /api/waitlist are public

/* Gate the dashboard HTML itself. Without this a signed-out visitor could
   load the admin page shell; the API would refuse its calls, but the page
   should not render at all. Role is checked here too, so an employee cannot
   open /dashboard/admin/ by typing the URL. */
const ROLE_FOR_PREFIX = {
  '/dashboard/admin': 'admin',
  '/dashboard/employee': 'employee',
  '/dashboard/customer': 'customer',
};

/* A signed-in user with a temporary password can only reach the page that
   lets them replace it. */
app.use('/dashboard', (req, res, next) => {
  if (!req.user) return next();
  if (req.path.startsWith('/change-password')) return next();
  const u = one('SELECT must_change_password FROM users WHERE id = ?', req.user.id);
  if (u?.must_change_password) return res.redirect('/dashboard/change-password.html');
  next();
});

app.use('/dashboard', (req, res, next) => {
  const path = '/dashboard' + req.path.replace(/\/$/, '');
  const needed = Object.entries(ROLE_FOR_PREFIX).find(([prefix]) => path.startsWith(prefix))?.[1];
  if (!needed) return next();                       // login page and shared assets

  if (!req.user) return res.redirect('/dashboard/login.html');
  // A manager uses the admin shell; the API still enforces each permission.
  const ok = req.user.role === needed || (needed === 'admin' && req.user.role === 'manager');
  if (!ok) {
    return res.redirect(`/dashboard/${req.user.role}/`);   // send them to their own
  }
  next();
});

/* Block private directories BEFORE anything serves a file.
   A setHeaders hook cannot do this - it can set a status code but the file
   body is still streamed, which would serve the source code and the database
   itself (password hashes, customer PII) to anyone who asked. */
const PRIVATE_PATH = /^\/(server|node_modules|\.git|\.vscode)(\/|$)/i;

app.use((req, res, next) => {
  if (PRIVATE_PATH.test(req.path)) return res.status(404).json({ error: 'Not found.' });
  next();
});

/* Live reload in development: the file watcher, SSE stream, and client
   script. The reload snippet is injected into HTML by the branded-HTML
   middleware below, which owns HTML output in every environment. */
const DEV = process.env.NODE_ENV !== 'production' && process.env.DEV_RELOAD !== '0';
if (DEV) attachDevReload(app, SITE_ROOT);

/* Serve every HTML page with {{brand.*}} tokens resolved (and, in dev, the
   reload snippet appended). Must come before the static mounts so it, not
   express.static, is what answers for .html. */
attachBrandedHtml(app, SITE_ROOT, {
  decorate: DEV
    ? (html) => html.includes('</body>')
        ? html.replace('</body>', `${DEV_RELOAD_SNIPPET}\n</body>`)
        : html + DEV_RELOAD_SNIPPET
    : null,
});

/* Static assets (css, js, images). HTML is already handled above. */
app.use('/dashboard', express.static(join(SITE_ROOT, 'dashboard'), { extensions: ['html'] }));

/* The public marketing site. */
app.use(express.static(SITE_ROOT, {
  index: 'index.html',
  dotfiles: 'ignore',   // never serve .env, .git, etc.
}));

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

/* ---------- Boot ----------
   Migrations run on import so a test that imports this module gets a
   fully-built schema. Everything with a side effect on the outside world
   - the listening socket and the purge timer - runs only when this file
   is executed directly, so importing `app` for tests starts no server. */

migrate();
const adminChanges = [...migrateAdmin(), ...migrateCommunities(), ...migrateIssueCodes(),
                      ...migrateAdminControls(), ...migrateDynamicRoles(),
                      ...migrateCommunityLifecycle(), ...migratePlans(),
                      ...migrateWorkerBanking()];
if (adminChanges.length) adminChanges.forEach(c => console.log('  migration:', c));
migrateDemoFlags();   // after the admin rebuilds, so is_demo columns survive

// Apply any subscription-plan price changes whose effective date has arrived.
// Idempotent and cheap; also runs lazily on plan reads.
applyDuePriceChanges();

/* Start the HTTP listener whenever this module is loaded to RUN the app -
   whether it is executed directly (`node server.js`) or imported by a host's
   process manager. Managed Node hosts (e.g. Hostinger/Passenger) load this
   file instead of running it as the main module, and shared-hosting paths are
   symlinked, so the old `realpath(argv[1]) === import.meta.url` check was false
   there and the server never called listen() -> the platform returned 503.
   Only the test files import { app } to attach their own listener, and they
   run under `node --test`; we detect that and skip auto-listen so tests don't
   bind a stray port. START_SERVER=0 also forces it off if ever needed. */
const underTestRunner = process.execArgv.some(a => a === '--test' || a.startsWith('--test'));
const shouldListen = !underTestRunner && process.env.START_SERVER !== '0';

if (shouldListen) {
  /* First boot of a fresh deployment. A GitHub/Hostinger deploy ships no
     database - the .db files are gitignored - so the server comes up with an
     empty schema and nobody can log in until it is seeded. Seed the owner +
     training accounts once, here, so a brand-new deploy is demo-ready with no
     manual step. seedFreshInstall() is a no-op the instant any user exists, so
     every later boot skips it and real data is never touched. Guarded so a seed
     failure logs but never stops the server from listening. */
  try {
    if (!one('SELECT id FROM users LIMIT 1')) {
      seedFreshInstall();
      console.log('  fresh database detected -> seeded owner + training accounts');
    }
  } catch (e) {
    console.error('  seed-on-boot failed:', e.message);
  }

  // Guarantee the advertised plan records exist. Runs after the fresh-install
  // seed (which populates plans on a truly-new DB) and only acts when the plans
  // table is empty, so it backfills a database that predates the plans feature
  // — where users already exist and the seed above no-ops — without ever
  // touching an admin's edited plans. This is the Hostinger fix: it makes
  // Admin -> Subscription Plans (and the public site) read real, editable
  // records instead of coming up blank. Guarded so a failure never stops boot.
  try {
    const planChanges = ensureDefaultPlans();
    if (planChanges.length) planChanges.forEach(c => console.log('  plans:', c));
  } catch (e) {
    console.error('  ensure-default-plans failed:', e.message);
  }

  purgeExpiredSessions();
  setInterval(purgeExpiredSessions, 6 * 60 * 60 * 1000).unref();
  app.listen(PORT, () => {
    console.log(`\n  ${publicBranding().name} API`);
    console.log(`  listening on port ${PORT}\n`);
    console.log('  Payments: DEMO - no real money moves');
    console.log(`  Payment provider: ${providerName}\n`);
  });
}

export { app };
