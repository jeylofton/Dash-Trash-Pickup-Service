# Dash Trash Pickup

A marketing and signup website for **Dash Trash Pickup**, a doorstep valet trash
collection service for apartment and townhome communities in Columbus, Georgia.

> *Your trash. Our dash.* — residents leave tied household trash outside their
> door twice a week, and we carry it to the community dumpster so they don't
> have to.

Built as a static site with no frameworks, no build step, and no dependencies —
three files and a folder of images.

---

## Contents

- [What's in it](#whats-in-it)
- [Running it locally](#running-it-locally)
- [Project structure](#project-structure)
- [Configuration](#configuration) ← **edit pricing here**
- [How the first-100 offer works](#how-the-first-100-offer-works)
- [Connecting a real backend](#connecting-a-real-backend)
- [Deploying](#deploying)
- [Before launch](#before-launch)
- [Tech notes](#tech-notes)

---

## What's in it

| Feature | Notes |
|---|---|
| Responsive marketing page | Hero, how-it-works, audience cards, FAQ, contact |
| Promotional coupon modal | Limited introductory offer, dismissible, remembered for 7 days |
| Three pricing plans | Monthly, quarterly, annual — all calculated from one config value |
| Six-step signup flow | Plan → Info → Address → Availability → Payment → Confirmation |
| Service-area check | Validates the customer's ZIP against a service list |
| SEO + social metadata | Open Graph tags, canonical URL, `LocalBusiness` JSON-LD |
| Accessibility | Keyboard-navigable modal with focus trapping, ARIA states, reduced-motion support |

---

## Running it locally

The site is plain HTML, so you can **double-click `index.html`** and it will open
in your browser.

To serve it over HTTP instead (closer to how it behaves when deployed):

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

---

## Project structure

```
.
├── index.html          # page markup (497 lines)
├── styles.css          # all styling, 24 numbered sections (630 lines)
├── scripts.js          # all behavior, config at the top (463 lines)
├── README.md
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
    price: 18,              // introductory monthly rate
    totalSpots: 100,        // how many customers get it
    popupDelayMs: 1400,     // delay before the coupon appears
    remindAfterDays: 7,     // don't re-show for this many days after dismissal
  },

  pricing: {
    monthly: 28,            // base monthly price
    quarterlyDiscount: 10,  // $ off the 3-month total
    annualDiscount: 60,     // $ off the 12-month total
    currency: '$',
  },

  schedule: {
    days: ['Tuesday', 'Thursday'],
    perWeek: 2,
    varianceNote: 'Pickup days may vary by community or service area.',
  },

  serviceArea: {
    city: 'Columbus, Georgia',
    zips: ['31901', '31902', /* ... */],
  },
};
```

### Current pricing

Quarterly and annual totals are **calculated**, never typed in by hand:

| Plan | Formula | Total | Effective /mo |
|---|---|---|---|
| Monthly | `monthly` | $28 | $28.00 |
| Quarterly | `monthly × 3 − quarterlyDiscount` | $74 | $24.67 |
| Annual | `monthly × 12 − annualDiscount` | $276 | $23.00 |
| Introductory | `intro.price` | $18 | $18.00 |

> **When changing discounts, check the effective monthly column.** The longer
> commitment should always give the better per-month rate, or customers have no
> reason to pay further ahead. Each plan card displays its effective rate, so an
> inverted ladder is visible on the page.

### Changing the pickup days

Edit `schedule.days`. The page builds every sentence from that array and handles
the grammar — one day, two days, or more:

```js
days: ['Tuesday', 'Thursday']              // "Tuesday and Thursday"
days: ['Monday', 'Wednesday', 'Friday']    // "Monday, Wednesday and Friday"
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

The remaining count renders as *"73 introductory spots remaining."* in both the
coupon and the pricing section. When it reaches zero, the offer block and the
introductory plan option hide themselves automatically.

---

## Connecting a real backend

The site currently runs on demo logic. Three functions in `scripts.js` are the
only places that talk to a server — replace their bodies and nothing else needs
to change:

| Function | Replace with | Returns |
|---|---|---|
| `fetchIntroSpots()` | `GET /api/intro-spots` | `{ claimed: number }` |
| `submitSignup(data)` | `POST /api/checkout` | `{ ok, confirmationId, introApplied }` |
| `checkServiceArea(zip)` | `GET /api/service-area?zip=` | `{ available: boolean }` |

They are already `async`, so swapping in `fetch()` calls is a direct substitution.

### A note on the payment step

**The payment step deliberately collects no card fields.** It's a labeled
placeholder telling you where to mount a hosted checkout.

Card data should never be typed into your own form — use a hosted, PCI-compliant
checkout such as **Stripe Checkout** or **Square**, where the customer enters
their details on the processor's page and you only ever receive a token. Building
your own card inputs would put you on the hook for PCI compliance and put real
card numbers through a page that has no encryption of its own.

---

## Deploying

The site is static, so any host works. Since it's already on GitHub, the simplest
option is **GitHub Pages**:

1. Repository → **Settings** → **Pages**
2. Under *Source*, choose branch `main` and folder `/ (root)`
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
- [ ] **Payment processor** — connect a hosted checkout
- [ ] **Backend** — wire up the three functions above
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
Logo: Dash Trash Pickup — *Cleaner Communities. Happier Living.*
