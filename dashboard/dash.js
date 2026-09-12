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
  no_trash_outside:'No trash outside', unable_to_access:'Unable to access',
  not_properly_bagged:'Not properly bagged', oversized_item:'Oversized item',
  customer_not_found:'Customer not found', other:'Other problem',
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
