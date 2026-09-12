/* ============================================================
   Live reload for development — replaces VS Code Live Server.

   Why this exists: Live Server only handles GET, so it cannot run
   this app (sign-in is a POST). This gives the same save-and-refresh
   workflow from the real server, which also serves the API.

   Off automatically when NODE_ENV=production.
   ============================================================ */

import { watch } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const SNIPPET = `
<script>
(() => {
  const es = new EventSource('/__dev/reload');
  es.onmessage = (e) => { if (e.data === 'reload') location.reload(); };
  es.onerror = () => { /* server restarting; EventSource retries on its own */ };
})();
</script>`;

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

  /* --- inject the snippet into HTML on the way out ---
     Done here rather than in the source files so nothing dev-only
     ever ships in the committed HTML. */
  app.use(async (req, res, next) => {
    const path = req.path.endsWith('/') ? req.path + 'index.html' : req.path;
    if (!path.endsWith('.html')) return next();
    if (IGNORED.test(path)) return next();

    try {
      const file = join(siteRoot, decodeURIComponent(path));
      if (!file.startsWith(siteRoot)) return next();
      const html = await readFile(file, 'utf8');
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'no-store');
      res.send(html.includes('</body>')
        ? html.replace('</body>', `${SNIPPET}\n</body>`)
        : html + SNIPPET);
    } catch {
      next();   // not a real file - let the normal handlers answer
    }
  });

  console.log('  Live reload: on (edit an .html/.css/.js file and the page refreshes)');
}
