/* ============================================================
   Dash Trash Pickup - page behavior
   Doorstep valet trash collection | Columbus, Georgia

   Contents
     1. CONFIG  <-- change pricing, the intro offer, and the schedule HERE
     2. Derived pricing helpers
     3. Backend seams (swap these for real API calls)
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
      intro:     { total: CONFIG.intro.price, months: 1,  perMonth: CONFIG.intro.price, saves: 0 },
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
     3. Backend seams
     Replace the bodies of these three functions with real calls.
     Everything else on the page already reads from them.
     ============================================================ */

  // GET /api/intro-spots  ->  { claimed: number }
  async function fetchIntroSpots() {
    // DEMO ONLY. Counts completed signups stored in this browser.
    const local = Number(localStorage.getItem('dtp_demo_signups') || 0);
    const seeded = 27; // pretend 27 people already paid
    return { claimed: Math.min(seeded + local, CONFIG.intro.totalSpots) };
  }

  // POST /api/checkout  ->  { ok, confirmationId, introApplied }
  // A spot is consumed HERE - on completed payment - never on clicking the offer.
  async function submitSignup(data) {
    // DEMO ONLY. No payment is processed and no card data is collected.
    const spots = await fetchIntroSpots();
    const introApplied = data.plan === 'Introductory' && spots.claimed < CONFIG.intro.totalSpots;
    if (introApplied) {
      localStorage.setItem('dtp_demo_signups',
        String(Number(localStorage.getItem('dtp_demo_signups') || 0) + 1));
    }
    return {
      ok: true,
      confirmationId: 'DEMO-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
      introApplied,
    };
  }

  // GET /api/service-area?zip=  ->  { available: boolean }
  async function checkServiceArea(zip) {
    return { available: CONFIG.serviceArea.zips.includes(String(zip).trim()) };
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

    // plan picker labels inside the signup form
    $$('[data-option-price]').forEach(el => {
      const key = el.dataset.optionPrice;
      const p = PRICING[key];
      if (!p) return;
      const per = { intro: '/mo', monthly: '/mo', quarterly: '/qtr', annual: '/yr' }[key];
      el.textContent = money(p.total) + per;
    });

    $$('[data-intro-price]').forEach(el => { el.textContent = money(CONFIG.intro.price); });
    $$('[data-intro-total]').forEach(el => { el.textContent = String(CONFIG.intro.totalSpots); });
  }

  let spotsState = { claimed: 0, remaining: CONFIG.intro.totalSpots, soldOut: false };

  async function renderSpots() {
    const { claimed } = await fetchIntroSpots();
    const remaining = Math.max(CONFIG.intro.totalSpots - claimed, 0);
    spotsState = { claimed, remaining, soldOut: remaining === 0 };

    $$('[data-spots-remaining]').forEach(el => {
      el.textContent = remaining > 0
        ? `${remaining} introductory spots remaining.`
        : 'All introductory spots have been claimed.';
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
  }

  async function completeSignup() {
    const v = values();
    const next = $('[data-step-next]');
    next.disabled = true;
    next.textContent = 'Submitting…';

    const res = await submitSignup(v);

    next.disabled = false;
    if (!res.ok) { next.textContent = 'Complete signup'; return; }

    await renderSpots();

    $('[data-confirm-heading]').textContent = res.introApplied
      ? 'Your introductory rate is locked in'
      : 'Service request received';
    $('[data-confirm-body]').textContent = res.introApplied
      ? `Confirmation ${res.confirmationId}. You're one of the first ${CONFIG.intro.totalSpots} customers at ${money(CONFIG.intro.price)}/month. Standard pickup is ${scheduleDays()}.`
      : `Confirmation ${res.confirmationId}. We'll email ${v.email || 'you'} with your pickup schedule. Standard pickup is ${scheduleDays()}.`;

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
  renderSpots().then(() => {
    if (shouldShowPromo()) setTimeout(openPromo, CONFIG.intro.popupDelayMs);
  });
})();
