# System Settings + Data-Driven Business Profile — Design

**Date:** 2026-09-13
**Branch:** `system-settings-branding` (off `security-hardening`)
**Status:** approved design, ready for implementation planning

## Context

This is **sub-project #1 of five** in a white-label initiative that will let Dash
Trash Pickup be resold or reused by another trash-removal company. The five
pieces, in dependency order:

1. **System Settings + permissions + data-driven business profile** — this spec.
2. Theme system + dark mode.
3. Logo & favicon management.
4. Practice / sandbox accounts (employee + customer).
5. First-run bootstrap admin + setup wizard (factory-reset-ready).

Everything else hangs off #1: it establishes the settings area, the granular
permissions, and the branding configuration the other four read from.

The business name "Dash Trash Pickup" is currently hard-coded in 12 files (26
occurrences). This sub-project makes the business identity configurable at
runtime by an authorized admin, with **no visible change until someone edits
it** — defaults seed to the current Dash identity.

## Goal and non-goals

**Goal:** an admin-editable Business Profile whose values flow to every
user-facing surface (page titles, visible branding, SEO meta, server-generated
strings), stored as configuration, gated by granular permissions, and audited.

**Non-goals (deferred to later sub-projects):** logo/favicon (#3), themes and
dark mode (#2), practice accounts (#4), first-run bootstrap (#5), and email
templating (there is no email system yet). The current J Lofton admin account
is retained unchanged.

## Architecture

### A. Data model

Reuse the existing `app_settings` key/value table (`key`, `value`,
`description`, `updated_by`, `updated_at`). Add eight keys via an idempotent
migration (`INSERT OR IGNORE`, so existing installs pick up defaults):

| Key | Seed (current Dash identity) | Public? |
|---|---|---|
| `business.name` | `Dash Trash Pickup` | yes |
| `business.shortName` | `Dash` | yes |
| `business.website` | `https://dashtrashpickup.com` | yes |
| `business.supportEmail` | (from site if present, else blank) | yes |
| `business.supportPhone` | (from site if present, else blank) | yes |
| `business.address` | `Columbus, GA` | yes |
| `business.email` | (internal; from site if present, else blank) | no |
| `business.phone` | (internal; from site if present, else blank) | no |

Values are TEXT. Real current values are lifted from `index.html` where they
exist; anything unknown seeds blank rather than a guess.

### B. Branding source of truth — `server/lib/branding.js`

- `branding()` → full object of all `business.*` values, read from `app_settings`,
  with an in-memory cache invalidated whenever any `business.*` key is written.
- `publicBranding()` → the public subset only (name, shortName, website,
  supportEmail, supportPhone, address).
- Baked-in defaults guarantee a missing key never yields blank UI.
- Server-side callers (`routes/communities.js`, the boot log in `server.js`) call
  `branding().name` directly instead of a literal.

### C. Delivery

**HTML token templating** — `server/lib/htmltemplate.js`:
- Replaces an allowlisted set of `{{brand.*}}` tokens in any served `.html`:
  `brand.name`, `brand.shortName`, `brand.website`, `brand.supportEmail`,
  `brand.supportPhone`, `brand.address`, `brand.email`, `brand.phone`.
- Applied to **all** served HTML in every environment. Today only the dev-reload
  middleware rewrites HTML; this generalizes that transform and dev-reload reuses
  it (so the two rewrites compose, not conflict).
- **Values are HTML-escaped on injection** into text, attributes, and `<title>`.
  This closes a stored-XSS vector: an admin who sets the business name to
  `<script>…</script>` must not inject executable markup into every page. (The
  strict CSP from the security work blocks inline script regardless, but escaping
  is the correct primary defense and also protects attribute contexts.)
- Unknown tokens are left untouched.

**`GET /api/branding`** — public, unauthenticated:
- Returns `publicBranding()` as JSON. Consumed by the public site and by client
  JS that builds strings at runtime (e.g. `customer.js`'s cancel dialog). It
  never exposes the internal `business.email` / `business.phone`.

### D. Converting the 12 files

- Static HTML literals (`index.html`, `dashboard/login.html`,
  `dashboard/change-password.html`, `dashboard/admin|employee|customer/index.html`)
  → `{{brand.name}}` (and `{{brand.shortName}}` where the short form is used):
  titles, visible brand text, footer, hero copy, `alt` attributes, `meta`
  description, OpenGraph `og:site_name`/`og:title`, and JSON-LD `name`.
- `dashboard/customer/customer.js` cancel dialog → reads the name from
  `/api/branding` (fetched once and cached in the module).
- `server/routes/communities.js` waitlist messages → `branding().name`.
- `server/server.js` boot `console.log` → `branding().name`.
- Source-code comments that mention the product name are left as-is (not
  user-facing).

### E. Permissions

Add two permissions to the catalog via migration, granted to `admin` by default
(managers **not** auto-granted, per requirement §28), assignable to custom roles
through the existing dynamic-roles system:

- `system.settings.view` — see the System Settings area and read settings.
- `business.profile.edit` — change Business Profile values.

The J Lofton admin (role `admin`) retains full access.

### F. API — new `server/routes/settings.js`, mounted at `/api/settings`

A dedicated router for the System Settings area, so later sub-projects
(branding/logo, appearance/theme, practice) add sibling routes here.

- `GET /api/settings/business` — requires `system.settings.view` — returns all
  eight fields for editing.
- `PATCH /api/settings/business` — requires `business.profile.edit` — validates,
  saves only changed fields, writes an audit row `settings.business_profile_updated`,
  and invalidates the branding cache.

**Validation:** `name` required, 1–100 chars, control characters rejected;
`email` and `supportEmail` must match the email format when non-empty; `website`
light URL check when non-empty; every field length-capped. Fields are picked
explicitly (no `req.body` spread), consistent with the codebase's mass-assignment
posture.

### G. Dashboard UI

- A new **System Settings** entry in the admin dashboard navigation
  (`dashboard/admin/index.html` + `dashboard/admin/admin.js`), rendered only when
  the signed-in user has `system.settings.view`.
- The area contains a **Business Profile** form following the established
  page-state pattern (edit → Save / Cancel; Cancel reverts to last-saved, writing
  nothing). Save calls `PATCH /api/settings/business`.
- The area's other sections — Branding, Appearance, Practice, Authentication —
  appear as labeled placeholders ("coming soon") that later sub-projects fill in,
  so the navigation shell is established once.

## Testing (TDD, reusing the HTTP acceptance harness)

Unit:
- `branding()` returns seeded defaults; the cache is invalidated after a write.
- `htmltemplate` replaces known tokens, HTML-escapes values, leaves unknown
  tokens untouched, and handles a missing/blank value gracefully.

Integration (boot the app over HTTP against an in-memory DB):
- `GET /api/branding` returns the public fields and omits `business.email` /
  `business.phone`.
- `PATCH /api/settings/business` is refused (403/404) without
  `business.profile.edit` and succeeds for admin.
- After changing `business.name`, a served HTML page shows the new name (token
  replaced) and `GET /api/branding` reflects it.
- A business name containing `<script>` is HTML-escaped in served pages
  (no stored XSS via branding).
- An audit row is written on a successful change.

The full suite (currently 67 tests) stays green.

## Constraints honored

- J Lofton admin account retained.
- Defaults seed to the current identity, so the application is byte-for-byte
  identical to today until an admin edits the Business Profile.
- Consistent with the security posture: explicit field selection, permission
  gating, audit logging, and output escaping.
