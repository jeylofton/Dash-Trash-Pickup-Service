/* ============================================================
   Serves the site's HTML with branding tokens resolved, in EVERY
   environment. This owns HTML output so {{brand.*}} replacement and
   (in development) the live-reload snippet are applied consistently -
   express.static streams files untouched, which is why HTML cannot be
   left to it once pages carry brand tokens.

   Resolves the same paths express.static would: a trailing slash and
   the bare root map to index.html, an extensionless path maps to
   <path>.html, and anything with a non-HTML extension is left for the
   static asset handlers. Reads are confined to the site root.
   ============================================================ */

import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { renderBrandTokens } from './htmltemplate.js';

export function attachBrandedHtml(app, siteRoot, { decorate } = {}) {
  const root = normalize(siteRoot);

  app.use(async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    let rel;
    try { rel = decodeURIComponent(req.path); }
    catch { return next(); }

    const last = rel.split('/').pop();
    if (rel.endsWith('/')) rel += 'index.html';
    else if (!rel.endsWith('.html')) {
      if (last.includes('.')) return next();   // a non-HTML asset - not ours
      rel += '.html';                          // extensionless -> try .html
    }

    const file = normalize(join(root, rel));
    if (file !== root && !file.startsWith(root + '/') && !file.startsWith(root + '\\')) {
      return next();                           // path traversal guard
    }

    let html;
    try { html = await readFile(file, 'utf8'); }
    catch { return next(); }                   // no such HTML file here

    html = renderBrandTokens(html);
    if (decorate) html = decorate(html);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(html);
  });
}
