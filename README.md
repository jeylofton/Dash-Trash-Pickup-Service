# Dash Trash Pickup

A marketing site, customer signup flow, and role-based operations dashboard for
**Dash Trash Pickup**, a doorstep valet trash collection service for apartment
and townhome communities.

> _Your trash. Our dash._ — residents leave tied household trash outside their
> door twice a week, and we carry it to the community dumpster so they don't
> have to.

The public site is plain HTML, CSS, and JavaScript with no framework and no
build step. It is served by a small Node + Express application server that also
runs the API, the dashboard, and the database. Payments currently run on a
built-in **demo provider** that simulates a processor and moves no real money.

The application is self-contained: one command installs it, one command runs it.
It needs **only Node.js and npm** — no particular editor, IDE, or extension.

---

## Contents

- [Requirements](#requirements)
- [Local development](#local-development)
- [Production deployment](#production-deployment)
- [Environment variables](#environment-variables)
- [Database setup](#database-setup)
- [Payment provider](#payment-provider)
- [First-run setup](#first-run-setup)
- [Backups](#backups)
- [Security](#security)
- [Pricing configuration](#pricing-configuration) ← **edit pricing here**
- [Feature reference](#feature-reference)
  - [What's in it](#whats-in-it)
  - [How the first-100 offer works](#how-the-first-100-offer-works)
  - [Payments (demo provider)](#payments-demo-provider)
  - [Dashboard (admin / employee / customer)](#dashboard-admin--employee--customer)
  - [Financials, payroll and profitability](#financials-payroll-and-profitability)
  - [Employee management and accounts](#employee-management-and-accounts)
  - [Coupons and service credits](#coupons-and-service-credits)
  - [Community lifecycle and service verification](#community-lifecycle-and-service-verification)
  - [Admin control: archiving, route versioning, custom roles](#admin-control-archiving-route-versioning-custom-roles)
  - [Cancel, Delete, and Archive](#cancel-delete-and-archive)
- [Before launch](#before-launch)
- [Tech notes](#tech-notes)
- [Development tools (optional)](#development-tools-optional)

---

## Requirements

To run the application you need:

| Requirement | Version | Notes |
|---|---|---|
| **Node.js** | **22 or newer** | The database uses `node:sqlite`, which is built into Node 22+. Node 18/20 will not run it. |
| **npm** | bundled with Node | Installs the two runtime dependencies. |

That is the entire list. The application does **not** require any editor, IDE,
AI assistant, or browser extension to install, build, run, or deploy. It runs
from a plain command line on any standard Node host — a VPS, a container, or a
Node-capable cloud platform.

Runtime dependencies are just `express` and `dotenv`. SQLite is built into Node,
so there is no native module to compile and no database server to install.

---

## Local development

```bash
cd server
npm install            # install dependencies
cp .env.example .env    # PAYMENT_PROVIDER=demo is already set
node db/seed.js         # create + seed the database (add --reset to rebuild)
npm run dev             # start with auto-restart + browser live-reload
```

Then open:

| URL | |
|---|---|
| <http://localhost:3000> | Public marketing site |
| <http://localhost:3000/dashboard/login.html> | Sign in (all three roles) |
| <http://localhost:3000/api/health> | API check |

One process serves everything — the public site, the dashboard, and the API all
answer on the same port. There is no second server to start and nothing serves
the frontend separately.

**Live reload.** In development the server refreshes open browser tabs when you
save an `.html`, `.css`, or `.js` file. It works by injecting a tiny snippet
into HTML *as it is served*, so nothing dev-only is ever written into the source
files. It turns itself off automatically when `NODE_ENV=production`; set
`DEV_RELOAD=0` to turn it off during development too.

**Backend auto-restart.** `npm run dev` uses `node --watch` to restart the
server when you edit server code. Use plain `npm start` if you don't want that.

> **Avoid port 5000 on macOS.** AirPlay Receiver holds it and returns a
> confusing `403`. This app uses 3000; you only hit that if you set `PORT=5000`.

Stop the server with **Ctrl+C**.

---

## Production deployment

A new owner can deploy without any of the development tooling. On a server with
Node 22+ and npm:

```bash
# 1. Get the code onto the server (git clone or an uploaded copy)
cd server

# 2. Install runtime dependencies only (skips devDependencies)
npm install --omit=dev

# 3. Configure the environment (see "Environment variables")
cp .env.example .env
#   edit .env: set NODE_ENV=production, PORT, DB_PATH, UPLOAD_DIR, etc.

# 4. Create and migrate the database (see "Database setup")
node db/seed.js            # first install only; migrations also run on boot

# 5. Start the application
NODE_ENV=production npm start
```

`npm start` runs `node server.js`. It reads its configuration from the
environment, listens on `$PORT` (falling back to 3000), serves the public site,
the dashboard, and the API from that one process, and runs database migrations
on boot.

What `NODE_ENV=production` changes automatically:

- Browser live-reload is disabled (no file watcher, no injected snippet; the
  `/__dev/reload` route returns 404).
- All traffic is redirected to HTTPS, and the session cookie is marked `Secure`.
- The demo-login hint (`GET /api/dev-demo`) returns nothing.
- Error responses never include stack traces.

**Behind a reverse proxy / load balancer.** The app trusts `X-Forwarded-*`
headers (`trust proxy` is on) so `req.secure` and the client IP are correct
behind TLS termination. Terminate HTTPS at your proxy (nginx, Caddy, a cloud
load balancer) and forward to the app's port.

**Process management.** Run it under a process manager so it restarts on crash
and on reboot — systemd, pm2, or your platform's own supervisor. Point the
manager at `node server.js` with the working directory set to `server/`.

**Persistent storage.** The SQLite database file and uploaded photos must live
on persistent, backed-up storage. Set `DB_PATH` and `UPLOAD_DIR` to a mounted
volume rather than the ephemeral container filesystem (see below).

**Static-only note.** Because the marketing page itself is static, a static
host (Netlify, Cloudflare Pages, GitHub Pages) *can* serve `index.html` — but it
cannot run the API, the dashboard, sign-in, or payments, all of which need the
Node process. Treat static hosting as marketing-only; the full product needs a
Node host.

**After pointing a real domain at it**, update these to the live URL:

- `<link rel="canonical">` in `index.html`
- `og:url` and `og:image` meta tags
- `url` and `image` in the `LocalBusiness` JSON-LD block

---

## Environment variables

Configuration comes entirely from the environment — no source file needs editing
to configure infrastructure. Copy `server/.env.example` to `server/.env` and
fill it in. Every variable has a safe default, so the app boots with an empty
`.env` in development.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `production` enables HTTPS redirect, Secure cookies, and disables live-reload and dev hints. |
| `PORT` | `3000` | Port to listen on. Many hosts assign their own. |
| `ALLOWED_ORIGINS` | *(empty)* | Comma-separated cross-origin API callers. Normally empty — the app serves its own frontend from the same origin. |
| `DB_PATH` | `server/data/dash.db` | SQLite database file path. Point at a persistent volume in production. |
| `STORAGE_DRIVER` | `local` | Photo storage driver. An `s3` seam exists in `lib/storage.js` for S3/R2 (not yet wired). |
| `UPLOAD_DIR` | `server/data/uploads` | Where the local driver writes photos. Point at a persistent volume in production. |
| `MAX_UPLOAD_BYTES` | `8388608` (8 MB) | Per-photo upload cap. |
| `PAYMENT_PROVIDER` | `demo` | Active payment provider. `demo` is the only working value today. |
| `DEV_RELOAD` | *(on)* | Set to `0` to disable browser live-reload in development. Ignored in production. |

**Reserved (not read yet).** These are documented placeholders for planned work
and are ignored today: `PAYMENT_PUBLIC_KEY`, `PAYMENT_SECRET_KEY`,
`PAYMENT_WEBHOOK_SECRET` (for a future real payment provider), and `APP_URL`
(for the planned first-run setup). Leave them blank while on the demo provider.

The real `.env` is gitignored and must never be committed. Only
`.env.example`, which contains placeholders, is tracked.

---

## Database setup

The database is **SQLite**, built into Node 22+. There is no database server to
install and no native module to compile — the data lives in a single file
(`server/data/dash.db` by default, overridable with `DB_PATH`).

```bash
cd server
node db/seed.js            # create the schema and seed a fresh install
node db/seed.js --reset     # wipe and rebuild from scratch (backs up first)
```

Schema lives in `db/*.sql`; `db/index.js` is the only file that knows about the
SQLite driver. Migrations also run automatically on every boot, so deploying a
new version applies any schema changes without a manual step.

**Moving to PostgreSQL later:** the schema is plain SQL and the driver is
isolated in `db/index.js`, so a future port changes that one file. A
`DATABASE_URL` variable is not used today (the app is SQLite-only).

**22 tables.** Two design rules run throughout: one fact is stored in exactly
one place, and nothing a service history points at is ever hard-deleted. The
important one is `subscriptions.locked_price_cents` — a subscription stores the
price it locked in at signup, so editing `plans.price_cents` later never
re-prices an existing customer.

---

## Payment provider

There is no real payment processor connected. `PAYMENT_PROVIDER=demo` is the
default and only working value. It simulates a processor entirely inside the
server: no card is collected, no network call is made, and nothing is ever
charged. `server/lib/payments/index.js` is the seam a real provider plugs into
later — nothing else in the app knows or cares which provider is active.

`payments.charge()` accepts one of four simulated outcomes — `success`,
`failed`, `declined`, `pending` — chosen by whoever is testing, so every branch
of signup and billing can be exercised without a real card number.

**Adding a real provider later** means implementing the payments seam and
supplying `PAYMENT_PUBLIC_KEY` / `PAYMENT_SECRET_KEY` / `PAYMENT_WEBHOOK_SECRET`
in the environment. The rest of the application does not change.

---

## First-run setup

`node db/seed.js` produces the experience a brand-new business owner should see:

- An **empty operational dashboard** — no customers, communities, routes,
  employees, or revenue belonging to the owner.
- A real **owner admin account** (`admin@dashtrashpickup.com`).
- Exactly two self-contained **training accounts** (one customer, one employee)
  so the customer and employee experiences can be demonstrated. Every row those
  two accounts rely on is flagged `is_demo = 1`, so the owner's real dashboards
  and reports exclude them entirely.

Reference data that a business keeps — pricing plans and the launch coupon — is
seeded as real, shared configuration, not another business's records.

> A guided in-app first-run wizard (business name, admin account, logo, theme
> from the browser) is designed but **not yet built**. Today the equivalent
> configuration is done by seeding and by the System Settings screen in the
> admin dashboard. See `docs/design/` for the design specs.

---

## Backups

The entire application state is the SQLite database file plus the uploads
directory. To back up:

```bash
# Database (safe to copy while running; SQLite is a single file)
cp server/data/dash.db /path/to/backups/dash-$(date +%F).db

# Uploaded photos
cp -r server/data/uploads /path/to/backups/uploads-$(date +%F)
```

`db/seed.js --reset` automatically writes a timestamped backup of the existing
database before rebuilding. Store backups off the server, and restore by copying
the files back into place (or by pointing `DB_PATH` / `UPLOAD_DIR` at them).

---

## Security

Security is enforced server-side; hiding a button in the UI is never the control.
Highlights (each is detailed in the feature reference below):

- **Authentication** — sessions are random tokens in `httpOnly` cookies; only
  the SHA-256 of the token is stored, so a database dump yields no usable
  sessions. Passwords use scrypt with a per-user salt. In production the cookie
  is `Secure` and all traffic is redirected to HTTPS.
- **Authorization** — a role gate plus an ownership check on every query, scoped
  by the id from the session (never the URL or body). A wrong role gets **404**,
  not 403.
- **Baseline hardening** — security headers on every response, HTTPS redirect in
  production, private paths (`/server`, `/node_modules`, `/.git`) blocked before
  any file is served, and dotfiles never served. Stack traces are never returned
  to clients.
- **No secrets in the browser** — the demo provider collects no card data;
  provider secrets, when a real provider is added, stay server-side only.
- **Audit trail** — `audit_log` is append-only and records logins, pickups,
  route reassignments, plan changes, cancellations, and admin edits.

The suite in `server/test/` includes adversarial acceptance tests that verify
these boundaries by attacking them. Run them with `npm test` in `server/`.

---

## Pricing configuration

**All pricing, the introductory offer, and the pickup schedule live in one place:**
the `CONFIG` object at the top of [`scripts.js`](scripts.js). Nothing is hardcoded
in the HTML — change a value here and it updates everywhere on the page.

```js
const CONFIG = {
  intro: {
    enabled: true,
    price: 18, // introductory monthly rate
    totalSpots: 100, // how many customers get it
    popupDelayMs: 1400, // delay before the coupon appears
    remindAfterDays: 7, // don't re-show for this many days after dismissal
  },

  pricing: {
    monthly: 28, // base monthly price
    quarterlyDiscount: 10, // $ off the 3-month total
    annualDiscount: 60, // $ off the 12-month total
    currency: "$",
  },

  schedule: {
    days: ["Tuesday", "Thursday"],
    perWeek: 2,
    varianceNote: "Pickup days may vary by community or service area.",
  },

  serviceArea: {
    city: "Columbus, Georgia",
    zips: ["31901", "31902" /* ... */],
  },
};
```

### Current pricing

Quarterly and annual totals are **calculated**, never typed in by hand:

| Plan         | Formula                           | Total | Effective /mo |
| ------------ | --------------------------------- | ----- | ------------- |
| Monthly      | `monthly`                         | $28   | $28.00        |
| Quarterly    | `monthly × 3 − quarterlyDiscount` | $74   | $24.67        |
| Annual       | `monthly × 12 − annualDiscount`   | $276  | $23.00        |
| Introductory | `intro.price`                     | $18   | $18.00        |

> **When changing discounts, check the effective monthly column.** The longer
> commitment should always give the better per-month rate, or customers have no
> reason to pay further ahead. Each plan card displays its effective rate, so an
> inverted ladder is visible on the page.

### Changing the pickup days

Edit `schedule.days`. The page builds every sentence from that array and handles
the grammar — one day, two days, or more:

```js
days: ["Tuesday", "Thursday"]; // "Tuesday and Thursday"
days: ["Monday", "Wednesday", "Friday"]; // "Monday, Wednesday and Friday"
```

---

## Feature reference

### Project structure

```
.
├── index.html          # public marketing page markup
├── styles.css          # all styling, numbered sections
├── scripts.js          # all public-page behavior, CONFIG at the top
├── README.md
├── .gitignore
├── .env.example        # (in server/) copy to .env and fill in
├── dashboard/          # role-based operations dashboard (admin/employee/customer)
├── docs/design/        # architecture and design specs
├── images/             # hero, service photos, logo, favicon, OG image
└── server/             # Node + Express application server
    ├── server.js       #   API routes, static serving, security middleware
    ├── db/             #   SQLite schema, migrations, seed
    ├── lib/            #   payments, auth, storage, finance, coupons, ...
    ├── routes/         #   API route modules
    ├── test/           #   unit + adversarial acceptance tests
    ├── .env.example
    └── package.json
```

Both `styles.css` and `scripts.js` open with a table of contents listing their
numbered sections.

### What's in it

| Feature                   | Notes                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- |
| Responsive marketing page | Hero, how-it-works, audience cards, FAQ, contact                                  |
| Promotional coupon modal  | Limited introductory offer, dismissible, remembered for 7 days                    |
| Three pricing plans       | Monthly, quarterly, annual — all calculated from one config value                 |
| Six-step signup flow      | Plan → Info → Address → Availability → Payment → Confirmation                     |
| Service-area check        | Validates the customer's ZIP against a service list                               |
| SEO + social metadata     | Open Graph tags, canonical URL, `LocalBusiness` JSON-LD                           |
| Accessibility             | Keyboard-navigable modal with focus trapping, ARIA states, reduced-motion support |
| Operations dashboard      | Admin, employee, and customer roles behind authentication                         |
| Financials + payroll      | Revenue, labor, expenses, profit — all derived from transactions                  |

### How the first-100 offer works

The introductory rate goes to the first 100 customers who **complete signup and
payment** — not the first 100 who click the offer.

```
Click "Claim My Introductory Rate"   →  selects the plan, scrolls to signup
                                        (does NOT consume a spot)
  ↓
Enter customer information
  ↓
Enter service address / community
  ↓
Confirm service availability
  ↓
Complete payment
  ↓
Spot consumed  ←  only here, in submitSignup()
```

The remaining count renders as _"73 introductory spots remaining."_ in both the
coupon and the pricing section, read live from `GET /api/intro-spots`. When it
reaches zero, the offer block and the introductory plan option hide themselves
automatically.

**Why the popup stops appearing.** Once a visitor dismisses the coupon, it stays
hidden for `intro.remindAfterDays` (7 by default) — a flag in that browser's
`localStorage`. While building or demoing, force it back with `?offer=1` in the
URL (`?offer=0` suppresses it), or clear the flag:

```js
localStorage.removeItem('dtp_promo_dismissed'); location.reload();
```

### Payments (demo provider)

```
Browser                          Your server                    Demo provider
───────                          ───────────                    ─────────────
pick an outcome  ──────────────→ POST /api/checkout
                                   create customer      ──────→  (in-memory, no network)
                                   save payment method  ──────→
                                   charge               ──────→
                                 ←─ status
  ←── confirmation ────────────
```

#### API reference

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness check |
| `GET /api/config` | `{ provider, collectsCard, simulates, outcomes }` |
| `GET /api/intro-spots` | `{ claimed, totalSpots }` |
| `GET /api/service-area?zip=` | `{ available }` |
| `POST /api/checkout` | Customer → payment method → subscription |

#### How the 100 spots stay honest

Every signup writes its records to the database **before** the provider is
called (`lib/signup.js`), and the promotional redemption that counts against the
100-spot cap is recorded only **after** the charge comes back `paid`, inside the
same transaction that marks the payment paid. That check and that write happen
atomically, so two simultaneous checkouts cannot both claim the last spot, and a
declined or failed charge never burns one.

### Dashboard (admin / employee / customer)

A role-based operations dashboard lives behind authentication at `/dashboard/`.

| Role | Sees | Cannot see |
|---|---|---|
| **Admin** | Everything — customers, communities, routes, employees, pickups, payments, audit log | — |
| **Employee** | Only routes assigned to them, their stops, photo submission | Any billing or payment information |
| **Customer** | Only their own account, plan, payments, schedule, history | Other customers, employees, routes |

**Demo sign-in** (after seeding). Open `/dashboard/login.html`:

| Account | Role | Password |
|---|---|---|
| `admin@dashtrashpickup.com` | Admin (owner) | `DashDemo2026` |
| `employee@dashtrashpickup.com` | Employee (training) | `employee` |
| `customer@email.com` | Customer (training) | `customer` |

> Routes only run Tuesday and Thursday, so the employee dashboard is
> legitimately empty on other days. Append `?date=2026-09-15` to
> `/dashboard/employee/` to inspect any service day.

#### How access control works

Two layers, because either alone is insufficient:

1. **Role gate** — `requireRole('admin')` on the router. A wrong role gets
   **404, not 403**; a 403 would confirm the endpoint exists.
2. **Ownership check** — the layer that actually matters. Every customer query
   is scoped by the id from the **session**, never from the URL or body, so
   there is no id to tamper with. Employees can only record a pickup for a stop
   on a route assigned to them that day (`employeeMayServiceUnit`).

Sessions are random tokens in `httpOnly` cookies; only the SHA-256 of the token
is stored, so a database dump yields no usable sessions. Passwords use scrypt
with a per-user salt.

#### Verified by attacking it

| Attempt | Result |
|---|---|
| Employee → any `/api/admin/*` | 404 |
| Customer → any `/api/admin/*` | 404 |
| Customer → `/api/employee/*` | 404 |
| Employee → `/api/customer/*` | 404 |
| No session → anything | 401 |
| Employee records a pickup off their route | 403 |
| Wrong customer opens a pickup photo | 404 |
| Non-intro customer forces `planCode: Introductory` | 403 |
| Raising `plans.price_cents` | locked intro price unchanged |

#### Photos

Employee photos are written outside the web root and streamed back only through
`/api/photos/:id`, which authorizes every single request. A leaked photo URL is
useless without permission. `lib/storage.js` is an adapter: local disk today,
with an `s3` branch to fill in for S3, R2, or any S3-compatible bucket.

#### Audit trail

`audit_log` is append-only and records logins, pickups, route reassignments,
plan changes, cancellations, and admin edits — actor, role, entity, IP, and
timestamp. Visible on the admin dashboard.

#### What is scaffolded but not built

Honest list — the API exists, the UI does not:

- **Drag-to-reorder route stops** — `PUT /api/admin/routes/:id/stops/order` works; there is no drag UI
- **Update payment method** — the customer button explains what is needed; no card-update route yet
- **Create/edit forms** — admin can create communities, buildings, units, employees, and routes via API; the UI is read-plus-reassign
- **GPS capture** — columns exist on `pickup_records`, nothing writes them
- **Reports** — only the open-issues table
- **Property manager accounts, QR codes, notifications, route optimization** — schema accommodates them; not implemented

### Financials, payroll and profitability

The admin dashboard answers the question the business actually needs: **is this
making money?**

```
REVENUE  −  LABOR  −  OPERATING EXPENSES  =  PROFIT
```

Every figure is **derived from transactions** — payments, time entries, expenses.
No total is ever stored, so a number cannot drift from the rows that produced it.
Revenue counts only `status = 'paid'`; failed, pending, and refunded charges are
excluded by design. Reported at four levels: **company**, **route**,
**community**, and **per customer**.

**Time clock.** Employees clock in and out from their phone. A **rate snapshot is
taken at clock-in**, so changing someone's pay rate later never rewrites the cost
of shifts already worked. A unique index enforces one open shift per employee — a
second clock-in is refused with 409. Admins can correct a timesheet, but a
**reason is required** and the before/after is written to the audit trail.

**Compensation** is per-employee and historical, never hard-coded (`hourly` at
hours × rate, or `daily` at shifts × rate). Setting a new rate ends the previous
one the day before, so the rate in force on any date is unambiguous.

**Break-even** reports, per route, how many customers are needed to cover current
expenses. **The pricing simulator** shows what margin each candidate monthly
price *would have* produced over the period, holding cost structure and customer
count constant — it changes nothing for anyone.

**Loss alerts** have four states, each shown with an icon and a label so status
is never carried by color alone: **PROFITABLE** · **LOW MARGIN** · **BREAK EVEN**
· **LOSING MONEY**.

**Charts** are inline SVG, no charting library. The palette was run through a
colorblind-safety validator; every chart ships **direct labels and a "View as
table" toggle**, so identity never depends on color. One y-axis only.

**Expenses** span seventeen categories, each optionally attributed to a route or
community. Anything unattributed is overhead, allocated by revenue share — and
**the allocation method is stated in the code** because every allocation is a
judgement call.

**Portal access.** The public site has a Portal menu with Customer / Employee /
Admin sign-in. All three use the same authentication; **the server decides the
destination from the role**, so the menu is convenience, not security.

| Endpoint | admin | employee | customer | signed out |
|---|---|---|---|---|
| `/api/finance/*` (9 routes) | 200 | **404** | **404** | 401 |
| `/api/employee/shift` | — | 200 | 404 | 401 |

### Employee management and accounts

The **Employees** tab lists staff with search and status filters; opening one
gives a full profile: Profile · Pay (with rate history) · Time · Routes ·
Service · Account · Notes. **Edit employee** changes any of it in place — no
delete-and-recreate. The **Accounts** tab is the central view of every user.

**Employment status:** `active` · `inactive` · `on_leave` · `terminated` ·
`archived`. Leaving `active` also deactivates the login and destroys live
sessions. **Nobody is ever deleted** — the row stays so time entries, pickup
records, and payroll history remain accurate.

**Passwords.** An admin can never see an existing password — only replace it.

| Action | Effect |
|---|---|
| Generate temporary password | Shown **once**, current password stops working, all sessions killed |
| Require change at next login | Sets the flag without changing the password |
| Lock account | Refused at login, sessions destroyed |
| Unlock account | Restores sign-in |

A temporary password is genuinely inert: login succeeds but returns
`mustChangePassword`, every API route answers **403 PASSWORD_CHANGE_REQUIRED**,
and the dashboard **302-redirects** to the change page. Every password action is
written to `password_reset_events` — never the password itself.

**Pay rate history.** Changing a rate never rewrites past payroll:

```
$18.00 hourly   2026-06-14 → 2026-09-11
$20.00 hourly   2026-09-12 → present
```

**Audit trail** records **old → new**, not just that something happened. Role
changes require typing `CHANGE ROLE` to confirm, and an admin cannot change their
own role or lock their own account.

| Endpoint | admin | employee | customer | signed out |
|---|---|---|---|---|
| `/api/people/*` | 200 | **404** | **404** | 401 |
| Issue temp password | 200 | **404** | **404** | 401 |
| Promote self to admin | — | **404** | **404** | 401 |

### Coupons and service credits

Two different things, kept apart in the schema, the routes, and the reports:

| | Coupon | Service credit |
|---|---|---|
| Purpose | Acquire or retain a customer | Apologise for our mistake |
| Who issues | Admin / Manager | Employee (to $5), Manager above |
| Reported as | Marketing discount | Operational cost |
| Table | `coupons`, `coupon_redemptions` | `service_credits` |

**Coupons.** Types: **fixed** dollar off · **percent** off · **promo_price** · 
**free_period**. Each has a window, a redemption cap, a per-customer limit, plan
eligibility, and new-vs-existing targeting. Status is **derived, never stored**,
so it cannot go stale. **Checking a code reserves nothing** — a redemption row is
written only after payment succeeds. The first-100 launch offer is a real coupon
(`DASHLAUNCH`); the public site reads `/api/intro-spots` from it.

**Service credits — the $5 rule.** An employee may issue up to the configured
limit on their own; above it, the credit becomes a request that does nothing
until a manager approves it.

| Amount | Result |
|---|---|
| $5.00 | applied immediately (`auto_approved`) |
| $6.00 | `pending` — sent for approval |
| **$500 from a tampered client** | **still only `pending`** |

The threshold is checked on the server, so editing the request body changes
nothing. Monthly caps also apply — per employee and per customer.

**Manager role.** Permissions are **configurable rows**, not code, so a Manager
never silently inherits Admin:

| | Manager | Admin |
|---|---|---|
| Credit approvals, coupons, reports, routes, customers | ✅ | ✅ |
| **Financials, payroll, account administration** | ❌ | ✅ |

**Financial separation.** Coupon discounts are already absent from collected
revenue (the customer was charged the discounted price), so they are **not**
subtracted again in profit. Service credits **are** subtracted, because they are
money handed back after the fact.

### Community lifecycle and service verification

```
lead → waiting_list / driver_needed → pending_setup → scheduled → active
```

**Creating a community never starts service.** Activation is a separate,
deliberate endpoint that first checks four things: pickup days configured, on at
least one route, a driver assigned, and units exist. A plain
`PATCH {status:'active'}` is **refused** and redirected to the activate endpoint;
activation with failing checks returns **409** listing exactly what is missing
(`force: true` overrides deliberately).

**Waiting list.** `/api/waitlist` is public. Joining creates **no customer, no
subscription, and no charge**. Duplicates are refused, and signing up for an
already-active community redirects to normal signup.

**Photo verification.** A completed pickup requires evidence — completing without
a photo returns **400 `PHOTO_REQUIRED`**. Both photo requirements are settings,
not constants (`pickup.require_photo`, `pickup.require_issue_photo`).

**Every address individually.** The checklist is grouped by building with
per-building progress and an overall count. There is no way to mark a whole
community done — each unit carries its own status, timestamp, employee, photo,
and notes.

**Issue reporting — 13 types:** No trash outside · Unable to access property ·
Trash improperly bagged · Oversized item · Restricted item · Customer not home ·
Incorrect address · Blocked access · Animal / safety issue · Property issue ·
Service problem · Customer not found · Other.

### Admin control: archiving, route versioning, custom roles

The governing rule: **current and future information is editable; history keeps
the values that were true when the work happened.**

**Nothing operational is deleted.** Communities, routes, employees, customers,
pickup records, photos, payments, credits, time entries, and audit logs are never
hard-deleted.

| State | Meaning |
|---|---|
| Active | Editable |
| Inactive / On hold | Retained, not scheduling |
| Archived | Retained for history, hidden from active views |
| Deleted | Only for a record that was never used |

**Locked structural fields.** Once a property has operational history, renaming
it is refused (**409**) — older records would start describing a property that no
longer exists by that name. Operational fields stay editable.

**Route versioning.** Routes carry a configuration versioned by effective date.
Changing a route today closes the old version and opens a new one; it never
rewrites the old one, so historical pickup records keep pointing at the driver
and times that were true on the day.

**Custom roles.** **62 granular permissions across 12 categories**, edited as
checkboxes. Admin always holds everything and cannot be modified. **Enforcement
is server-side** — hiding a button is presentation; the API refuses the request
regardless of what the page shows.

### Cancel, Delete, and Archive

Three distinct actions, and the system decides which is even offered:

| Action | Meaning |
|---|---|
| **Cancel** | Abandon unsaved changes and restore the saved values |
| **Delete** | Permanently remove a record that was *never used* |
| **Archive** | Retire an established record, keeping all its history |

**Cancel restores, it does not merely close.** `guardForm()` snapshots every
field when a form opens; Cancel puts each field back and clears the dirty flag.

**Unsaved-changes warning.** Editing without saving and then leaving prompts
*"You have unsaved changes. Leave without saving?"* — on tab switches inside the
dashboard and on closing the browser tab.

**Delete is decided by the server, not the page.** `lib/deletable.js` inspects
every relationship that would constitute history. The UI calls
`GET .../deletable` to decide whether to render a Delete button — and the
`DELETE` route runs the same check again, so a hand-crafted request cannot
destroy history either. A refusal names exactly what blocks it and suggests
archiving instead. The **audit entry outlives the record**.

---

## Before launch

Placeholder values that need replacing:

- [ ] **Phone number** — `(706) 555-0148` is a fictional 555 number
- [ ] **Email** — `hello@dashtrashpickup.com` (register the domain first)
- [ ] **Domain** — `dashtrashpickup.com` appears in the canonical, OG tags, and JSON-LD
- [ ] **Final pricing** — confirm the monthly rate and both discounts
- [ ] **Introductory rate** — decide between $15 and $18
- [ ] **Service ZIP list** — replace the demo list with real coverage
- [ ] **A real payment provider** — the app currently runs on a demo provider
      that moves no money; connect a real processor before accepting customers
- [ ] **Accepted waste types** — publish restrictions (hazardous materials,
      oversized items, loose liquids, construction debris, unbagged waste)
- [ ] **Holiday schedule** — decide what happens when a pickup day is a holiday
- [ ] **Terms of service and privacy policy** — required once you collect
      customer data and payments

---

## Tech notes

The public page is vanilla HTML, CSS, and JavaScript — no frameworks, no build
step. A few decisions worth knowing about:

- **`[hidden] { display: none !important; }`** in `styles.css` is load-bearing.
  The browser's built-in rule for the `hidden` attribute is easily overridden by
  any author `display` declaration, which silently breaks `element.hidden = true`
  on anything styled as flex or grid — including the modal overlay.
- **`scroll-margin-top: 92px`** on the anchor targets keeps section headings from
  landing underneath the sticky header.
- **`scripts.js` is a classic script, not a module**, so the public page also
  works when opened directly from disk.
- **Images carry `width`/`height`** so the browser reserves space and the layout
  doesn't jump while they load.
- **Every color is a CSS custom property** in `:root`, defined once at the top of
  `styles.css`.

---

## Development tools (optional)

These are conveniences for whoever works on the code. **None of them is required
to install, run, or deploy the application** — it runs on Node and npm alone, and
is not tied to any editor or assistant.

- Any editor or IDE works. Editor- and assistant-specific config directories
  (`.vscode/`, `.idea/`, `.claude/`, `.superpowers/`) are gitignored and are not
  part of the product.
- `npm run dev` (in `server/`) gives auto-restart and browser live-reload while
  developing; `npm test` runs the unit and adversarial acceptance suite.
- Design and architecture specs are kept in `docs/design/`.

---

## Credits

Design and build by **Jey Lofton**.
Logo: Dash Trash Pickup — _Cleaner Communities. Happier Living._
