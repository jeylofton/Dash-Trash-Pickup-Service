# Troubleshooting & Lessons Learned

A running log of bugs, deployment surprises, and hard-won fixes from building
Dash Trash Pickup. If something breaks and feels familiar, check here first.

---

## Contents

- [Deployment & Hosting](#deployment--hosting)
  - [Empty database on fresh deploy](#empty-database-on-fresh-deploy)
  - [Static HTML bypasses Express on Hostinger](#static-html-bypasses-express-on-hostinger)
  - [Brand tokens showing raw on production](#brand-tokens-showing-raw-on-production)
  - [Plans table empty on existing databases](#plans-table-empty-on-existing-databases)
  - [Demo login broken on production](#demo-login-broken-on-production)
- [Node.js & SQLite Portability](#nodejs--sqlite-portability)
  - [Numbered SQL parameters crash on Hostinger](#numbered-sql-parameters-crash-on-hostinger)
  - [Works on localhost !== works in production](#works-on-localhost--works-in-production)
- [Payments & Checkout](#payments--checkout)
  - [Square integration removed — demo only](#square-integration-removed--demo-only)
  - [Checkout endpoint can delete admin account](#checkout-endpoint-can-delete-admin-account)
  - [Coupon brute-forcing via public validate endpoint](#coupon-brute-forcing-via-public-validate-endpoint)
- [Dashboard & UI](#dashboard--ui)
  - [Panels staying open across tab switches](#panels-staying-open-across-tab-switches)
  - [Cancel button writing data](#cancel-button-writing-data)
  - [Inline scripts blocked by CSP](#inline-scripts-blocked-by-csp)
- [Security](#security)
  - [Demo password shipped to production](#demo-password-shipped-to-production)
  - [Missing rate limiting on public endpoints](#missing-rate-limiting-on-public-endpoints)
  - [Photo IDOR and cross-customer access](#photo-idor-and-cross-customer-access)
- [Data Integrity](#data-integrity)
  - [is_demo flag stripped after admin rebuild](#is_demo-flag-stripped-after-admin-rebuild)
  - [Two sources of truth for pricing](#two-sources-of-truth-for-pricing)
  - [Coupon edits re-pricing enrolled customers](#coupon-edits-re-pricing-enrolled-customers)
- [macOS Development](#macos-development)
  - [Port 5000 returns 403](#port-5000-returns-403)

---

## Deployment & Hosting

### Empty database on fresh deploy

**Symptom:** App boots fine on Hostinger, homepage loads, but login fails — no
users exist. Everything works on localhost.

**Root cause:** The `.db` files are gitignored, so a fresh GitHub auto-deploy
starts with zero data. The server ran migrations (creating empty tables) but
never seeded any users.

**Fix:** Added `seedFreshInstall()` in `db/seed.js`, called from `server.js`
boot when the users table is empty. It seeds the owner account and training
accounts automatically. It's a no-op once any user exists, so it never
double-seeds.

**Lesson:** Always assume a production deploy starts from nothing. If the app
needs seed data to function (like a login account), the boot sequence must
handle it — don't rely on a manual `node db/seed.js` step that someone will
forget.

---

### Static HTML bypasses Express on Hostinger

**Symptom:** Security headers missing on HTML pages. `{{brand.name}}` shows
literally as `{{brand.name}}` on the live site instead of "Dash Trash Pickup".

**Root cause:** Hostinger runs Passenger with LiteSpeed/CDN in front. Static
files (`.html`, `.css`, `.js`) are served directly by the CDN — they never
reach Express. So `attachBrandedHtml` (which replaces `{{brand.*}}` tokens) and
`securityHeaders` middleware never run on those responses.

**Fix for brand tokens:** Created `server/public/brand-hydrate.js`, a shared
`<script type="module">` added to all 6 pages that have tokens. It fetches
`/api/branding` (an API path, which always reaches Node) and replaces surviving
`{{brand.*}}` in the DOM via `textContent`/attribute assignment (no
`innerHTML`, so no XSS). It's a no-op when the server already rendered them
(localhost).

**Still open:** CSP headers are absent on static HTML responses served by the
CDN. Would need routing all `.html` through Node or a build-time bake step.

**Known cosmetic issue:** Brief flash of raw tokens before hydration completes.
Crawlers reading static HTML see raw tokens in `<title>` and meta tags (SEO
impact).

**Lesson:** If your host serves static files directly (bypassing your app
server), any server-side middleware on those files is dead code in production.
Test by hitting the production URL, not localhost.

---

### Brand tokens showing raw on production

See [Static HTML bypasses Express on Hostinger](#static-html-bypasses-express-on-hostinger) — same root cause. The client-side hydration script is the fix.

---

### Plans table empty on existing databases

**Symptom:** Admin dashboard "Subscription Plans" tab shows "Unable to load
subscription plans" on the live site. Homepage pricing cards still show prices.
Localhost works fine.

**Root cause:** The production database already had users (seeded before the
plans feature existed), so `seedFreshInstall()` skipped entirely (its guard is
"if users table empty"). The `plans` table stayed empty. Meanwhile, the public
homepage was reading prices from a hardcoded `CONFIG.pricing` object in
`scripts.js` — a second source of truth that masked the empty database.

**Fix:** Added `ensureDefaultPlans()` in `db/migrate_plans.js`, called in the
boot sequence *after* `seedFreshInstall`. It's idempotent: seeds
Monthly/Quarterly/Annual and an inactive Introductory plan only when the plans
table is empty, and never touches admin edits. Also removed `CONFIG.pricing`
from `scripts.js` — the homepage now fetches `GET /api/subscription-plans/public`
dynamically, creating one source of truth.

**Lesson:** When adding a new table to an existing app, don't put the seed
logic inside a guard meant for a different table. Each table needs its own
"ensure data exists" check. And never have two sources of truth for the same
data (hardcoded config vs. database).

---

### Demo login broken on production

**Symptom:** The login page on the live site shows no demo credential hints.
Users can't figure out how to log in.

**Root cause:** By design. `GET /api/dev-demo` returns 404 in production
(`NODE_ENV=production`), so credential hints never show on the live site. This
is correct security behavior, but it means you need to remember the demo
credentials.

**Demo credentials (from db/seed.js):**

| Account | Role | Password |
|---|---|---|
| `admin@dashtrashpickup.com` | Admin (owner) | `DashDemo2026` |
| `employee@dashtrashpickup.com` | Employee | `employee` |
| `customer@email.com` | Customer | `customer` |

**Lesson:** Keep demo credentials documented somewhere accessible (like this
file) since the in-app hints are intentionally hidden in production.

---

## Node.js & SQLite Portability

### Numbered SQL parameters crash on Hostinger

**Symptom:** Admin Subscription Plans page loads locally but shows "Unable to
load subscription plans. Something went wrong." on Hostinger. No other pages
affected.

**Root cause:** `routes/plans.js` used a numbered SQLite parameter `?1` bound
positionally. Node 26 (local) tolerates this, but Hostinger's older
`node:sqlite` throws `column index out of range`. The public plans feed
survived because it uses no bind parameters at all.

**Fix:** Changed `?1` to anonymous `?`. That's it.

**Rule:** Always use anonymous `?` placeholders in SQL, never `?1`, `?2`, etc.
The numbered form is a portability trap — it works on some Node versions and
silently breaks on others with no useful error message.

**How to debug Hostinger-only failures:**
1. Pull the runtime logs from the Hostinger panel (Downloads folder)
2. Look for the real stack trace — the browser only shows a generic error
3. Reproduce locally with `NODE_ENV=production` and
   `X-Forwarded-Proto: https` header
4. Remember: a green localhost is NOT proof a production deploy works

---

### Works on localhost !== works in production

**Symptom:** Feature works perfectly in development, 500s or breaks on
Hostinger.

**Common causes:**
- **Node version differences.** Local runs Node 26, Hostinger runs an older
  version. `node:sqlite` behavior differs between versions.
- **Static file serving.** Hostinger CDN serves `.html` files directly;
  localhost routes everything through Express.
- **HTTPS redirect.** Production forces HTTPS via `X-Forwarded-Proto` check.
  If a fetch uses `http://` internally, it may redirect unexpectedly.
- **Environment variables.** `.env` exists locally but not on Hostinger unless
  manually configured.
- **Empty database.** Local has a seeded database; fresh deploy starts empty.

**Checklist for "works locally, broken on prod":**
1. Check Hostinger runtime logs for the real error
2. Check if the failing code uses SQL bind parameters (use `?` not `?1`)
3. Check if the feature depends on Express middleware (won't run on static
   files served by CDN)
4. Check if the database table has data (fresh deploy = empty tables)
5. Test locally with `NODE_ENV=production`

---

## Payments & Checkout

### Square integration removed — demo only

**Symptom:** If you see any references to Square in old code or branches, it's
dead code.

**What happened:** Square was integrated and then removed the same day. The
decision was to return to a clean testing phase before choosing a payment
provider.

**Current state:** `PAYMENT_PROVIDER=demo` is the only working value.
`lib/payments/demo.js` simulates outcomes (success/failed/declined/pending) and
moves no money. The demo checkout collects no card details at all.

**If you need to add a real provider later:**
1. Implement the payments interface in `lib/payments/` (matching the demo
   provider's API)
2. Set `PAYMENT_PUBLIC_KEY`, `PAYMENT_SECRET_KEY`, `PAYMENT_WEBHOOK_SECRET`
   in the environment
3. Set `PAYMENT_PROVIDER` to the new provider name
4. Nothing else in the app changes — `lib/payments/index.js` is the seam

---

### Checkout endpoint can delete admin account

**Symptom:** (Caught before production.) The public `POST /api/checkout`
endpoint could delete user records to allow email reuse. An earlier version
lacked a role filter, which meant an anonymous request could theoretically
destroy the admin account.

**Fix:** The delete-abandoned-user logic is now scoped to:
- `role = 'customer'` only
- No paid/pending/refunded/past_due payments
- No live subscription

An admin or employee account can never be deleted by the checkout flow.

**Lesson:** Any public endpoint that deletes data needs the tightest possible
scope. Filter by role, check for related records, and assume the worst about
who's calling it.

---

### Coupon brute-forcing via public validate endpoint

**Symptom:** (Found during adversarial security testing.) `POST /api/promo/coupons/validate` was public and had no rate limit. An attacker could
brute-force coupon codes.

**Fix:** Added `rateLimiter()` factory in `server/lib/security.js`, applied
20 requests/minute limit in `routes/discounts.js`.

**Lesson:** Every public endpoint that accepts user input needs rate limiting,
especially ones that validate codes, tokens, or credentials.

---

## Dashboard & UI

### Panels staying open across tab switches

**Symptom:** Click "Edit" on an employee, switch to the Routes tab, switch back
— the edit panel is still open with stale data.

**Root cause:** Tab switches weren't resetting page state. The detail/edit
panels persisted across navigation.

**Fix:** Implemented the dashboard page-state pattern: every tab follows
**LIST → SELECT → VIEW/EDIT → SAVE OR CANCEL → LIST**. Entering or
re-entering a tab always lands on the plain list with nothing selected. Built
with `createSection` (selection + guard tracking + close/reset),
`confirmDiscard` (Keep Editing / Discard Changes dialog), and `toast` (success
banner). See `dashboard/dash.js` and `dashboard/admin/admin.js`.

**Rule:** Three states are kept apart: persisted (server), selected
(`createSection`), and draft (DOM inputs watched by `guardForm`). Form fields
are never bound to the persisted object.

---

### Cancel button writing data

**Symptom:** Clicking "Cancel" on an edit form was saving partial changes
instead of discarding them.

**Root cause:** The cancel handler was calling the same save logic, or form
state was leaking to the persisted object.

**Fix:** Cancel writes nothing — no version bump, no audit row, no effective
date change. `guardForm()` snapshots every field when a form opens; Cancel
restores each field and clears the dirty flag. Save and Cancel both end at
`close()` + reload — the only difference is whether the server was written to.

**Lesson:** Cancel must be a true no-op on the server. Snapshot on open,
restore on cancel, write on save. Never bind form fields directly to the
data object you'll persist.

---

### Inline scripts blocked by CSP

**Symptom:** JavaScript not executing on pages after adding Content Security
Policy headers with `script-src 'self'`.

**Root cause:** The login page and change-password page had inline `<script>`
blocks. Strict CSP blocks all inline scripts.

**Fix:** Extracted all inline scripts to external files:
- `dashboard/login.js`
- `dashboard/change-password.js`
- Dev-reload snippet moved to `/__dev/reload.js`

**Lesson:** When adding CSP headers, audit every HTML file for inline
`<script>` blocks. Extract them to external `.js` files before turning on
`script-src 'self'`.

---

## Security

### Demo password shipped to production

**Symptom:** The login page on the live site showed demo credentials, making it
trivial for anyone to log into the admin dashboard.

**Root cause:** Demo credential hints were hardcoded in `login.html`.

**Fix:** Removed demo credentials from `login.html` and `login.js`. The login
page now fetches `/api/dev-demo` (`server/lib/demo-creds.js`), which returns
404 in production. In development, it returns **real DB accounts** (not
hardcoded strings), so credentials stay accurate even after a database reset.

**Lesson:** Never hardcode credentials in client-facing files. Gate all
development conveniences behind `NODE_ENV !== 'production'` checks, and make
the gate server-side (a 404 API response), not client-side (a JS `if` check
that can be bypassed).

---

### Missing rate limiting on public endpoints

**Symptom:** (Found during adversarial testing.) Public endpoints accepting
user input had no rate limiting, enabling brute-force attacks.

**Affected endpoints:**
- `POST /api/promo/coupons/validate` — coupon code brute-forcing

**Fix:** Created `rateLimiter()` factory in `server/lib/security.js`. Applied
per-endpoint limits. The factory is reusable for any future public endpoints.

**Lesson:** When adding a new public endpoint, ask: "What happens if someone
calls this 1000 times per second?" If the answer is bad, add a rate limit
before shipping.

---

### Photo IDOR and cross-customer access

**Symptom:** (Verified as NOT vulnerable during adversarial testing, but worth
documenting the pattern.) Could a customer access another customer's pickup
photos by guessing the photo ID?

**Why it's safe:** Photos are served through `/api/photos/:id`, which
authorizes every request. A leaked photo URL is useless without a valid session
for the right customer. The file is stored outside the web root and streamed
through the API — never served as a static file.

**Lesson:** Never serve user-uploaded files as static assets. Always gate them
behind an authorization check.

---

## Data Integrity

### is_demo flag stripped after admin rebuild

**Symptom:** Practice/training account data leaking into the owner's real
dashboards and reports after a database rebuild or migration.

**Root cause:** `migrateDemoFlags()` in `db/index.js` sets the `is_demo` flag
on training accounts. If it doesn't run after an admin rebuild, the flag gets
stripped and demo data becomes "real" data.

**Fix:** `migrateDemoFlags()` is called in the server boot sequence AND in
`seed.js`, which runs the full migration chain. Every owner-facing read
filters `is_demo = 0`.

**Rule:** The migration chain must always include `migrateDemoFlags()`. If you
add a new migration step, make sure it runs before any queries that filter on
`is_demo`.

---

### Two sources of truth for pricing

**Symptom:** Homepage shows one set of prices, admin dashboard shows another
(or nothing). Changing prices in the admin panel doesn't update the homepage.

**Root cause:** The public homepage had a hardcoded `CONFIG.pricing` object in
`scripts.js` with price values. The admin dashboard read from the `plans`
table. Two sources, inevitably out of sync.

**Fix:** Removed `CONFIG.pricing`. The homepage now fetches
`GET /api/subscription-plans/public` dynamically. Card labels, "Best Value"
badges, prices, frequencies, descriptions, and display order are all data from
the database. One source of truth.

**Lesson:** If the same data appears in two places (config object + database),
one of them will go stale. Pick one source and read from it everywhere.

---

### Coupon edits re-pricing enrolled customers

**Symptom:** (Design rule, not a bug that shipped.) Editing a coupon's terms
could theoretically change what an already-enrolled customer pays.

**Prevention:** Subscriptions store `promo_price_cents` and
`promo_periods_remaining` (the introductory terms) and `locked_price_cents`
(the post-promotion rate) at signup. These are frozen per-subscription. Editing
the coupon or the plan price later never reaches back to re-price an existing
customer.

**Rule:** Never let coupon edits reach back and re-price an enrolled customer.
The subscription owns the price, not the coupon or the plan.

---

## macOS Development

### Port 5000 returns 403

**Symptom:** Starting the server on port 5000 returns a confusing `403
Forbidden` response instead of the app.

**Root cause:** macOS AirPlay Receiver holds port 5000.

**Fix:** The app defaults to port 3000. Don't set `PORT=5000`. If you need to
change ports, use anything other than 5000 on macOS.

**To check what's holding a port:**
```bash
lsof -i :5000
```

---

## Quick Reference: What to Check When Things Break

| Symptom | First thing to check |
|---|---|
| Works locally, broken on Hostinger | SQL bind params (`?` not `?1`), check runtime logs |
| Login fails on fresh deploy | Database is empty — check if `seedFreshInstall()` ran |
| `{{brand.name}}` showing raw | Static file served by CDN, not Express — check `brand-hydrate.js` is loaded |
| Admin page shows "unable to load" | Check if the table has data, check for SQL param issues |
| Feature works for admin, 404 for employee | Role gate working correctly — check `requireRole()` |
| Cancel button saves data | Form fields bound to persisted object — use `guardForm()` snapshot pattern |
| Scripts not running after CSP change | Inline `<script>` blocks — extract to external `.js` files |
| Practice data in real reports | `is_demo` flag missing — check `migrateDemoFlags()` ran |
| Prices different on homepage vs admin | Check if homepage reads from API or hardcoded config |
| Port 5000 gives 403 on Mac | AirPlay Receiver — use port 3000 |

---

## Debugging Hostinger Specifically

1. **Get the real error.** The browser shows a generic message. Pull runtime
   logs from the Hostinger panel.
2. **Remember the architecture.** Static files are served by LiteSpeed/CDN,
   not Express. Only `/api/*` paths reach your Node server.
3. **Test locally in production mode:**
   ```bash
   NODE_ENV=production node server.js
   ```
4. **Simulate the proxy header:**
   ```bash
   curl -H "X-Forwarded-Proto: https" http://localhost:3000/api/health
   ```
5. **Check the Node version.** Hostinger may run a different Node version than
   your local machine. `node:sqlite` behavior varies.
6. **Fresh deploy = empty database.** The `.db` file is gitignored. If you
   redeployed and the database is gone, check if `seedFreshInstall()` ran on
   boot.

---

*Last updated: September 2026*
