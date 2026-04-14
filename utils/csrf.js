/**
 * Stateless HMAC-based CSRF token.
 *
 * Why not csurf? csurf stores a secret in a cookie; on cross-domain setups
 * (frontend on Vercel, backend on Render) iOS Safari's ITP blocks that
 * third-party cookie, producing "Invalid CSRF token" errors on signup/login.
 *
 * This implementation signs a timestamped random value with an HMAC and
 * returns it as the token. No cookie is required — the frontend receives
 * the token from GET /api/auth/csrf-token and echoes it back in the
 * `X-CSRF-Token` header on state-changing requests. Defence in depth is
 * still provided by CORS (allowed origins only) and the SameSite=None auth
 * cookie being sent only via `credentials: 'include'`.
 */
const crypto = require('crypto');

const CSRF_SECRET = process.env.CSRF_SECRET || process.env.JWT_SECRET;
if (!CSRF_SECRET) {
  throw new Error('CSRF secret missing: set CSRF_SECRET or JWT_SECRET env var');
}

const CSRF_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function generateToken() {
  const ts = Date.now().toString();
  const random = crypto.randomBytes(16).toString('hex');
  const payload = `${ts}.${random}`;
  const sig = crypto.createHmac('sha256', CSRF_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [ts, random, sig] = parts;
  if (!/^\d+$/.test(ts)) return false;
  const payload = `${ts}.${random}`;
  const expected = crypto.createHmac('sha256', CSRF_SECRET).update(payload).digest('hex');
  let sigBuf, expBuf;
  try {
    sigBuf = Buffer.from(sig, 'hex');
    expBuf = Buffer.from(expected, 'hex');
  } catch {
    return false;
  }
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;
  const age = Date.now() - parseInt(ts, 10);
  if (age < 0 || age > CSRF_TTL_MS) return false;
  return true;
}

function csrfMiddleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const token = req.headers['x-csrf-token'];
  if (!verifyToken(token)) {
    return res.status(403).json({ message: 'Invalid CSRF token.' });
  }
  next();
}

module.exports = { generateToken, verifyToken, csrfMiddleware };
