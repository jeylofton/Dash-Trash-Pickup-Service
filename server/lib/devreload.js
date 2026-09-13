/* ============================================================
   Live reload for development — replaces VS Code Live Server.

   Why this exists: Live Server only handles GET, so it cannot run
   this app (sign-in is a POST). This gives the same save-and-refresh
   workflow from the real server, which also serves the API.

   Off automatically when NODE_ENV=production.
   ============================================================ */

import { watch } from 'node:fs';
import { extname } from 'node:path';

/* Served from its own route, not inlined, so the site's strict
   Content-Security-Policy (script-src 'self') accepts it - dev then
   exercises the exact policy production ships. */
const RELOAD_JS = `(() => {
  const es = new EventSource('/__dev/reload');
  es.onmessage = (e) => { if (e.data === 'reload') location.reload(); };
  es.onerror = () => { /* server restarting; EventSource retries on its own */ };
})();`;
/* Injected into served HTML by the branded-HTML middleware (dev only). */
export const DEV_RELOAD_SNIPPET = `\n<script src="/__dev/reload.js"></script>`;

/** Directories that should never trigger a browser reload. */
const IGNORED = /(^|[\\/\\\\])(node_modules|data|\.git|\.vscode)([\\/\\\\]|$)/;
const WATCHED_EXT = new Set(['.html', '.css', '.js']);

export function attachDevReload(app, siteRoot) {
  const clients = new Set();
  let timer = null;

  /* --- notify every open page --- */
  const broadcast = () => {
    clearTimeout(timer);
    // Debounce: editors often write a file two or three times on save.
    timer = setTimeout(() => {
      for (const res of clients) res.write('data: reload\n\n');
    }, 120);
  };

  try {
    watch(siteRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const name = String(filename);
      if (IGNORED.test(name)) return;
      if (!WATCHED_EXT.has(extname(name))) return;
      broadcast();
    });
  } catch (err) {
    console.warn('  ! live reload unavailable:', err.message);
    return;
  }

  /* --- the client script (CSP-friendly, served not inlined) --- */
  app.get('/__dev/reload.js', (req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(RELOAD_JS);
  });

  /* --- the SSE stream each page subscribes to --- */
  app.get('/__dev/reload', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 500\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  /* The HTML snippet itself is injected by the branded-HTML middleware
     (lib/htmlserve.js), which owns HTML output in every environment. */

  console.log('  Live reload: on (edit an .html/.css/.js file and the page refreshes)');
}
