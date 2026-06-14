/**
 * Unit tests for the user-bound HMAC CSRF token (utils/csrf.js).
 *
 * Secrets must be set BEFORE requiring the module — it reads CSRF_SECRET at
 * load time and throws if absent.
 */
process.env.CSRF_SECRET = process.env.CSRF_SECRET || 'test-csrf-secret-value-1234567890';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-value-1234567890';

const jwt = require('jsonwebtoken');
const { generateToken, verifyToken, getRequestUserId } = require('../utils/csrf');

const USER_A = '507f1f77bcf86cd799439011';
const USER_B = '507f1f77bcf86cd799439012';

describe('csrf token — anonymous (pre-login) tokens', () => {
  test('anonymous token verifies for an unauthenticated request', () => {
    const t = generateToken();
    expect(verifyToken(t, null)).toBe(true);
    expect(verifyToken(t, undefined)).toBe(true);
  });

  test('anonymous token is REJECTED on an authenticated request', () => {
    const t = generateToken();
    // An authenticated request (expectedUserId set) must present a bound token.
    expect(verifyToken(t, USER_A)).toBe(false);
  });
});

describe('csrf token — user-bound tokens', () => {
  test('bound token verifies for the same user', () => {
    const t = generateToken(USER_A);
    expect(verifyToken(t, USER_A)).toBe(true);
  });

  test('bound token is REJECTED for a different user (the replay defence)', () => {
    const t = generateToken(USER_A);
    expect(verifyToken(t, USER_B)).toBe(false);
  });

  test('bound token is still accepted on an unauthenticated request', () => {
    const t = generateToken(USER_A);
    expect(verifyToken(t, null)).toBe(true);
  });
});

describe('csrf token — integrity', () => {
  test('tampered signature fails', () => {
    const t = generateToken(USER_A);
    const tampered = t.slice(0, -1) + (t.endsWith('a') ? 'b' : 'a');
    expect(verifyToken(tampered, USER_A)).toBe(false);
  });

  test('garbage / malformed tokens fail', () => {
    expect(verifyToken('', null)).toBe(false);
    expect(verifyToken(null, null)).toBe(false);
    expect(verifyToken('a.b', null)).toBe(false);
    expect(verifyToken('a.b.c.d.e', null)).toBe(false);
    expect(verifyToken('notanumber.rand.sig', null)).toBe(false);
  });

  test('expired token fails (TTL enforced)', () => {
    const crypto = require('crypto');
    const oldTs = String(Date.now() - 3 * 60 * 60 * 1000); // 3h ago > 2h TTL
    const random = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const payload = `${oldTs}.${random}`;
    const sig = crypto.createHmac('sha256', process.env.CSRF_SECRET).update(payload).digest('hex');
    expect(verifyToken(`${payload}.${sig}`, null)).toBe(false);
  });
});

describe('getRequestUserId', () => {
  const mkReq = ({ bearer, cookie } = {}) => ({
    header: (name) => (name === 'Authorization' && bearer ? `Bearer ${bearer}` : undefined),
    cookies: cookie ? { authToken: cookie } : {},
  });

  test('extracts userId from a valid HS256 Bearer token', () => {
    const token = jwt.sign({ userId: USER_A }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    expect(getRequestUserId(mkReq({ bearer: token }))).toBe(USER_A);
  });

  test('extracts userId from the auth cookie', () => {
    const token = jwt.sign({ userId: USER_B }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    expect(getRequestUserId(mkReq({ cookie: token }))).toBe(USER_B);
  });

  test('returns null when no token present', () => {
    expect(getRequestUserId(mkReq())).toBeNull();
  });

  test('returns null for a token signed with the wrong secret', () => {
    const token = jwt.sign({ userId: USER_A }, 'a-different-secret', { algorithm: 'HS256' });
    expect(getRequestUserId(mkReq({ bearer: token }))).toBeNull();
  });

  test('end-to-end: a token issued for the requesting user passes the middleware contract', () => {
    const jwtToken = jwt.sign({ userId: USER_A }, process.env.JWT_SECRET, { algorithm: 'HS256' });
    const req = mkReq({ bearer: jwtToken });
    const uid = getRequestUserId(req);
    const csrf = generateToken(uid);
    expect(verifyToken(csrf, uid)).toBe(true);
  });
});
