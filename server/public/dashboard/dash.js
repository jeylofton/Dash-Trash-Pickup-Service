/* Shared dashboard helpers. */

const WRONG_SERVER =
  'This page is being served by a plain static file server, which cannot ' +
  'handle sign-in. Open the dashboard through the application server (the ' +
  'same origin that serves the API) — it serves the site and the API together.';

export async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
  } catch {
    // fetch itself failed: no server at this origin at all
    throw new Error('Cannot reach the server. Is it running? ' + WRONG_SERVER);
  }

  // 405/501 on an /api/ path means a static file server answered, not ours.
  if (res.status === 405 || res.status === 501) throw new Error(WRONG_SERVER);

  if (res.status === 401) { location.href = '/dashboard/login.html'; throw new Error('Signed out'); }

  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch {
    // HTML came back where JSON was expected - again, the wrong server.
    if (text.trimStart().startsWith('<')) throw new Error(WRONG_SERVER);
  }

  if (!res.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`),
                        { status: res.status, code: data.code });
  }
  return data;
}

export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Escape anything that came from the database before it touches innerHTML. */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

export const money = (n) => n == null ? '—' : '$' + Number(n).toFixed(2).replace(/\.00$/, '');

export const fmtDate = (d) => d ? new Date(`${String(d).slice(0,10)}T12:00:00`)
  .toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }) : '—';

export const fmtTime = (ts) => ts ? new Date(ts.replace(' ', 'T') + 'Z')
  .toLocaleTimeString(undefined, { hour:'numeric', minute:'2-digit' }) : '';

export const ISSUE_LABELS = {
  no_trash_outside:'No trash outside', unable_to_access:'Unable to access property',
  not_properly_bagged:'Trash improperly bagged', oversized_item:'Oversized item',
  restricted_item:'Restricted item', customer_not_home:'Customer not home',
  incorrect_address:'Incorrect address', blocked_access:'Blocked access',
  animal_safety:'Animal / safety issue', property_issue:'Property issue',
  service_problem:'Service problem', customer_not_found:'Customer not found',
  other:'Other problem',
};

export function statusPill(status) {
  const map = { paid:'ok', completed:'ok', active:'ok',
                pending:'pending', past_due:'warn', issue:'bad', failed:'bad',
                cancelled:'bad', deactivated:'bad', paused:'warn' };
  return `<span class="pill ${map[status] || ''}">${esc(String(status).replace('_',' '))}</span>`;
}

export async function mountShell(role) {
  const me = await api('/api/auth/me');
  if (me.role !== role) { location.href = `/dashboard/${me.role}/`; throw new Error('wrong role'); }
  const nameEl = $('[data-user-name]');
  if (nameEl) nameEl.textContent = `${me.firstName} ${me.lastName}`;
  $$('[data-logout]').forEach(b => b.addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    location.href = '/dashboard/login.html';
  }));
  return me;
}

/** Simple tab wiring: buttons with data-tab, panels with data-panel. */
export function wireTabs(onChange) {
  const buttons = $$('[data-tab]');
  const show = (name) => {
    buttons.forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== name; });
    if (onChange) onChange(name);
  };
  buttons.forEach(b => b.addEventListener('click', () => show(b.dataset.tab)));
  show(buttons[0]?.dataset.tab);
  return show;
}

/**
 * Dropdown behaviour for grouped nav items (.nav-group).
 * Purely presentational: opens/closes the submenu, one at a time.
 * Desktop also reveals on hover via CSS; this adds click/tap + close.
 */
export function wireNavGroups(root = document) {
  const groups = $$('.nav-group', root);
  const nav = $('.tabs', root);
  const toggle = $('.nav-toggle', root);
  if (!groups.length && !toggle) return;

  const closeAll = (except) => groups.forEach(g => {
    if (g === except) return;
    g.classList.remove('open');
    g.querySelector('.nav-group-trigger')?.setAttribute('aria-expanded', 'false');
  });

  groups.forEach(group => {
    const trigger = group.querySelector('.nav-group-trigger');
    trigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = !group.classList.contains('open');
      closeAll(group);
      group.classList.toggle('open', willOpen);
      trigger.setAttribute('aria-expanded', String(willOpen));
    });
    /* Choosing a page inside the menu closes the dropdown. */
    group.querySelectorAll('.nav-group-menu [data-tab]').forEach(item =>
      item.addEventListener('click', () => closeAll()));
  });

  /* Clicking away, or pressing Escape, collapses any open menu. */
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.nav-group')) closeAll();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAll(); });

  /* Mobile hamburger: the whole bar collapses to a single row that shows the
     current section; tapping it drops the full list of options down. */
  if (toggle && nav) {
    const label = toggle.querySelector('.nav-toggle-label');
    const collapse = () => {
      nav.classList.remove('nav-open');
      toggle.setAttribute('aria-expanded', 'false');
      closeAll();
    };
    /* Keep the collapsed label in step with whichever page is selected —
       the parent section name for grouped pages, else the tab's own name. */
    const syncLabel = () => {
      if (!label) return;
      const sel = $$('[data-tab]', nav).find(b => b.getAttribute('aria-selected') === 'true');
      if (!sel) return;
      const grp = sel.closest('.nav-group');
      label.textContent = grp
        ? grp.querySelector('.nav-group-trigger').textContent.trim().replace(/\s*▾\s*$/, '')
        : sel.textContent.trim();
    };

    toggle.addEventListener('click', () => {
      const open = !nav.classList.contains('nav-open');
      nav.classList.toggle('nav-open', open);
      toggle.setAttribute('aria-expanded', String(open));
      if (!open) closeAll();
    });
    /* Picking any page collapses the menu back to the compact bar. */
    $$('[data-tab]', nav).forEach(b => {
      b.addEventListener('click', collapse);
      new MutationObserver(syncLabel).observe(b, { attributes:true, attributeFilter:['aria-selected'] });
    });
    syncLabel();
  }
}

/* ============================================================
   Form guarding: Cancel restores, and leaving warns.
   ============================================================ */

const guards = new Set();

/**
 * Watch a form area for unsaved changes.
 *
 *   const g = guardForm('#editCard', { onCancel: () => hide() });
 *   g.snapshot()  — call after a successful save (this is now "clean")
 *   g.isDirty()   — has anything changed since the snapshot?
 *   g.restore()   — put every field back to the snapshot
 *
 * Cancel restores rather than merely closing, so reopening the form
 * never shows the abandoned edits.
 */
export function guardForm(root, { onCancel } = {}) {
  const el = typeof root === 'string' ? $(root) : root;
  if (!el) return { snapshot() {}, isDirty: () => false, restore() {}, release() {} };

  const fields = () => $$('input, select, textarea', el);
  let saved = new Map();

  const snapshot = () => {
    saved = new Map();
    for (const f of fields()) {
      saved.set(f, f.type === 'checkbox' || f.type === 'radio' ? f.checked : f.value);
    }
  };

  const isDirty = () => {
    for (const f of fields()) {
      if (!saved.has(f)) continue;
      const now = f.type === 'checkbox' || f.type === 'radio' ? f.checked : f.value;
      if (now !== saved.get(f)) return true;
    }
    return false;
  };

  const restore = () => {
    for (const [f, v] of saved) {
      if (!f.isConnected) continue;
      if (f.type === 'checkbox' || f.type === 'radio') f.checked = v; else f.value = v;
      f.dispatchEvent(new Event('change', { bubbles: true }));
    }
  };

  const guard = { el, snapshot, isDirty, restore, release() { guards.delete(guard); } };
  snapshot();
  guards.add(guard);

  /* Convenience wiring for simple forms: a [data-cancel] button restores
     the snapshot. Screens that also have to close a panel and clear a
     selection wire their own Cancel and leave this attribute off. */
  $$('[data-cancel]', el).forEach(b => b.addEventListener('click', async () => {
    if (isDirty() && !(await confirmDiscard())) return;
    restore();
    snapshot();
    onCancel?.();
  }));

  return guard;
}

/** True if any watched form has unsaved changes. */
export const anyDirty = () => [...guards].some(g => g.el.isConnected && g.isDirty());

/** Ask before an action that would throw away unsaved work. */
export function confirmLeave(message = 'You have unsaved changes. Leave without saving?') {
  return !anyDirty() || confirm(message);
}

// The browser's own guard for closing the tab or navigating away.
window.addEventListener('beforeunload', (e) => {
  if (!anyDirty()) return;
  e.preventDefault();
  e.returnValue = '';           // required for Chrome to show its prompt
});

/* ============================================================
   Delete vs Archive — the server decides which is offered.
   ============================================================ */

/**
 * Render a Delete button only when the server says the record has no
 * history. Otherwise render nothing and let Archive stand alone.
 */
export async function renderDeleteControl(mountSelector, {
  checkUrl, deleteUrl, label = 'record', onDeleted,
}) {
  const mount = typeof mountSelector === 'string' ? $(mountSelector) : mountSelector;
  if (!mount) return;

  let info;
  try { info = await api(checkUrl); }
  catch { mount.innerHTML = ''; return; }

  if (!info.deletable) {
    mount.innerHTML = `<p class="muted small delete-note">
      Cannot be permanently deleted — ${esc(info.reason)} Archive it instead.</p>`;
    return;
  }

  mount.innerHTML = `
    <div class="danger-zone">
      <strong>Permanently delete</strong>
      <p class="small">${esc(info.reason)}</p>
      <button class="btn btn-danger" data-do-delete>Delete permanently</button>
    </div>`;

  $('[data-do-delete]', mount).addEventListener('click', async () => {
    const name = info.name || label;
    if (!confirm(
      `DELETE ${label.toUpperCase()}?\n\n${name}\n\n` +
      `This record has never been used and will be permanently removed.\n` +
      `This action cannot be undone.`
    )) return;

    try {
      const res = await api(deleteUrl, { method: 'DELETE' });
      alert(res.message || 'Deleted.');
      onDeleted?.();
    } catch (e) {
      // The server re-checks, so this fires if history appeared in between.
      alert(e.message + (e.suggestion ? `\n\n${e.suggestion}` : ''));
    }
  });
}

/* ============================================================
   Single-action lifecycle control.

   Current status → pick ONE valid action → fill in what it needs
   → confirm → done. Deliberately NOT a row of status buttons:
   with one control there is nothing to click by accident and no
   way to ask for two conflicting changes at once.

   The server owns the rules. This only draws what /actions
   returned, and the same rules are checked again on submit.
   ============================================================ */

const DAY_LABELS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

const TONE_CLASS = { primary: 'btn-primary', danger: 'btn-danger', warn: '', normal: '' };

/** One field of an action's form, described by the server. */
function fieldHtml(f) {
  const id = `lcf_${f.name}`;
  const req = f.required ? ' <span class="req">*</span>' : '';
  const hint = f.hint ? `<span class="small muted">${esc(f.hint)}</span>` : '';
  const label = `<label for="${id}">${esc(f.label)}${req}</label>`;

  if (f.type === 'days') {
    return `<div class="lc-field"><span class="lc-label">${esc(f.label)}${req}</span>
      <div class="lc-days">${DAY_LABELS.map((d, i) =>
        `<label class="lc-day"><input type="checkbox" name="${esc(f.name)}" value="${i}" /> ${d.slice(0,3)}</label>`
      ).join('')}</div>${hint}</div>`;
  }
  if (f.type === 'select') {
    return `<div class="lc-field">${label}
      <select id="${id}" data-field="${esc(f.name)}">
        <option value="">Choose…</option>
        ${(f.options || []).map(o =>
          `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}
      </select>${hint}</div>`;
  }
  if (f.type === 'textarea') {
    return `<div class="lc-field">${label}
      <textarea id="${id}" data-field="${esc(f.name)}" rows="3"></textarea>${hint}</div>`;
  }
  return `<div class="lc-field">${label}
    <input id="${id}" data-field="${esc(f.name)}" type="${f.type === 'date' ? 'date' : 'text'}" />${hint}</div>`;
}

/** Read the filled-in form back out. */
function readFields(root, fields) {
  const values = {};
  for (const f of fields) {
    if (f.type === 'days') {
      values[f.name] = $$(`input[name="${f.name}"]:checked`, root).map(i => Number(i.value));
    } else {
      const el = $(`[data-field="${f.name}"]`, root);
      values[f.name] = el ? el.value.trim() : '';
    }
  }
  return values;
}

/** Human-readable echo of what is about to happen, for the confirm screen. */
function summarise(fields, values) {
  return fields.map(f => {
    let v = values[f.name];
    if (Array.isArray(v)) v = v.map(d => DAY_LABELS[d]).join(', ');
    if (f.type === 'select') v = f.options?.find(o => String(o.value) === String(v))?.label ?? v;
    if (f.type === 'date' && v) v = fmtDate(v);
    if (!v) return '';
    return `<div class="lc-sum"><span>${esc(f.label)}</span><strong>${esc(v)}</strong></div>`;
  }).join('');
}

/**
 * Mount the control.
 *
 *   lifecycleControl('#zone', {
 *     actionsUrl: `/api/communities/${id}/actions`,
 *     submitUrl:  `/api/communities/${id}/lifecycle`,
 *     label: 'community', onDone: reload,
 *   })
 */
export async function lifecycleControl(mountSelector, {
  actionsUrl, submitUrl, label = 'record', onDone, autoOpen = false,
}) {
  const mount = typeof mountSelector === 'string' ? $(mountSelector) : mountSelector;
  if (!mount) return;

  let data;
  try { data = await api(actionsUrl); }
  catch (e) {
    mount.innerHTML = `<p class="msg error">${esc(e.message)}</p>`;
    return;
  }

  const name = data.community?.name ?? data.name ?? label;
  const deletion = data.deletion;

  /* Permanent deletion sits in the same single-select list, but only when
     the server confirms the record has never been used. Anything with
     history is offered Archive instead — never a delete it cannot honour. */
  const choices = [
    ...data.actions,
    ...(deletion?.deletable ? [{
      key: '__delete__', label: 'Delete Permanently', tone: 'danger', enabled: true,
      description: deletion.reason, fields: [],
      confirmTitle: `Permanently delete ${name}?`,
      effects: ['The record is removed for good. This cannot be undone.'],
    }] : []),
  ];

  const render = (step, state = {}) => {
    if (step === 'choose') {
      mount.innerHTML = `
        <div class="lifecycle">
          <div class="lc-head">
            <div><span class="lc-now">Current status</span>
              <span class="pill ${esc(data.status.tone)}">${esc(data.status.label)}</span></div>
            <p class="small muted">${esc(data.status.description || '')}</p>
          </div>
          ${choices.length ? `
            <fieldset class="lc-choices">
              <legend>Select one action</legend>
              ${choices.map(a => `
                <label class="lc-choice ${a.enabled ? '' : 'is-disabled'} ${a.tone === 'danger' ? 'is-danger' : ''}">
                  <input type="radio" name="lcAction" value="${esc(a.key)}" ${a.enabled ? '' : 'disabled'} />
                  <span><strong>${esc(a.label)}</strong>
                    <span class="small muted">${esc(a.description || '')}</span>
                    ${a.enabled ? '' :
                      `<span class="small bad-text">${esc(a.blockedReason || 'Not available yet.')}</span>`}
                  </span>
                </label>`).join('')}
            </fieldset>
            <button class="btn btn-primary" data-lc-continue disabled>Continue</button>
            <button class="btn" data-lc-close>Close</button>
            <p class="small muted">One action is processed at a time.</p>`
          : `<p class="muted small">No status change is available for this ${esc(label)}.</p>
             <button class="btn" data-lc-close>Close</button>`}
        </div>`;

      const cont = $('[data-lc-continue]', mount);
      $$('input[name="lcAction"]', mount).forEach(r =>
        r.addEventListener('change', () => { cont.disabled = false; }));
      cont?.addEventListener('click', () => {
        const picked = $('input[name="lcAction"]:checked', mount);
        if (!picked) return;
        const action = choices.find(a => a.key === picked.value);
        render(action.fields.length ? 'details' : 'confirm', { action, values: {} });
      });
    }

    if (step === 'details') {
      const { action } = state;
      mount.innerHTML = `
        <div class="lifecycle">
          <h3>${esc(action.label)}</h3>
          <p class="small muted">${esc(action.description || '')}</p>
          <div class="lc-form">${action.fields.map(fieldHtml).join('')}</div>
          <p class="msg error" data-lc-err hidden></p>
          <button class="btn btn-primary" data-lc-review>Continue</button>
          <button class="btn" data-lc-back>Go back</button>
        </div>`;
      // A sensible default beats an empty date box that must be guessed at.
      const firstDate = $('input[type="date"]', mount);
      if (firstDate) firstDate.value = new Date().toISOString().slice(0, 10);

      $('[data-lc-back]', mount).addEventListener('click', () => render('choose'));
      $('[data-lc-review]', mount).addEventListener('click', () => {
        const values = readFields(mount, action.fields);
        const missing = action.fields.find(f => f.required &&
          (Array.isArray(values[f.name]) ? !values[f.name].length : !values[f.name]));
        if (missing) {
          const err = $('[data-lc-err]', mount);
          err.textContent = `${missing.label} is required.`; err.hidden = false;
          return;
        }
        render('confirm', { action, values });
      });
    }

    if (step === 'confirm') {
      const { action, values = {} } = state;
      mount.innerHTML = `
        <div class="lifecycle lc-confirm ${action.tone === 'danger' ? 'is-danger' : ''}">
          <h3>${esc(action.confirmTitle || `${action.label}?`)}</h3>
          ${summarise(action.fields, values)}
          ${action.effects?.length ? `<ul class="lc-effects">${
            action.effects.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
          ${action.preserves?.length ? `
            <div class="lc-keeps"><strong>Nothing below is deleted or changed:</strong>
              <ul>${action.preserves.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
          ${action.key === '__delete__' ? `
            <div class="lc-field"><label for="lcConfirmName">Type the name to confirm</label>
              <input id="lcConfirmName" placeholder="${esc(name)}" /></div>` : ''}
          <p class="msg error" data-lc-err hidden></p>
          <button class="btn ${TONE_CLASS[action.tone] || 'btn-primary'}" data-lc-go>
            ${action.key === '__delete__' ? 'Delete permanently' : `Confirm — ${esc(action.label)}`}</button>
          <button class="btn" data-lc-back>Go back</button>
        </div>`;

      $('[data-lc-back]', mount).addEventListener('click', () =>
        render(action.fields.length ? 'details' : 'choose', state));

      $('[data-lc-go]', mount).addEventListener('click', async (ev) => {
        const err = $('[data-lc-err]', mount);
        const btn = ev.currentTarget;
        err.hidden = true;

        if (action.key === '__delete__' && $('#lcConfirmName', mount).value.trim() !== name) {
          err.textContent = 'Type the name exactly to confirm deletion.'; err.hidden = false;
          return;
        }

        btn.disabled = true; btn.textContent = 'Working…';
        try {
          const res = action.key === '__delete__'
            ? await api(deletion.url, { method: 'DELETE' })
            : await api(submitUrl, { method: 'POST',
                body: JSON.stringify({ action: action.key, ...values }) });

          mount.innerHTML = `<div class="lifecycle"><p class="msg ok">${
            esc(res.message || 'Done.')}</p>${
            res.warning ? `<p class="msg error">${esc(res.warning)}</p>` : ''}</div>`;
          onDone?.(res, action.key);
        } catch (e) {
          btn.disabled = false; btn.textContent = 'Try again';
          err.innerHTML = esc(e.message) + (e.suggestion ? `<br />${esc(e.suggestion)}` : '');
          err.hidden = false;
        }
      });
    }
  };

  $$('[data-lc-close]', mount);
  mount.addEventListener('click', (e) => {
    if (e.target.matches('[data-lc-close]')) { mount.innerHTML = ''; onDone?.(null, 'closed'); }
  });

  render('choose');
  if (!autoOpen) mount.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ============================================================
   Page state: list → select → view/edit → save or cancel → list.

   Three things are kept deliberately separate:

     PERSISTED   what the server has. Only Save changes it.
     SELECTED    which record is on screen. Closing clears it.
     DRAFT       what is typed into a form. Cancel throws it away.

   Form fields are never bound to the persisted object, so an
   abandoned edit cannot leak into the rest of the app: the draft
   lives in the DOM inputs and dies with them.
   ============================================================ */

/** A floating confirmation with the two answers the situation actually has. */
export function confirmDiscard({
  title = 'You have unsaved changes.',
  body = 'If you leave now, your changes will not be saved.',
  keep = 'Keep Editing',
  discard = 'Discard Changes',
} = {}) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <div class="modal" role="alertdialog" aria-modal="true" aria-label="${esc(title)}">
        <h3>${esc(title)}</h3>
        <p class="small">${esc(body)}</p>
        <div class="modal-actions">
          <button class="btn btn-primary" data-keep>${esc(keep)}</button>
          <button class="btn btn-danger" data-discard>${esc(discard)}</button>
        </div>
      </div>`;
    const done = (answer) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(answer); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };

    back.addEventListener('click', (e) => {
      if (e.target.matches('[data-keep]') || e.target === back) done(false);
      if (e.target.matches('[data-discard]')) done(true);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    $('[data-keep]', back)?.focus();
  });
}

/** A brief success/error banner, for when the form that reported it has closed. */
export function toast(message, kind = 'ok') {
  let host = $('#toastHost');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toastHost';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 350); }, 4200);
}

/**
 * One management section's selection state.
 *
 *   const routes = createSection({ detail: '#routeDetail', list: '#routeListZone' });
 *   routes.select(id);            // remember what is open
 *   await routes.close();         // asks first if a tracked form is dirty
 *   routes.reset();               // hard clear, no questions (tab re-entry)
 *
 * `track(guard)` hands the section the guardForm for whatever edit form is
 * currently open, so the section knows whether a draft is in progress.
 */
export function createSection({ detail, list, onReset } = {}) {
  const el = () => (typeof detail === 'string' ? $(detail) : detail);
  const listEl = () => (list ? (typeof list === 'string' ? $(list) : list) : null);

  let selectedId = null;
  let guards = [];

  const isDirty = () => guards.some(g => g.el?.isConnected && g.isDirty());

  const clear = () => {
    const box = el();
    if (box) { box.hidden = true; box.innerHTML = ''; }
    const lst = listEl();
    if (lst) lst.hidden = false;
    guards.forEach(g => g.release?.());
    guards = [];
    selectedId = null;
    onReset?.();
  };

  return {
    get id() { return selectedId; },
    get isSelected() { return selectedId != null; },
    isDirty,

    /** Record what is open. Call from the show/render function. */
    select(id) {
      const next = id == null ? null : String(id);
      // A different record means the previous record's draft is gone.
      if (next !== selectedId) { guards.forEach(g => g.release?.()); guards = []; }
      selectedId = next;
    },

    /** Register the draft guard for the form that just rendered. */
    track(guard) { if (guard) guards.push(guard); return guard; },

    /**
     * Close the detail view and return to the list.
     * Returns false if the user chose to keep editing.
     */
    async close({ force = false } = {}) {
      if (!force && isDirty() && !(await confirmDiscard())) return false;
      clear();
      return true;
    },

    /** Hard reset with no prompt — leaving or re-entering the tab. */
    reset() { clear(); },

    /**
     * Guard opening a different record while a draft is in progress.
     * Returns false if the user chose to keep editing the current one.
     */
    async canSwitchTo(id) {
      if (String(id) === selectedId) return true;
      if (!isDirty()) return true;
      return confirmDiscard({
        body: 'Opening another record will discard the changes you have not saved.',
      });
    },
  };
}
