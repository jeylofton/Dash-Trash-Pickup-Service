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

    /* ---- Standard plans ----
       Quarterly and annual totals are CALCULATED from the monthly price
       minus the discount below, so you only ever edit these numbers. */
    pricing: {
      monthly: 28,          // <-- target range $25-$30
      quarterlyDiscount: 10,  // $ off the 3-month total
      annualDiscount: 60,     // $ off the 12-month total
      currency: '$',
    },

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
    return CONFIG.pricing.currency + str.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  };

  const PRICING = (() => {
    const { monthly, quarterlyDiscount, annualDiscount } = CONFIG.pricing;
    const quarterly = monthly * 3 - quarterlyDiscount;
    const annual = monthly * 12 - annualDiscount;
    return {
      intro:     { total: CONFIG.intro.price, months: 1,  perMonth: CONFIG.intro.price, saves: 0,
                   termMonths: CONFIG.intro.termMonths, after: monthly },
      monthly:   { total: monthly,   months: 1,  perMonth: monthly,       saves: 0 },
      quarterly: { total: quarterly, months: 3,  perMonth: quarterly / 3,  saves: quarterlyDiscount },
      annual:    { total: annual,    months: 12, perMonth: annual / 12,    saves: annualDiscount },
    };
  })();

  const PLAN_KEY = {
    'Introductory': 'intro',
    'Monthly': 'monthly',
    'Quarterly': 'quarterly',
    'Annual': 'annual',
  };

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

  function renderPricing() {
    const map = { monthly: 'monthly', quarterly: 'quarterly', annual: 'annual' };
    Object.entries(map).forEach(([attr, key]) => {
      const p = PRICING[key];
      $$(`[data-price="${attr}"]`).forEach(el => { el.textContent = money(p.total); });
      $$(`[data-priceNote="${attr}"]`).forEach(el => {
        el.textContent = p.months === 1
          ? 'Billed monthly'
          : `${money(p.perMonth)}/mo effective · save ${money(p.saves)}`;
      });
      $$(`[data-discount="${attr}"]`).forEach(el => {
        el.textContent = `${money(p.saves)} off vs. paying monthly`;
      });
    });

    // The advertised rate follows the live promotion (spotsState.priceDollars)
    // when the API has supplied one; CONFIG.intro.price is only the offline
    // fallback, never the source of truth once the server has spoken.
    const introPrice = spotsState.priceDollars ?? CONFIG.intro.price;

    // plan picker labels inside the signup form
    $$('[data-option-price]').forEach(el => {
      const key = el.dataset.optionPrice;
      const p = PRICING[key];
      if (!p) return;
      const per = { intro: '/mo', monthly: '/mo', quarterly: '/qtr', annual: '/yr' }[key];
      el.textContent = key === 'intro'
        ? `${money(introPrice)}/mo for ${p.termMonths} mo, then ${money(p.after)}/mo`
        : money(p.total) + per;
    });

    $$('[data-intro-price]').forEach(el => { el.textContent = money(introPrice); });
    $$('[data-intro-total]').forEach(el => { el.textContent = String(spotsState.totalSpots ?? CONFIG.intro.totalSpots); });

    /* The introductory rate is a TERM, not a permanent price. These two hooks
       disclose that everywhere the offer appears. Both read from CONFIG, so
       the page can never advertise a term the server is not actually billing. */
    $$('[data-intro-term]').forEach(el => { el.textContent = String(CONFIG.intro.termMonths); });
    $$('[data-intro-after]').forEach(el => { el.textContent = money(PRICING.intro.after); });
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

    // The intro price/total shown in the pricing cards must track this same
    // live data, so re-run that part of renderPricing now that it's known.
    renderPricing();

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
    const planKey = PLAN_KEY[v.plan];
    const p = PRICING[planKey];

    $('[data-review="community"]').textContent = v.community || '—';
    $('[data-review="address"]').textContent =
      [v.street, v.unit, v.zip].filter(Boolean).join(', ') || '—';
    $('[data-review="plan"]').textContent = p
      ? `${v.plan} — ${money(p.total)}`
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
    const planKey = PLAN_KEY[v.plan];
    const p = PRICING[planKey];
    $('[data-review="total"]').textContent = p ? money(p.total) : 'Custom quote';
    $('[data-review="planSummary"]').textContent = p
      ? `${v.plan} plan · ${p.months === 1 ? 'billed monthly' : `covers ${p.months} months`} · ${CONFIG.schedule.perWeek} pickups per week`
      : 'A team member will contact you with community-wide pricing.';

    // Say plainly that this recurs - a subscription should never be a surprise.
    const renewal = $('[data-review="renewal"]');
    if (renewal) {
      const period = p && p.months === 1 ? 'month' : p ? `${p.months} months` : null;
      // The introductory plan is a TERM, so "at $18 until you cancel" would be
      // a lie on the one screen where the customer is about to be charged.
      renewal.textContent = !p ? ''
        : planKey === 'intro'
          ? `Renews automatically every month at ${money(p.total)} for ${p.termMonths} months, `
            + `then ${money(p.after)} per month until you cancel. Cancel anytime.`
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

    $$('.plan-option input').forEach(input => {
      input.addEventListener('change', () => {
        $$('.plan-option').forEach(l => l.classList.toggle('is-selected', $('input', l).checked));
        showError('plan', false);
      });
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

  // Pricing-card buttons
  $$('.choose-plan').forEach(btn => {
    btn.addEventListener('click', () => goToSignup(btn.dataset.plan));
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
  renderPricing();
  (async () => {
    await renderSpots();
    if (shouldShowPromo()) setTimeout(openPromo, CONFIG.intro.popupDelayMs);
  })();
})();
