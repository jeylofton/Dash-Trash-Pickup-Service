/* Sign-in page behaviour. Kept in its own file (rather than inline) so the
   site's Content-Security-Policy can forbid inline script entirely - the
   single most effective defence against stored/reflected XSS. */
import { api, $ } from '/dashboard/dash.js';

/* Demo-account helper. The credentials live only behind /api/dev-demo, which
   answers outside production alone, so on the live site this fetch 404s, the
   block stays hidden, and no demo password ever reaches the browser. */
(async () => {
  let demo;
  try {
    const res = await fetch('/api/dev-demo', { headers: { Accept: 'application/json' } });
    if (!res.ok) return;                 // production: nothing to show
    demo = await res.json();
  } catch { return; }
  if (!Array.isArray(demo.accounts) || !demo.accounts.length) return;

  const box = $('#demoCreds');
  const head = document.createElement('div');
  const strong = document.createElement('strong');
  strong.textContent = 'Demo accounts';
  head.append(strong);
  box.append(head);

  // Each account carries its own password - the owner's differs from the
  // training accounts', so filling one shared password would fail all but one.
  for (const acct of demo.accounts) {
    if (!acct.password) continue;
    const line = document.createElement('div');
    const code = document.createElement('code');
    code.textContent = acct.email;
    code.style.cursor = 'pointer';
    code.addEventListener('click', () => {
      $('#email').value = acct.email;
      $('#password').value = acct.password;
      $('#password').focus();
    });
    const pw = document.createElement('code');
    pw.textContent = acct.password;
    line.append(code, document.createTextNode(` — ${acct.role} — password `), pw);
    box.append(line);
  }

  const hint = document.createElement('p');
  hint.className = 'small';
  hint.style.margin = '9px 0 0';
  hint.textContent = 'Click an address to fill the form.';
  box.append(hint);
  box.hidden = false;
})();

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn'), err = $('#loginError');
  err.hidden = true; btn.disabled = true; btn.textContent = 'Signing in…';
  try {
    const res = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#email').value, password: $('#password').value }),
    });
    location.href = res.redirect;
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
    btn.disabled = false; btn.textContent = 'Sign in';
  }
});
