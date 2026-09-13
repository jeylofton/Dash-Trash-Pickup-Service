/* ============================================================
   HTTP hardening: response headers and HTTPS enforcement.

   Kept as plain middleware - no helmet dependency - to match the
   rest of this server, which writes six lines rather than pull a
   package in. The Content-Security-Policy is deliberately strict:
   'self' for scripts (the pages carry no inline handlers and their
   two inline module blocks were extracted to files), which is what
   turns a stored-XSS bug from fatal into inert. Inline styles are
   still allowed because they cannot exfiltrate or execute.
   ============================================================ */

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const isProd = () => process.env.NODE_ENV === 'production';

export function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Content-Security-Policy', CSP);
  res.set('X-Permitted-Cross-Domain-Policies', 'none');
  // HSTS is only meaningful - and only safe - over HTTPS. Sending it in
  // local http development would pin the browser to a scheme that isn't
  // there and lock the developer out.
  if (isProd()) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

/* A small in-memory per-IP rate limiter, one bucket per instance. Enough to
   blunt brute-force and enumeration on public endpoints without a dependency;
   a multi-process deployment should move this to a shared store. */
export function rateLimiter({ max = 20, windowMs = 60_000 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip;
    const now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) {
      return res.status(429).json({ ok: false, error: 'Too many attempts. Please wait a minute.' });
    }
    list.push(now);
    hits.set(key, list);
    next();
  };
}

export function forceHttps(req, res, next) {
  // No TLS in development; a redirect would only send the browser nowhere.
  if (!isProd()) return next();
  // Behind a TLS-terminating proxy the app sees plain http plus this header.
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  if (secure) return next();
  return res.redirect(308, `https://${req.headers.host}${req.originalUrl}`);
}
