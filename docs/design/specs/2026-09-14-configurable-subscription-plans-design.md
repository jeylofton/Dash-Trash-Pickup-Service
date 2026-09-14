# Configurable Subscription Plans — Design

**Date:** 2026-09-14
**Branch:** `feature-subscription-plans`
**Status:** Approved design, pending implementation plan

## Purpose

Let the business owner/admin define their own customer subscription model —
plan names, prices, and **any** billing frequency (weekly, biweekly, monthly,
quarterly, bi-annual, annual, or a custom "every N weeks/months") — from the
dashboard, without touching source code. The software must not assume one fixed
billing structure (Monthly / Quarterly / Annual).

## What already exists (and is reused)

- A `plans` table (`code`, `name`, `interval_months`, `price_cents`, `is_intro`,
  `active`), plus `subscriptions.locked_price_cents`, `coupon_plans`, and
  `payments`. Prices already lock per-subscription at signup, so plan edits never
  re-price existing customers — section 10's requirement is already satisfied.
- A data-driven single-action lifecycle engine (`lib/lifecycle.js`,
  demonstrated by `lib/community_lifecycle.js`).
- A granular permission catalog (`permissions` + `role_permissions`) and
  `requirePermission()` middleware (`lib/permissions.js`).
- The dashboard page-state pattern: list → select/manage → edit → save/cancel →
  return to list with nothing selected.
- Demo-only payments (`lib/payments/*`); the DB owns billing.
- A migration mechanism in `db/index.js` (`migrate()` with a guarded
  `addColumn` helper; table rebuilds are already done in `migrate_admin.js`).

## The gap

Billing is stored as a whole `interval_months` integer, so **weekly/biweekly is
impossible**, and `interval_months` is wired into MRR math
(`routes/admin.js`), next-billing-date computation (`lib/signup.js`,
`routes/customer.js`), and customer displays. This is the central thing to fix.

## Design

### 1. Data model — rebuild `plans`

Rebuild the `plans` table (inside a guarded, idempotent migration, preserving the
foreign keys from `subscriptions.plan_id` and `coupon_plans.plan_id`) so the
canonical billing interval is `interval_unit` + `interval_count`:

| column | type | notes |
|---|---|---|
| `id` | INTEGER PK | unchanged |
| `code` | TEXT UNIQUE NOT NULL | kept; auto-slugged from name on create, uniqueness enforced |
| `name` | TEXT NOT NULL | e.g. "Standard Monthly" |
| `description` | TEXT | customer-facing blurb |
| `internal_notes` | TEXT | admin-only |
| `price_cents` | INTEGER NOT NULL | admin controls it; never auto-calculated |
| `currency` | TEXT NOT NULL DEFAULT 'USD' | |
| `interval_unit` | TEXT NOT NULL CHECK IN ('week','month','year') | |
| `interval_count` | INTEGER NOT NULL CHECK (> 0) | "every N units" |
| `customer_available` | INTEGER NOT NULL DEFAULT 0 | section 6 |
| `status` | TEXT NOT NULL DEFAULT 'draft' CHECK IN ('draft','active','inactive','archived') | replaces `active` boolean |
| `display_order` | INTEGER NOT NULL DEFAULT 0 | section 7 |
| `label` | TEXT | optional; "Most Popular", "Best Value", … (section 8, not hard-coded) |
| `is_intro` | INTEGER NOT NULL DEFAULT 0 | kept (launch-promotion marker) |
| `provider_plan_id` | TEXT | kept |
| `created_at` | TEXT NOT NULL DEFAULT datetime('now') | |
| `updated_at` | TEXT | set on edit |
| `archived_at` | TEXT | set when archived |

**Migration / backfill:** existing rows map to `interval_unit='month'`,
`interval_count = interval_months`, `status = active?'active':'inactive'`,
`customer_available = active`, `display_order` by id. The deactivated
`Introductory` row (already `active=0` per current migration) becomes
`status='inactive'`. The rebuild is skipped once the new shape is detected
(guarded by a `PRAGMA table_info` check on `interval_unit`), so repeated boots
are no-ops.

**`interval_months` is retired from code.** A new `lib/billing.js` centralizes
the two operations that used it:
- `monthsEquivalent(unit, count)` → fractional months, for MRR normalization
  (week = count×7/30.436, month = count, year = count×12).
- `addInterval(dateISO, unit, count)` → next-billing date, replacing
  `setMonth(+interval_months)` and the `+N days` SQL in the customer plan change.
- `frequencyLabel(unit, count)` → display string ("weekly", "every 2 weeks",
  "monthly", "every 6 months", "yearly"), and `priceLabel(cents, unit, count)`
  → "$8 / week", "$155 / 6 months".

All current `interval_months` call sites (`routes/admin.js` MRR,
`routes/customer.js` `/subscription`, `/plans`, `/plan/change`, `lib/signup.js`
next-billing) switch to these helpers.

### 2. Price changes — section 11 (record + grace period, then switch)

**The rule (per owner decision):**
- **New customers** always pay the plan's current *advertised* price at the
  moment their subscription starts — this is exactly how signup already works
  (price locks per-subscription at signup). Changing a plan's price updates the
  advertised price immediately, so anyone who signs up afterward gets it.
- **Existing customers** keep their current price for a **grace period
  (~90 days by default)**, then switch to the new price. The grace length is a
  configurable setting, not a hard-coded number.

New setting (seeded into `app_settings`, editable in System Settings):
`plan.price_change_grace_days` = `'90'` — "How long existing subscribers keep
their old price after a plan price change before switching to the new one."

New table `plan_price_changes`:

| column | notes |
|---|---|
| `id` PK | |
| `plan_id` → plans(id) | |
| `old_price_cents`, `new_price_cents` | |
| `applies_to` CHECK IN ('new','existing_and_new') | |
| `effective_date` | YYYY-MM-DD — when EXISTING customers switch |
| `reason` | text, optional |
| `status` CHECK IN ('scheduled','applied','cancelled') DEFAULT 'scheduled' | |
| `created_by` → users(id), `created_at`, `applied_at` | |

Flow when an admin changes a price:
- The plan's advertised `price_cents` updates **immediately** (new customers get
  the new price at signup from that point on). `updated_at` is set.
- If `applies_to='new'`: no `plan_price_changes` row is needed; existing
  subscribers keep their `locked_price_cents` unchanged (indefinitely).
- If `applies_to='existing_and_new'`: a `plan_price_changes` row is written with
  `effective_date` defaulting to **today + `plan.price_change_grace_days`**. The
  admin may push it later, but not silently earlier than a sensible minimum; the
  form pre-fills the +90-day date and shows it plainly, so existing pricing is
  never changed without an explicit, dated decision.

Function `applyDuePriceChanges()` (in `lib/plans.js`), idempotent and cheap
(`WHERE status='scheduled' AND effective_date <= date('now')`), runs on boot
(from `migrate()` / server start) and at the top of admin + customer plan reads.
When a row comes due it:
- Updates `locked_price_cents = new_price_cents` for that plan's live
  subscriptions (`status IN ('active','past_due','paused')`) whose locked price is
  still the old price, and writes an `audit_log` row per change. **`payments`
  history is never touched** (section 10). Promo/intro subscriptions keep their
  frozen `promo_price_cents` until it expires, then revert to the new standard
  `locked_price_cents`.
- Marks the row `applied`, sets `applied_at`.

Editing a plan's price directly in the Edit form is the `new`-scope path (new
customers only). Switching existing customers is the explicit effective-dated
action above, defaulting to the 90-day grace.

### 3. Lifecycle & management — sections 2, 9

`lib/plan_lifecycle.js` drives `lib/lifecycle.js` with statuses
draft/active/inactive/archived and single-action transitions:

- **activate** (draft/inactive → active)
- **deactivate** (active → inactive) — stops new subscriptions; existing history
  stays
- **archive** (any → archived) — out of active views, preserved historically;
  sets `archived_at`
- **restore** (archived → inactive)

Create, Edit, and **Duplicate** are ordinary CRUD (not lifecycle transitions).
Duplicate clones a plan as a fresh `draft` with a new unique code, name +
" (Copy)", `customer_available=0`, and no subscription history.

**No hard-delete of a plan with subscription history.** A `deletable`-style
check (mirroring `lib/deletable.js`) reports whether any `subscriptions` or
`coupon_plans` reference the plan; if so, Delete is unavailable and Archive is
the path. A never-used draft with zero references may be hard-deleted.

### 4. Admin UI — sections 15, 16

New **"Subscription Plans"** tab in the admin dashboard
(`public/dashboard/admin/index.html` + `admin.js`), following the existing
page-state pattern (list → manage → edit → save/cancel → back to list with
nothing selected; tab re-entry resets selection).

List table columns (section 15): **Plan · Price · Billing Frequency · Customer
Available · Status · Customers · Action**. "Customers" is the count of live
subscriptions on the plan. Create/Edit form fields: name, description, price,
billing frequency (with a Custom option exposing unit + count), customer
availability, status, display order, label, internal notes.

New `routes/plans.js` mounted under `/api/admin/plans`:
- `GET /` list (with customer counts), `GET /:id` one, `POST /` create,
  `PATCH /:id` edit, `POST /:id/duplicate`, `DELETE /:id` (guarded by the
  deletability check).
- `GET /:id/actions` + `POST /:id/action` for lifecycle transitions (mirrors the
  community lifecycle endpoints).
- `POST /:id/price-change` to schedule a section-11 price change;
  `GET /:id/price-changes` to list them; `POST /:id/price-change/:pcid/cancel`.

All routes guarded by the new permissions below and audited via `lib/audit.js`.

### 5. Permissions — section 18

Add to the `permissions` catalog (new "Plans & Billing" category):
`plans.view`, `plans.create`, `plans.edit`, `plans.status` (activate/deactivate),
`plans.archive`. Admin is absolute already; other roles gated via
`role_permissions`. The admin tab is hidden unless the user has `plans.view`
(same `data-perm` mechanism as System Settings).

### 6. Customer selection — section 12 (authenticated dashboard only, per decision)

`routes/customer.js` `/plans` filters to `status='active' AND
customer_available=1`, ordered by `display_order`, and returns each plan's real
billing frequency + price label from `lib/billing.js`. The current-plan row is
still always included even if it later becomes unavailable (existing behavior).
`/plan/change` validates the target the same way (active + available) and uses
`addInterval()` for the new `next_billing_date`.

**Out of scope:** the public marketing signup wizard
(`public/index.html`, `public/scripts.js`) stays on its current hardcoded
intro/Monthly/Quarterly/Annual flow — the delicate first-100 intro-promotion
logic in `lib/signup.js` is untouched.

### 7. Demo payment compatibility — section 13

No change to `lib/payments/*`. A customer selecting any configured plan (e.g. a
weekly or bi-annual plan) charges the plan's price through the demo provider and
creates the subscription with `locked_price_cents` and an `addInterval()`-derived
`next_billing_date`. Verified by a test using a weekly plan.

### 8. Coupon compatibility — section 14 (integrate, do not redesign)

The existing `coupon_plans` eligibility system references plans by id/code, which
persist through the rebuild — so it keeps working unchanged. The only UI change:
the hardcoded plan `<option>` list in the customer-filter dropdown
(`index.html:63`, Introductory/Monthly/Quarterly/Annual) and any other hardcoded
plan pickers become dynamically populated from the configured non-archived plans,
so newly created plans appear automatically. No change to coupon data model or
redemption logic.

### 9. Seed data

`db/seed.js` updates the seeded plans to the new columns
(`status='active'`, `customer_available=1`, sensible `display_order`) and adds
two non-monthly examples so those paths are exercised out of the box:

| code | name | interval | example price |
|---|---|---|---|
| Weekly | Weekly | week × 1 | $8 / week |
| Monthly | Monthly | month × 1 | (existing) |
| Quarterly | Quarterly | month × 3 | (existing) |
| BiAnnual | Bi-Annual | month × 6 | $155 / 6 months |
| Annual | Annual | year × 1 | (existing) |

The `plan.price_change_grace_days` setting (default `'90'`) is seeded into
`app_settings`. Reference-data seeding only — no change to how demo
customers/subscriptions are generated.

## Testing (node:test, existing style under `server/test/`)

1. **Billing math** — `lib/billing.js`: `addInterval` and `monthsEquivalent`
   for day/week/month/year and multi-count intervals; `priceLabel`/`frequencyLabel`.
2. **Migration/rebuild** — old plans backfill to unit+count; FKs from
   subscriptions/coupon_plans survive; rebuild is idempotent.
3. **Lifecycle** — draft→active→inactive→archived→restore; invalid transitions
   rejected server-side.
4. **No delete with history** — a plan with a subscription cannot be
   hard-deleted; a fresh draft can.
5. **Price change** — a `new`-scope change updates the advertised price
   immediately and touches no existing subscriber; an `existing_and_new` change
   defaults its effective date to today + grace days, and once due applies to
   live subscriptions' `locked_price_cents`, leaves `payments` history untouched,
   and is idempotent (re-running does not double-apply). Grace default is read
   from `plan.price_change_grace_days`.
6. **Customer availability gating** — `/plans` returns only active + available
   plans in `display_order`; a draft/unavailable plan is hidden.
7. **Coupon eligibility intact** — a coupon restricted to a plan still validates
   after the rebuild.
8. **Demo payment with a weekly plan** — signup/charge on a weekly plan creates a
   subscription with the correct locked price and next-billing date.

## Risks & mitigations

- **`plans` table rebuild** is the riskiest step. Mitigation: guarded/idempotent
  migration that recreates the table with FKs, copies rows, and is skipped once
  the new shape exists; covered by a migration test; taken on an isolated feature
  branch.
- **Re-pricing existing subscribers** changes only their current forward rate,
  never past invoices; gated behind an explicit effective-dated action.
- **No scheduler** — price changes apply lazily on boot and on plan reads, which
  is sufficient because billing here is demo/manual.

## Non-goals

- No real payment provider.
- No pricing calculator (section 5 — admin sets prices directly).
- No changes to the public marketing wizard or the coupon/credit data models.
- No customer-facing plan changes beyond what already exists.
