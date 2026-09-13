/* Forced password-change page. In its own file so the site CSP can forbid
   inline script entirely (see login.js). */
import { api, $ } from '/dashboard/dash.js';

$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#pwError'), ok = $('#pwOk'), btn = $('#pwBtn');
  err.hidden = true; ok.hidden = true;

  if ($('#next').value !== $('#confirm').value) {
    err.textContent = 'The two new passwords do not match.'; err.hidden = false; return;
  }
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await api('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword: $('#current').value, newPassword: $('#next').value }),
    });
    ok.textContent = res.message || 'Password updated. Please sign in again.';
    ok.hidden = false;
    setTimeout(() => { location.href = '/dashboard/login.html'; }, 1600);
  } catch (ex) {
    err.textContent = ex.message; err.hidden = false;
    btn.disabled = false; btn.textContent = 'Set my password';
  }
});
