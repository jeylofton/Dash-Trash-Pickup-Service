/* Shared dashboard helpers. */

const WRONG_SERVER =
  'This page is being served by a static file server (VS Code Live Server, ' +
  'python -m http.server, or similar) which cannot handle sign-in. ' +
  'Open http://localhost:3000/dashboard/login.html instead — the Node server ' +
  'serves the site AND the API together.';

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

  // Wire any Cancel button inside this area.
  $$('[data-cancel]', el).forEach(b => b.addEventListener('click', () => {
    if (isDirty() && !confirm('Discard your unsaved changes?')) return;
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
