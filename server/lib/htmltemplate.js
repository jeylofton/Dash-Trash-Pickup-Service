/* ============================================================
   Replaces {{brand.*}} tokens in served HTML with the configured
   business identity, HTML-escaped on the way in.

   Only PUBLIC brand fields are templatable: the internal business
   email/phone are never injected into a page, so a public template
   cannot leak them. Escaping is the primary defence against an
   admin-set name/value containing markup (the strict CSP is the
   backstop). Unknown tokens are left exactly as written.
   ============================================================ */

import { publicBranding } from './branding.js';

const TOKEN = /\{\{brand\.([a-zA-Z]+)\}\}/g;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderBrandTokens(html) {
  if (!html || html.indexOf('{{brand.') === -1) return html;
  const b = publicBranding();
  return html.replace(TOKEN, (match, field) =>
    Object.prototype.hasOwnProperty.call(b, field) ? esc(b[field]) : match);
}
