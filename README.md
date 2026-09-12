# Dash Trash Pickup

A marketing and signup website for **Dash Trash Pickup**, a doorstep valet trash
collection service for apartment and townhome communities in Columbus, Georgia.

> _Your trash. Our dash._ — residents leave tied household trash outside their
> door twice a week, and we carry it to the community dumpster so they don't
> have to.

The website is plain HTML, CSS, and JavaScript with no framework and no build
step. Payments run on a small Node + Express server that talks to Square.

---

## Contents

- [What's in it](#whats-in-it)
- [Running it locally](#running-it-locally)
- [Project structure](#project-structure)
- [Configuration](#configuration) ← **edit pricing here**
- [How the first-100 offer works](#how-the-first-100-offer-works)
- [Payments (Square)](#payments-square)
- [Dashboard (admin / employee / customer)](#dashboard-admin--employee--customer)
- [Deploying](#deploying)
- [Before launch](#before-launch)
- [Tech notes](#tech-notes)

---

## What's in it

| Feature                   | Notes                                                                             |
| ------------------------- | --------------------------------------------------------------------------------- |
| Responsive marketing page | Hero, how-it-works, audience cards, FAQ, contact                                  |
| Promotional coupon modal  | Limited introductory offer, dismissible, remembered for 7 days                    |
| Three pricing plans       | Monthly, quarterly, annual — all calculated from one config value                 |
| Six-step signup flow      | Plan → Info → Address → Availability → Payment → Confirmation                     |
| Service-area check        | Validates the customer's ZIP against a service list                               |
| SEO + social metadata     | Open Graph tags, canonical URL, `LocalBusiness` JSON-LD                           |
| Accessibility             | Keyboard-navigable modal with focus trapping, ARIA states, reduced-motion support |

---

## Running it locally

One command runs everything — the public site, the dashboard, and the API all
serve from the same port.

### In VS Code

1. **File → Open Folder** → select the `columbus-valet-trash` folder
   (open *this* folder, not its parent — the configs use `${workspaceFolder}`)
2. Open a terminal with **Ctrl+`** and run the one-time setup:
   ```bash
   cd server
   npm install
   cp .env.example .env
   node db/seed.js
   ```
3. Press **F5**, or Run → Start Debugging, and pick **Run Dash Trash Pickup**
4. VS Code opens <http://localhost:3000> automatically

Breakpoints work: click in the gutter of any file in `server/` and the debugger
stops there.

**Other launch configurations** (the dropdown in the Run panel):

| Configuration | Does |
|---|---|
| Run Dash Trash Pickup | Normal start, reads `server/.env` |
| Run (no .env file yet) | Same, but works before you create `.env` |
| Seed demo data | Adds demo data if the database is empty |
| Seed demo data (RESET) | **Wipes everything** and rebuilds |

**Tasks** (Ctrl+Shift+P → *Tasks: Run Task*) cover the same ground without the
debugger, including **Setup: install + seed + start** which chains all three.

### From any terminal

```bash
cd server && npm install && node db/seed.js && npm start
```

### What you get

| URL | |
|---|---|
| <http://localhost:3000> | Public marketing site |
| <http://localhost:3000/dashboard/login.html> | Sign in (all three roles) |
| <http://localhost:3000/api/health> | API check |

> **Not port 5000 on macOS.** AirPlay Receiver holds it and returns a confusing
> `403`. This app uses 3000, so you only hit that if you change `PORT`.

Stop the server with **Ctrl+C**, or the red stop button in the debug toolbar.

> ### Do not use Live Server
>
> Right-clicking an HTML file → *Open with Live Server* serves the page on
> port 5500, but Live Server only handles GET. Sign-in is a POST, so it fails
> with **`Request failed (405)`** — which looks like a wrong password but is not.
>
> Live Server cannot run this app on any port: it is a static file server, and
> the API only exists inside the Node process. Always open
> **<http://localhost:3000>**.

### Live reload (the part of Live Server worth keeping)

The dev server refreshes the browser on save by itself — no extension needed.
Edit any `.html`, `.css`, or `.js` file and every open page reloads.

It works by injecting a tiny `EventSource` snippet into HTML **as it is served**,
so nothing dev-only ever lives in the committed files. It turns itself off when
`NODE_ENV=production` (verified: no snippet, and `/__dev/reload` returns 404).

To disable it in development, set `DEV_RELOAD=0`.

For backend changes, `npm run dev` restarts the server on save:

```bash
cd server && npm run dev
```

## Project structure

```
.
├── index.html          # page markup
├── styles.css          # all styling, 24 numbered sections
├── scripts.js          # all behavior, config at the top
├── README.md
├── .gitignore
├── server/             # Square payment backend (Node + Express)
│   ├── server.js       #   API routes
│   ├── square.js       #   Square REST client
│   ├── store.js        #   introductory-spot counter
│   ├── .env.example    #   copy to .env and fill in
│   └── package.json
└── images/
    ├── townhomes-hero.jpg      # hero background
    ├── valet-trash-pickup.jpg  # service photo
    ├── columbus-aerial.jpg     # service-area photo
    └── logo/
        ├── Dash_Trash_Logo.png   # full logo (light backgrounds)
        ├── mark-128-dark.png     # icon recolored for the dark header
        ├── favicon-32.png        # browser tab icon
        ├── apple-touch-icon.png  # iOS home-screen icon
        └── og-image.jpg          # link-preview image
```

Both `styles.css` and `scripts.js` open with a table of contents listing their
numbered sections, so you can jump straight to the part you want.

---

## Configuration

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

The variance wording ("Pickup days may vary by community or service area")
appears alongside the days everywhere, since schedules differ by property.

---

## How the first-100 offer works

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
coupon and the pricing section. When it reaches zero, the offer block and the
introductory plan option hide themselves automatically.

---

## Payments (Square)

Payments run through **Square**, using recurring subscriptions and Square's
Web Payments SDK. Card details are entered in an iframe served by Square and go
straight to Square — **a raw card number never touches this site or its server.**

```
Browser                          Your server                    Square
───────                          ───────────                    ──────
Square card iframe
  → card token  ──────────────→  POST /api/checkout
                                   create customer      ──────→
                                   create card on file  ──────→
                                   create subscription  ──────→
                                 ←─ subscription id
  ←── confirmation ────────────
```

The site works **without** the server running — it falls back to demo mode,
where the signup flow completes end to end but nothing is charged. That's what
lets you keep developing the front end without Square credentials.

### Square setup

**1. Create an application**

Go to <https://developer.squareup.com/apps> → *Create app*. From the app's
**Credentials** page, copy the **Sandbox** values:

| Value | Where it goes | Secret? |
|---|---|---|
| Sandbox Access Token | `SQUARE_ACCESS_TOKEN` | **Yes — server only** |
| Sandbox Application ID | `SQUARE_APPLICATION_ID` | No — sent to the browser |
| Sandbox Location ID | `SQUARE_LOCATION_ID` | No — sent to the browser |

> The access token can create charges on your account. It must never appear in
> `scripts.js`, in the HTML, or in any file you commit.

**2. Create the subscription plans**

Square bills subscriptions from *plan variations* in your catalog. In the
[Square Dashboard](https://squareup.com/dashboard) → **Items & Services** →
**Subscription Plans**, create one plan per pricing tier:

| Plan | Price | Billing cadence | `.env` variable |
|---|---|---|---|
| Introductory | $18 | Monthly | `SQUARE_PLAN_INTRODUCTORY` |
| Monthly | $28 | Monthly | `SQUARE_PLAN_MONTHLY` |
| Quarterly | $74 | Every 3 months | `SQUARE_PLAN_QUARTERLY` |
| Annual | $276 | Annually | `SQUARE_PLAN_ANNUAL` |

Copy each **plan variation ID** into the matching variable.

> Keep these prices in step with `CONFIG.pricing` in `scripts.js`. The website
> displays the price from `CONFIG`, but Square charges the amount on the plan
> variation. If they disagree, **Square wins** and your customer is charged
> something different from what they saw.

**3. Configure and run**

```bash
cd server
cp .env.example .env     # then fill in the values above
npm install
npm start
```

The server checks your credentials at boot and tells you what's missing:

```
  Dash Trash Pickup API
  http://localhost:3000   [sandbox]

  Square credentials OK - 1 location(s) found
  Using location: Dash Trash Pickup (L7XYZ...)
```

**4. Run the site against it**

The server serves the public site too, so there is no second process:
open <http://localhost:3000>.

> This app uses port 3000. Avoid 5000 on macOS — AirPlay Receiver holds it and
> returns a confusing `403`.

### Testing with sandbox cards

While `SQUARE_ENVIRONMENT=sandbox`, use Square's
[test card numbers](https://developer.squareup.com/docs/devtools/sandbox/payments) —
e.g. `4111 1111 1111 1111`, any future expiry, any CVV, ZIP `31904`. Real cards
are declined in sandbox, and test cards are declined in production.

### Going live

1. Swap every `.env` value for its **Production** equivalent
2. Set `SQUARE_ENVIRONMENT=production`
3. Recreate the subscription plans in your production catalog — sandbox and
   production catalogs are separate, so the plan variation IDs are different
4. Set `ALLOWED_ORIGINS` to your real domain
5. Configure the webhook (below)
6. Serve everything over HTTPS — Square's SDK refuses to run on plain HTTP
   outside localhost

### Webhooks

Recurring charges happen on Square's schedule, not yours, so a renewal
succeeding or failing is something Square has to tell you about.

In the Square Dashboard → **Webhooks**, add a subscription pointing at
`https://your-domain.com/api/webhooks/square` for at least:

- `invoice.payment_made` — a renewal succeeded
- `invoice.scheduled_charge_failed` — a renewal failed; suspend service or chase the customer
- `subscription.updated` — paused, resumed, or cancelled

Put the signing key in `SQUARE_WEBHOOK_SIGNATURE_KEY` and the exact URL in
`WEBHOOK_URL`. The server verifies every webhook's HMAC signature and rejects
anything that doesn't match — without that check, anyone who finds the URL could
post fake payment events.

### API reference

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Liveness check |
| `GET /api/config` | Publishable Square IDs for the browser |
| `GET /api/intro-spots` | `{ claimed, totalSpots }` |
| `GET /api/service-area?zip=` | `{ available }` |
| `POST /api/checkout` | Customer → card on file → subscription |
| `POST /api/webhooks/square` | Signed events from Square |

### How the 100 spots stay honest

The introductory spot is **reserved before** Square is called and **released if
Square fails**, so a declined card never burns a spot and nobody is charged the
intro rate after it sells out. Reservation is serialized through a lock, tested
at 250 simultaneous attempts against a 100-spot pool: exactly 100 granted.

> **Single process only.** The counter lives in `server/data/signups.json` and
> the lock is per-process. If you ever run more than one instance, move the
> counter to a database and do the increment in one conditional statement —
> `store.js` has the SQL in a comment.

## Dashboard (admin / employee / customer)

A role-based operations dashboard lives behind authentication at `/dashboard/`.

| Role | Sees | Cannot see |
|---|---|---|
| **Admin** | Everything — customers, communities, routes, employees, pickups, payments, audit log | — |
| **Employee** | Only routes assigned to them, their stops, photo submission | Any billing or payment information |
| **Customer** | Only their own account, plan, payments, schedule, history | Other customers, employees, routes |

### Signing in

```bash
cd server
npm install
node db/seed.js        # demo data; add --reset to rebuild
npm start
```

Open <http://localhost:3000/dashboard/login.html>. Demo password `DashDemo2026`:

| Account | Role |
|---|---|
| `admin@dashtrashpickup.com` | Admin |
| `marcus@dashtrashpickup.com` | Employee |
| `olivia.bell6@example.com` | Customer |

> Routes only run Tuesday and Thursday, so the employee dashboard is
> legitimately empty on other days. Append `?date=2026-09-15` to
> `/dashboard/employee/` to inspect any service day.

### How access control works

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

### Verified by attacking it

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

### Photos

Employee photos are written outside the web root and streamed back only through
`/api/photos/:id`, which authorizes every single request. A leaked photo URL is
useless without permission. The database stores only the storage key.

`lib/storage.js` is an adapter: local disk today, with an `s3` branch to fill in
for S3, R2, or any S3-compatible bucket. Upload code does not change.

### Database

22 tables in SQLite (`server/data/dash.db`), created from `db/schema.sql`.
Design rules: one fact in one place, and nothing a service history points at is
ever hard-deleted.

The important one: **`subscriptions.locked_price_cents`**. A subscription stores
the price it locked in at signup, so editing `plans.price_cents` later never
re-prices an existing customer. That is what protects the introductory rate.

`node:sqlite` is built into Node 22+, so there is no native module to compile.
To move to PostgreSQL later, the schema is plain SQL and `db/index.js` is the
only file that knows about the driver.

### Audit trail

`audit_log` is append-only and records logins, pickups, route reassignments,
plan changes, cancellations, and admin edits — actor, role, entity, IP, and
timestamp. Visible on the admin dashboard.

### What is scaffolded but not built

Honest list — the API exists, the UI does not:

- **Drag-to-reorder route stops** — `PUT /api/admin/routes/:id/stops/order` works; there is no drag UI
- **Update payment method** — the customer button explains what is needed; no Square card-update route yet
- **Create/edit forms** — admin can create communities, buildings, units, employees, and routes via API; the UI is read-plus-reassign
- **GPS capture** — columns exist on `pickup_records`, nothing writes them
- **Reports** — only the open-issues table
- **Property manager accounts, QR codes, notifications, route optimization** — schema accommodates them; not implemented

---

## Financials, payroll and profitability

The admin dashboard answers the question the business actually needs: **is this
making money?**

### What it computes

```
REVENUE  −  LABOR  −  OPERATING EXPENSES  =  PROFIT
```

Every figure is **derived from transactions** — payments, time entries, expenses.
No total is ever stored, so a number cannot drift from the rows that produced it.
Revenue counts only `status = 'paid'`; failed, pending, and refunded charges are
excluded by design.

Reported at four levels: **company**, **route**, **community**, and
**per customer** (average revenue / cost / profit).

### Time clock

Employees clock in and out from their phone. The system records employee, date,
times, break, payable minutes, optional GPS, and device. A **rate snapshot is
taken at clock-in**, so changing someone's pay rate later never rewrites the cost
of shifts already worked.

A unique index enforces one open shift per employee — a second clock-in is
refused with 409.

Admins can correct a timesheet, but a **reason is required** and the before/after
is written to the audit trail.

### Compensation

Per-employee and historical, never hard-coded:

| Pay type | Rate | Payroll |
|---|---|---|
| `hourly` | $18.00/hr | hours × rate |
| `daily` | $90.00/shift | shifts × rate |

Setting a new rate ends the previous one the day before, so the rate in force on
any date is unambiguous.

### Break-even and pricing

**Break-even** reports, per route, how many customers are needed to cover current
expenses. It treats current expenses as fixed and current revenue-per-customer as
each new customer's contribution — a floor, not a promise, since a real extra
customer adds some cost too.

**The pricing simulator** shows what margin each candidate monthly price *would
have* produced over the period, holding cost structure and customer count
constant. It answers "what if we had charged X", not "what happens if we change
to X" — customers may leave at a higher price. It changes nothing for anyone.

### Loss alerts

Four states, each shown with an icon and a label so status is never carried by
color alone: **PROFITABLE** · **LOW MARGIN** · **BREAK EVEN** · **LOSING MONEY**.
Alerts fire for company-level losses, unprofitable routes and communities, labor
above 50% of revenue, and customers priced below cost to serve.

### Charts

Inline SVG, no charting library. The palette was run through a colorblind-safety
validator rather than eyeballed:

| Check | Result |
|---|---|
| Lightness band | PASS |
| Chroma floor | PASS |
| CVD separation (protan/deutan) | PASS — worst ΔE 10.1 |
| Normal-vision separation | PASS — worst ΔE 24.0 |
| Contrast vs surface | WARN on aqua (2.82) |

The contrast warning is why every chart ships **direct labels and a "View as
table" toggle** — identity never depends on color. One y-axis only; never two
scales on one chart.

### Expenses

Seventeen categories, with each expense optionally attributed to a route or a
community. Anything unattributed is overhead and gets allocated by revenue share
in the profitability math — **the allocation method is stated in the code**
because every allocation is a judgement call.

### Portal access

The public site has a **Portal** menu with Customer / Employee / Admin sign-in.
All three use the same authentication; **the server decides the destination from
the role**, so the menu is convenience, not security. An employee who types
`/dashboard/admin/` is redirected to their own dashboard, and every
`/api/finance/*` endpoint returns 404 for non-admins.

| Endpoint | admin | employee | customer | signed out |
|---|---|---|---|---|
| `/api/finance/*` (9 routes) | 200 | **404** | **404** | 401 |
| `/api/employee/shift` | — | 200 | 404 | 401 |

## Deploying

The site is static, so any host works. Since it's already on GitHub, the simplest
option is **GitHub Pages**:

1. Repository → **Settings** → **Pages**
2. Under _Source_, choose branch `main` and folder `/ (root)`
3. Save — the site publishes at
   `https://jeylofton.github.io/Dash-Trash-Pickup-Service/`

Netlify and Cloudflare Pages also work by pointing them at the repo with no build
command.

After deploying to a real domain, update these to the live URL:

- `<link rel="canonical">` in `index.html`
- `og:url` and `og:image` meta tags
- `url` and `image` in the `LocalBusiness` JSON-LD block

---

## Before launch

Placeholder values that need replacing:

- [ ] **Phone number** — `(706) 555-0148` is a fictional 555 number
- [ ] **Email** — `hello@dashtrashpickup.com` (register the domain first)
- [ ] **Domain** — `dashtrashpickup.com` appears in the canonical, OG tags, and JSON-LD
- [ ] **Final pricing** — confirm the monthly rate and both discounts
- [ ] **Introductory rate** — decide between $15 and $18
- [ ] **Service ZIP list** — replace the demo list with real coverage
- [ ] **Square production credentials** — app, location, and plan variation IDs
- [ ] **Webhook endpoint** — deployed over HTTPS with its signature key set
- [ ] **Accepted waste types** — publish restrictions (hazardous materials,
      oversized items, loose liquids, construction debris, unbagged waste)
- [ ] **Holiday schedule** — decide what happens when a pickup day is a holiday
- [ ] **Terms of service and privacy policy** — required once you collect
      customer data and payments

---

## Tech notes

Vanilla HTML, CSS, and JavaScript. No frameworks, no build step, no npm.

A few decisions worth knowing about if you come back to this later:

- **`[hidden] { display: none !important; }`** in `styles.css` is load-bearing.
  The browser's built-in rule for the `hidden` attribute is easily overridden by
  any author `display` declaration, which silently breaks `element.hidden = true`
  on anything styled as flex or grid — including the modal overlay.
- **`scroll-margin-top: 92px`** on the anchor targets keeps section headings from
  landing underneath the sticky header.
- **`scripts.js` is a classic script, not a module.** Modules are blocked by CORS
  over `file://`, so keeping it classic is what lets you double-click
  `index.html` and have the page work.
- **Images carry `width`/`height`** so the browser reserves space and the layout
  doesn't jump while they load.
- **Every color is a CSS custom property** in `:root` — the orange, charcoal,
  white, and gray palette is defined once at the top of `styles.css`.

---

## Credits

Design and build by **Jey Lofton**.
Logo: Dash Trash Pickup — _Cleaner Communities. Happier Living._
