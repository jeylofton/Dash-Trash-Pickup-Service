/* ============================================================
   Client-side {{brand.*}} hydration.

   The server replaces {{brand.*}} tokens in HTML it serves (see
   server/lib/htmltemplate.js). But some hosts serve the static files
   under public/ directly from the web server, ahead of the Node app -
   on Hostinger, Passenger serves public/ that way - so the server's
   replacement never runs and the tokens reach the browser literally.
   /api/branding is not a file, so it always reaches Node; this module
   fetches it and fills any surviving tokens in, making the page look
   the same whoever served the HTML.

   When the server DID render the tokens there are none left, so this
   makes no request and does nothing. Values are written via nodeValue
   and attribute assignment (never innerHTML), so an admin-set business
   name cannot inject markup - the same guarantee the server's escaping
   gives. Only public fields resolve, mirroring PUBLIC_FIELDS in
   server/lib/branding.js, so an internal field name in a token stays a
   literal token here too.
   ============================================================ */

const TOKEN = /\{\{brand\.([a-zA-Z]+)\}\}/g;

const PUBLIC_FIELDS = ['name', 'shortName', 'website', 'supportEmail', 'supportPhone', 'address'];

export function substituteBrandTokens(str, brand) {
  return str.replace(TOKEN, (match, field) =>
    PUBLIC_FIELDS.includes(field) &&
    brand != null &&
    Object.prototype.hasOwnProperty.call(brand, field) &&
    brand[field] != null
      ? String(brand[field])
      : match);
}

export function hydrate(brand) {
  // Text nodes - walk from documentElement so <title> in <head> is included.
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeValue.indexOf('{{brand.') !== -1) texts.push(n);
  }
  for (const n of texts) n.nodeValue = substituteBrandTokens(n.nodeValue, brand);

  // Attribute values (meta content, alt, aria-label, ...). Only the value is
  // reassigned, so these live collections do not change length as we go.
  for (const el of document.getElementsByTagName('*')) {
    if (!el.attributes) continue;
    for (const attr of el.attributes) {
      if (attr.value.indexOf('{{brand.') !== -1) {
        attr.value = substituteBrandTokens(attr.value, brand);
      }
    }
  }
}

if (typeof document !== 'undefined') {
  const run = async () => {
    // Nothing to do when the server already rendered the tokens: no leftover
    // token means no request is made.
    if (document.documentElement.outerHTML.indexOf('{{brand.') === -1) return;
    try {
      const res = await fetch('/api/branding', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;                 // leave tokens rather than blank them
      hydrate(await res.json());
    } catch { /* offline / error: leave tokens as written */ }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
}
