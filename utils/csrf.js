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
 *
 * USER BINDING — the token is bound to the authenticated user. When a request
 * carries a valid JWT, the CSRF token MUST be one issued to that same user
 * (the signed payload includes the userId). This closes the replay hole where
 * any party could fetch an unauthenticated token and use it in a cross-site
 * credentialed POST riding the victim's cookie: an attacker can only mint a
 * token bound to their OWN id, which won't match the victim's session.
 * Unauthenticated state-changing requests (login/register) still work with an
 * anonymous (unbound) token.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// CSRF_SECRET is independent from JWT_SECRET on purpose — coupling them means
// rotating one silently breaks the other. server.js enforces this at boot
// via requiredEnvVars, so by the time this module is required the var is set.
const CSRF_SECRET = process.env.CSRF_SECRET;
if (!CSRF_SECRET) {
  throw new Error('CSRF_SECRET env var is required.');
}

// 2h TTL balances risk (shorter = better) with usability (too short spams
// /csrf-token fetches). Frontend auto-refreshes on 403 and retries once.
const CSRF_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * Build a CSRF token. If `userId` is provided the token is bound to that user
 * (4-part payload `ts.random.userId.sig`); otherwise it is anonymous
 * (3-part `ts.random.sig`, used for pre-login login/register).
 */
function generateToken(userId) {
  const ts = Date.now().toString();
  const random = crypto.randomBytes(16).toString('hex');
  const uid = userId ? String(userId) : '';
  // userId is a Mongo ObjectId hex string (no '.') so split('.') stays safe.
  const payload = uid ? `${ts}.${random}.${uid}` : `${ts}.${random}`;
  const sig = crypto.createHmac('sha256', CSRF_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * Verify a CSRF token's signature + TTL, and (when the request is
 * authenticated) that it is bound to the expected user.
 *
 * @param {string} token
 * @param {string|null} [expectedUserId] - userId of the authenticated request,
 *   or null/undefined for an unauthenticated request. When set, the token MUST
 *   carry a matching bound userId; an anonymous or mismatched token is rejected.
 */
function verifyToken(token, expectedUserId) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');

  let ts, random, boundUserId, sig;
  if (parts.length === 3) {
    [ts, random, sig] = parts;
    boundUserId = '';
  } else if (parts.length === 4) {
    [ts, random, boundUserId, sig] = parts;
  } else {
    return false;
  }
  if (!/^\d+$/.test(ts)) return false;

  const payload = boundUserId ? `${ts}.${random}.${boundUserId}` : `${ts}.${random}`;
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

  // Authenticated request → require a token bound to this exact user.
  if (expectedUserId) {
    if (!boundUserId || boundUserId !== String(expectedUserId)) return false;
  }
  // Unauthenticated request (expectedUserId falsy) → accept anon OR bound; the
  // route's own auth layer is the real gate for those endpoints.
  return true;
}

/**
 * Best-effort extraction of the authenticated userId from a request, by
 * verifying the JWT signature only (no DB hit). Mirrors middleware/auth.js's
 * token-resolution + algorithm pinning. Returns null when no valid token is
 * present — such requests are treated as unauthenticated for CSRF purposes.
 */
function getRequestUserId(req) {
  try {
    const authHeader = req.header ? req.header('Authorization') : req.headers?.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.replace('Bearer ', '');
    } else if (req.cookies?.authToken) {
      token = req.cookies.authToken;
    }
    if (!token) return null;
    const decoded = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ['HS256'] });
    return decoded?.userId ? String(decoded.userId) : null;
  } catch {
    return null;
  }
}

function csrfMiddleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const token = req.headers['x-csrf-token'];
  const expectedUserId = getRequestUserId(req);
  if (!verifyToken(token, expectedUserId)) {
    return res.status(403).json({ message: 'Invalid CSRF token.' });
  }
  next();
}

module.exports = { generateToken, verifyToken, csrfMiddleware, getRequestUserId };
