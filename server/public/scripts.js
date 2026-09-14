/* ============================================================
   Dash Trash Pickup - page behavior
   Doorstep valet trash collection | Columbus, Georgia

   Contents
     1. CONFIG  <-- change pricing, the intro offer, and the schedule HERE
     2. Derived pricing helpers
     3. Backend (demo payments only - no card data is ever collected)
     4. Render: prices, schedule, spots remaining
     5. Introductory offer modal
     6. Signup flow (plan -> info -> address -> availability -> payment -> done)
     7. Mobile navigation toggle
     8. Footer year

   Loaded with `defer`, so the DOM is parsed before this runs.
   ============================================================ */

(() => {
  'use strict';

  /* ============================================================
     1. CONFIG - the single place to edit pricing and the offer
     ============================================================ */
  const CONFIG = {

    /* ---- Limited introductory offer ---- */
    intro: {
      enabled: true,
      price: 18,            // <-- $15 or $18. Change this one number.
      totalSpots: 100,
      label: 'Introductory Rate',
      // How long the introductory price lasts before the standard monthly
      // rate takes over. This number MUST match the intro phase billed by
      // the server (server/lib/signup.js), so the disclosed term is never
      // out of sync with what the customer is actually charged.
      termMonths: 12,
      // How long before the popup appears, and how often a visitor sees it.
      popupDelayMs: 1400,
      remindAfterDays: 7,   // dismissed? don't show again for this many days
    },

    /* ---- Currency symbol for display ---- */
    currency: '$',

    /* ---- Standard plans ----
       There is intentionally NO hard-coded plan pricing here. Plans (name,
       price, billing frequency, label, availability, display order) are the
       admin's data and are fetched from /api/subscription-plans/public — the
       same records Admin -> Subscription Plans manages. Edit a plan there and
       it changes everywhere; nothing about pricing is edited in this file. */

    /* ---- Service schedule ----
       Days are written once here and rendered everywhere they appear. */
    schedule: {
      days: ['Tuesday', 'Thursday'],
      perWeek: 2,
      varianceNote: 'Pickup days may vary by community or service area.',
    },

    /* ---- Payment backend ----
       Where the API server lives. Leave as '' when the API is served from
       the same origin as this page. If the API runs elsewhere, put its base
       URL here (and add this site's origin to ALLOWED_ORIGINS in server/.env).

       The server is demo-only: it never collects or stores real card data. */
    api: {
      // '' means "same origin as this page" - correct once the site and the
      // API are deployed together. During local development the site is on
      // one port and the API on another, so localhost is redirected below.
      baseUrl: '',
      localDevUrl: 'http://localhost:3000',
      enabled: true,  // Set to false for offline testing when the API server is unavailable
    },

    /* ---- Service area (used by the availability step) ---- */
    serviceArea: {
      city: 'Columbus, Georgia',
      // Demo ZIP list. Replace with a real lookup against your service map.
      zips: ['31901','31902','31903','31904','31905','31906','31907','31908','31909','31914','31917'],
    },
  };

  /* ============================================================
     2. Derived pricing helpers
     ============================================================ */
  const money = (n) => {
    const v = Math.round(n * 100) / 100;
    const str = Number.isInteger(v) ? v.toString() : v.toFixed(2);
    return CONFIG.currency + str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  // Plan names and labels are admin-entered, so escape them before they ever
  // touch innerHTML.
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* Average Gregorian month — mirrors server/lib/billing.js so the client's
     "effective monthly" and savings figures match the backend's math. */
  const DAYS_PER_MONTH = 30.436875;
  function monthsEquivalent(unit, count) {
    const n = Number(count) || 0;
    if (unit === 'week') return (n * 7) / DAYS_PER_MONTH;
    if (unit === 'year') return n * 12;
    return n; // month
  }

  /* The plans fetched from the backend — the single source of truth — in the
     admin's display order, plus a by-code view model with derived pricing. */
  let apiPlans = [];
  let planByCode = new Map();

  function buildPlanViews(plans) {
    // The monthly-equivalent plan (billed every 1 month) is the baseline the
    // "save $X vs. paying monthly" figure is measured against.
    const base = plans.find(p => p.intervalUnit === 'month' && p.intervalCount === 1);
    const baseMonthly = base ? base.price : null;
    const map = new Map();
    for (const p of plans) {
      const months = monthsEquivalent(p.intervalUnit, p.intervalCount) || 1;
      const perMonth = p.price / months;
      const saves = baseMonthly != null
        ? Math.max(0, Math.round((baseMonthly * months - p.price) * 100) / 100)
        : 0;
      map.set(p.code, { ...p, total: p.price, months, perMonth, saves });
    }
    return map;
  }

  /* The introductory rate is a PROMOTION, not a selectable plan record, so it
     is not in the public feed. Its view is derived from the live promotion
     (spotsState) with the standard Monthly price as the "then $X/mo" rate. */
  function introView() {
    const after = planByCode.get('Monthly')?.total ?? null;
    const price = spotsState.priceDollars ?? CONFIG.intro.price;
    return {
      code: 'Introductory', name: CONFIG.intro.label,
      total: price, months: 1, perMonth: price, saves: 0,
      termMonths: CONFIG.intro.termMonths, after, isIntro: true,
    };
  }

  /* Resolve a signup radio value (a plan code) to its pricing view. Community-
     Wide Pricing is a custom quote with no view, so this returns null. */
  function viewForPlan(code) {
    if (code === 'Introductory') return introView();
    return planByCode.get(code) || null;
  }

  const scheduleDays = () => {
    const d = CONFIG.schedule.days;
    if (d.length === 0) return 'a scheduled day';
    if (d.length === 1) return d[0];
    return d.slice(0, -1).join(', ') + ' and ' + d[d.length - 1];
  };
  const scheduleSentence = () =>
    `Standard pickup is ${scheduleDays()}. ${CONFIG.schedule.varianceNote}`;

  // Short form for headings: "Tuesday & Thursday", "Mon, Wed & Fri"
  const scheduleDaysShort = () => {
    const d = CONFIG.schedule.days;
    if (d.length <= 2) return d.join(' & ');
    return d.slice(0, -1).join(', ') + ' & ' + d[d.length - 1];
  };

  /* ============================================================
     3. Backend (demo payments only)

     Every call goes through api(). The checkout endpoint never accepts or
     stores card data - it takes a simulated `outcome` instead, so there is
     no real vs. demo mode to fall back between.
     ============================================================ */

  const isLocalDev = ['localhost', '127.0.0.1'].includes(location.hostname)
    && location.port !== new URL(CONFIG.api.localDevUrl).port;
  const API = (isLocalDev ? CONFIG.api.localDevUrl : CONFIG.api.baseUrl).replace(/\/$/, '');

  async function api(path, options = {}) {
    const res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.code = data.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function fetchIntroSpots() {
    if (CONFIG.api.enabled) {
      try { return await api('/api/intro-spots'); }
      catch (err) { console.warn('[Dash] spot count unavailable.', err.message); }
    }
    // No real count to show. Inventing one (a scarcity number) would show
    // a visitor a fabricated figure, so this reports "unknown" instead and
    // renderSpots() hides the spots-remaining text rather than guessing.
    return { claimed: null };
  }

  async function checkServiceArea(zip) {
    if (CONFIG.api.enabled) {
      try { return await api(`/api/service-area?zip=${encodeURIComponent(zip)}`); }
      catch (err) { console.warn('[Dash] area check failed', err.message); }
    }
    return { available: CONFIG.serviceArea.zips.includes(String(zip).trim()) };
  }

  // The customer-visible plans, straight from the backend (the same records
  // Admin manages). Returns [] if the API is unavailable so the page can show a
  // clear message rather than fabricate prices.
  async function fetchPublicPlans() {
    if (CONFIG.api.enabled) {
      try {
        const { plans } = await api('/api/subscription-plans/public');
        return Array.isArray(plans) ? plans : [];
      } catch (err) {
        console.warn('[Dash] plans unavailable.', err.message);
      }
    }
    return [];
  }

  function showPaymentError(message) {
    const el = $('[data-payment-error]');
    if (!el) return;
    el.textContent = message || '';
    el.hidden = !message;
  }

  /* ============================================================
     4. Render from config
     ============================================================ */
  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function renderSchedule() {
    $$('[data-schedule-days]').forEach(el => { el.textContent = scheduleDaysShort(); });
    $$('[data-schedule-days-inline]').forEach(el => { el.textContent = scheduleDays(); });
    $$('[data-schedule-short]').forEach(el => {
      el.textContent = `${CONFIG.schedule.perWeek} pickups weekly. Days vary by community.`;
    });
    $$('[data-schedule-note-long]').forEach(el => { el.textContent = scheduleSentence(); });
    $$('[data-schedule-faq]').forEach(el => {
      el.textContent = `${scheduleSentence()} Your exact collection window is confirmed at signup.`;
    });
    const note = $('[data-schedule-note]');
    if (note) note.textContent = scheduleSentence();
  }

  /* Render the public pricing cards from the backend plan feed. Name, price,
     billing frequency, description, label, and order are all data — nothing
     about the offering is hard-coded here. Keeps the existing card design. */
  function renderPlanCards() {
    const grid = $('[data-plan-grid]');
    if (!grid) return;
    if (!apiPlans.length) {
      grid.innerHTML = '<p class="plan-grid-status">Plans are unavailable right now. '
        + 'Please refresh, or contact us to get started.</p>';
      return;
    }
    grid.innerHTML = apiPlans.map(p => planCardHTML(planByCode.get(p.code))).join('');
  }

  function billingBullet(v) {
    if (v.intervalUnit === 'month' && v.intervalCount === 1) return 'Monthly recurring billing';
    if (v.intervalUnit === 'year' && v.intervalCount === 1) return 'Single annual payment';
    return `One payment ${v.frequency}`;
  }

  function planCardHTML(v) {
    const featured = v.label ? ' featured' : '';
    const badge = v.label ? `<div class="popular">${esc(v.label)}</div>` : '';
    const term = v.description || `Billed ${v.frequency}`;
    const priceNote = v.months <= 1
      ? 'Billed monthly'
      : `${money(v.perMonth)}/mo effective · save ${money(v.saves)}`;
    const bullets = [
      `${CONFIG.schedule.perWeek} pickups per week`,
      'Doorstep trash collection',
      billingBullet(v),
      v.saves > 0 ? `${money(v.saves)} off vs. paying monthly` : 'Cancel or change anytime',
    ];
    const btnClass = v.label ? 'btn btn-primary' : 'btn btn-outline';
    return `<article class="plan${featured}">
      ${badge}
      <h3>${esc(v.name)}</h3>
      <div class="term">${esc(term)}</div>
      <div class="price">${money(v.total)} <small>${esc(v.perLabel)}</small></div>
      <div class="price-sub">${esc(priceNote)}</div>
      <ul>${bullets.map(b => `<li>${esc(b)}</li>`).join('')}</ul>
      <button class="${btnClass} choose-plan" data-plan="${esc(v.code)}">Choose ${esc(v.name)}</button>
    </article>`;
  }

  /* Render the standard-plan radios in the signup wizard from the same feed.
     The Introductory (a promotion) and Community-wide (a custom quote) options
     are static in the HTML; only the real plans are data-driven here. */
  function renderSignupOptions() {
    const host = $('[data-standard-plans]');
    if (!host) return;
    host.innerHTML = apiPlans.map(p => {
      const v = planByCode.get(p.code);
      return `<label class="plan-option">
        <input type="radio" name="plan" value="${esc(v.code)}" hidden />
        <span class="plan-option-body">
          <span class="plan-option-name">${esc(v.name)}</span>
          <span class="plan-option-price">${money(v.total)} ${esc(v.perLabel)}</span>
        </span>
      </label>`;
    }).join('');
  }

  /* Fill every introductory-offer and plan-term hook. The intro price and spot
     total follow the live promotion; the "then $X/mo" reversion rate is the
     standard Monthly plan's price, so even the promotion's fine print tracks
     the same database everything else reads from. */
  function renderIntroCopy() {
    const intro = introView();
    const introPrice = intro.total;

    const introOpt = $('[data-option-price="intro"]');
    if (introOpt) {
      introOpt.textContent = intro.after != null
        ? `${money(introPrice)}/mo for ${intro.termMonths} mo, then ${money(intro.after)}/mo`
        : `${money(introPrice)}/mo for ${intro.termMonths} mo`;
    }

    $$('[data-intro-price]').forEach(el => { el.textContent = money(introPrice); });
    $$('[data-intro-total]').forEach(el => { el.textContent = String(spotsState.totalSpots ?? CONFIG.intro.totalSpots); });
    $$('[data-intro-term]').forEach(el => { el.textContent = String(CONFIG.intro.termMonths); });
    if (intro.after != null) $$('[data-intro-after]').forEach(el => { el.textContent = money(intro.after); });
  }

  let spotsState = {
    claimed: 0, remaining: CONFIG.intro.totalSpots, soldOut: false,
    totalSpots: null, priceDollars: null,
  };

  async function renderSpots() {
    const data = await fetchIntroSpots();
    const claimed = data.claimed;
    const unavailable = claimed == null;
    // totalSpots and priceDollars come from the live promotion; CONFIG's
    // numbers are only the offline fallback for when the API can't be
    // reached, never a substitute for a real API answer.
    const totalSpots = typeof data.totalSpots === 'number' ? data.totalSpots : CONFIG.intro.totalSpots;
    const remaining = unavailable ? null : Math.max(totalSpots - claimed, 0);
    // The server is the sole authority on whether the offer is open - it
    // already accounts for limit reached, expired, scheduled, and disabled
    // promotions. The client never re-derives that judgement; any status
    // other than 'active' closes the offer, known or not yet enumerated.
    const closed = !unavailable && data.status != null && data.status !== 'active';
    // Unknown is not the same as closed - without a real count/status,
    // assume the offer is still open rather than hiding it on a guess;
    // checkout itself is still the authority on whether a spot is granted.
    spotsState = {
      claimed, remaining, totalSpots,
      priceDollars: typeof data.priceDollars === 'number' ? data.priceDollars : null,
      soldOut: closed || (!unavailable && remaining === 0),
    };

    // The intro price/total shown in the offer must track this same live
    // data, so refresh the intro copy now that it's known.
    renderIntroCopy();

    $$('[data-spots-remaining]').forEach(el => {
      el.hidden = unavailable;
      if (!unavailable) {
        el.textContent = spotsState.soldOut
          ? 'The introductory offer has reached its limit.'
          : `${remaining} introductory spots remaining.`;
      }
    });

    const block = $('[data-intro-block]');
    if (block) block.hidden = !(CONFIG.intro.enabled && !spotsState.soldOut);

    const introOption = $('[data-plan-intro]');
    if (introOption) {
      const label = introOption.closest('.plan-option');
      if (label) label.hidden = !(CONFIG.intro.enabled && !spotsState.soldOut);
    }
    return spotsState;
  }

  /* ============================================================
     5. Introductory offer modal
     ============================================================ */
  const promo = $('[data-promo]');
  let lastFocus = null;

  function openPromo() {
    if (!promo) return;
    lastFocus = document.activeElement;
    promo.hidden = false;
    document.body.style.overflow = 'hidden';
    const close = $('[data-promo-close]', promo);
    if (close) close.focus();
    document.addEventListener('keydown', onPromoKey);
  }

  function closePromo(remember = true) {
    if (!promo || promo.hidden) return;
    promo.hidden = true;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onPromoKey);
    if (remember) {
      try { localStorage.setItem('dtp_promo_dismissed', String(Date.now())); } catch (e) {}
    }
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function onPromoKey(e) {
    if (e.key === 'Escape') closePromo();
    if (e.key !== 'Tab') return;
    // keep focus inside the dialog while it is open
    const f = $$('button, [href], input, select, textarea', promo)
      .filter(el => !el.disabled && el.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function shouldShowPromo() {
    if (!CONFIG.intro.enabled || spotsState.soldOut) return false;

    /* ?offer=1 forces the popup even after it has been dismissed, so the
       offer can be demoed or tested without clearing browser storage.
       ?offer=0 suppresses it. */
    const forced = new URLSearchParams(location.search).get('offer');
    if (forced === '1' || forced === 'true') return true;
    if (forced === '0' || forced === 'false') return false;

    try {
      const at = Number(localStorage.getItem('dtp_promo_dismissed') || 0);
      if (!at) return true;
      const days = (Date.now() - at) / 86400000;
      return days >= CONFIG.intro.remindAfterDays;
    } catch (e) { return true; }
  }

  if (promo) {
    $$('[data-promo-close]', promo).forEach(b => b.addEventListener('click', () => closePromo()));
    promo.addEventListener('click', (e) => { if (e.target === promo) closePromo(); });
  }

  /* ============================================================
     6. Signup flow
     ============================================================ */
  const form = $('#signupForm');
  const LAST_STEP = 6;
  let step = 1;

  function showStep(n) {
    step = n;
    $$('[data-step]', form).forEach(p => { p.hidden = Number(p.dataset.step) !== n; });
    $$('[data-step-dot]').forEach(d => {
      const i = Number(d.dataset.stepDot);
      d.classList.toggle('is-current', i === n);
      d.classList.toggle('is-done', i < n);
    });
    const back = $('[data-step-back]'), next = $('[data-step-next]');
    back.hidden = n === 1 || n === LAST_STEP;
    next.hidden = n === LAST_STEP;
    next.textContent = n === 4 ? 'Continue to payment →'
                     : n === 5 ? 'Complete signup'
                     : 'Continue →';
    $('[data-form-actions]').hidden = n === LAST_STEP;
  }

  function values() {
    const fd = new FormData(form);
    const o = {};
    for (const [k, v] of fd.entries()) o[k] = typeof v === 'string' ? v.trim() : v;
    return o;
  }

  function showError(key, show) {
    const el = $(`[data-error-for="${key}"]`);
    if (el) el.hidden = !show;
  }

  function validateStep(n) {
    const v = values();
    if (n === 1) {
      const ok = Boolean(v.plan);
      showError('plan', !ok);
      return ok;
    }
    if (n === 2) {
      const ok = ['firstName','lastName','email','phone'].every(k => v[k]) &&
                 /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email || '');
      showError('step2', !ok);
      return ok;
    }
    if (n === 3) {
      const ok = ['community','street','unit','zip','startDate'].every(k => v[k]) &&
                 /^\d{5}$/.test(v.zip || '');
      showError('step3', !ok);
      return ok;
    }
    return true;
  }

  async function renderAvailability() {
    const v = values();
    const statusEl = $('[data-availability-status]');
    const detail = $('[data-availability-detail]');
    statusEl.textContent = 'Checking your community…';
    statusEl.className = 'availability-status';
    detail.hidden = true;

    const { available } = await checkServiceArea(v.zip);
    const p = viewForPlan(v.plan);

    $('[data-review="community"]').textContent = v.community || '—';
    $('[data-review="address"]').textContent =
      [v.street, v.unit, v.zip].filter(Boolean).join(', ') || '—';
    $('[data-review="plan"]').textContent = p
      ? `${p.name} — ${money(p.total)}`
      : (v.plan || '—');
    $('[data-review="startDate"]').textContent = v.startDate || '—';

    statusEl.textContent = available
      ? `Good news — we service ${CONFIG.serviceArea.city} ZIP ${v.zip}.`
      : `We don't service ZIP ${v.zip} yet. Continue and we'll contact you when we expand.`;
    statusEl.classList.add(available ? 'is-ok' : 'is-warn');
    detail.hidden = false;
  }

  function renderPaymentStep() {
    const v = values();
    const p = viewForPlan(v.plan);
    const months = p ? Math.round(p.months) : 0;
    $('[data-review="total"]').textContent = p ? money(p.total) : 'Custom quote';
    $('[data-review="planSummary"]').textContent = p
      ? `${p.name} plan · ${months <= 1 ? 'billed monthly' : `covers ${months} months`} · ${CONFIG.schedule.perWeek} pickups per week`
      : 'A team member will contact you with community-wide pricing.';

    // Say plainly that this recurs - a subscription should never be a surprise.
    const renewal = $('[data-review="renewal"]');
    if (renewal) {
      const period = p && months <= 1 ? 'month' : p ? `${months} months` : null;
      // The introductory plan is a TERM, so "at $18 until you cancel" would be
      // a lie on the one screen where the customer is about to be charged.
      renewal.textContent = !p ? ''
        : p.isIntro
          ? `Renews automatically every month at ${money(p.total)} for ${p.termMonths} months, `
            + (p.after != null ? `then ${money(p.after)} per month until you cancel. ` : 'until you cancel. ')
            + 'Cancel anytime.'
          : `Renews automatically every ${period} at ${money(p.total)} until you cancel. Cancel anytime.`;
    }

    showPaymentError('');
  }

  async function completeSignup() {
    const v = values();
    const next = $('[data-step-next]');
    next.disabled = true;
    next.textContent = 'Submitting…';
    showPaymentError('');

    // No card data is ever collected - the visitor picks which result to
    // simulate, and that choice is all the server needs from this step.
    const outcome = document.querySelector('input[name="outcome"]:checked')?.value || 'success';

    let res;
    try {
      res = await api('/api/checkout', {
        method: 'POST',
        body: JSON.stringify({ ...v, outcome }),
      });
    } catch (err) {
      next.disabled = false;
      next.textContent = 'Complete signup';
      showPaymentError(err.message);

      // The introductory offer ran out while they were filling the form.
      if (err.code === 'INTRO_SOLD_OUT') {
        await renderSpots();
        selectPlan('Monthly');
        showStep(1);
      }
      return;
    }

    next.disabled = false;

    // A pending charge is not a failure - the server hands back a 202 with
    // status: 'pending' rather than an error, and the subscription kept
    // whatever terms it was quoted. Show it as informational on the
    // confirmation step, not as a red error.
    const pending = res && res.status === 'pending';
    if (!res || (!res.ok && !pending)) {
      next.textContent = 'Complete signup';
      showPaymentError(res?.error || res?.message || 'Something went wrong. Please try again.');
      return;
    }

    await renderSpots();

    // THE SERVER DECIDES, NOT THE CLIENT: what the customer actually paid
    // (and whether the promotion applied) is whatever the server charged,
    // never a guess derived from the plan the customer merely asked for -
    // a visitor arriving after the 100th spot is billed the standard rate
    // even though they picked "Introductory".
    const introApplied = Boolean(res.introApplied);

    $('[data-confirm-heading]').textContent = introApplied
      ? 'Your introductory rate is locked in'
      : 'Service request received';
    const badge = $('[data-confirm-badge]');
    if (badge) badge.hidden = !res.demo;
    $('[data-confirm-body]').textContent = introApplied
      // The spot count follows the live promotion, never CONFIG - the admin
      // can change the limit, and the confirmation must not quote a stale one.
      ? `Confirmation ${res.confirmationId}. You're one of the first ${spotsState.totalSpots ?? CONFIG.intro.totalSpots} customers at ${money(res.amountCents / 100)}/month. Standard pickup is ${scheduleDays()}.`
      : `Confirmation ${res.confirmationId}. We'll email ${v.email || 'you'} with your pickup schedule. Standard pickup is ${scheduleDays()}.`;
    const pendingNote = $('[data-confirm-pending]');
    if (pendingNote) pendingNote.hidden = !pending;

    showStep(LAST_STEP);
  }

  if (form) {
    form.addEventListener('submit', (e) => e.preventDefault());

    // Delegated: the standard plan options are rendered dynamically, so bind
    // once on the form rather than per-input.
    form.addEventListener('change', (e) => {
      if (!e.target.matches('input[name="plan"]')) return;
      $$('.plan-option').forEach(l => l.classList.toggle('is-selected', $('input', l)?.checked));
      showError('plan', false);
    });

    $('[data-step-next]').addEventListener('click', async () => {
      if (!validateStep(step)) return;
      if (step === 3) { showStep(4); await renderAvailability(); return; }
      if (step === 4) { renderPaymentStep(); showStep(5); return; }
      if (step === 5) { await completeSignup(); return; }
      showStep(Math.min(step + 1, LAST_STEP));
    });

    $('[data-step-back]').addEventListener('click', () => showStep(Math.max(step - 1, 1)));
    showStep(1);
  }

  function selectPlan(planValue) {
    const input = $$('.plan-option input').find(i => i.value === planValue);
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function goToSignup(planValue) {
    if (planValue) selectPlan(planValue);
    showStep(1);
    const target = $('#signup');
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // "Claim My Introductory Rate" - selects the plan, does NOT consume a spot
  $$('[data-claim-intro]').forEach(btn => {
    btn.addEventListener('click', () => {
      closePromo();
      goToSignup('Introductory');
    });
  });

  // Pricing-card buttons (delegated: the cards are rendered dynamically).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.choose-plan');
    if (btn) goToSignup(btn.dataset.plan);
  });

  /* ============================================================
     7a. Portal menu
     ============================================================ */
  const portalTrigger = $('[data-portal-trigger]');
  const portalDropdown = $('[data-portal-dropdown]');
  if (portalTrigger && portalDropdown) {
    const setPortal = (open) => {
      portalDropdown.hidden = !open;
      portalTrigger.setAttribute('aria-expanded', String(open));
    };
    portalTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      setPortal(portalDropdown.hidden);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('[data-portal-menu]')) setPortal(false);
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setPortal(false); });
  }

  /* ============================================================
     7. Mobile navigation toggle
     ============================================================ */
  const menuBtn = document.getElementById('menuBtn');
  const navLinks = document.getElementById('navLinks');
  const setMenu = (open) => {
    navLinks.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    menuBtn.textContent = open ? '✕' : '☰';
  };
  menuBtn?.addEventListener('click', () => setMenu(!navLinks.classList.contains('open')));
  navLinks?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => setMenu(false)));

  /* ============================================================
     8. Footer year
     ============================================================ */
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  /* ---------- boot ---------- */
  renderSchedule();
  (async () => {
    // Plans are the source of truth, so load them first, then render every
    // surface that depends on them: the pricing cards, the signup options, and
    // the introductory offer's fine print (its reversion rate is the Monthly
    // plan's price).
    apiPlans = await fetchPublicPlans();
    planByCode = buildPlanViews(apiPlans);
    renderPlanCards();
    renderSignupOptions();
    renderIntroCopy();
    await renderSpots();   // refreshes intro copy once live spot data is known
    if (shouldShowPromo()) setTimeout(openPromo, CONFIG.intro.popupDelayMs);
  })();
})();
