// Single-owner authentication: password (plain env or scrypt hash) + signed cookie.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const COOKIE = 'aim_session';
const TTL_MS = 7 * 24 * 3600 * 1000;

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const key = crypto.scryptSync(password, salt, 32).toString('hex');
  return `scrypt$${salt}$${key}`;
}

function verifyHash(password, stored) {
  const [alg, salt, key] = String(stored).split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const got = crypto.scryptSync(password, salt, 32);
  const want = Buffer.from(key, 'hex');
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}

export function createAuth(cfg) {
  const passwordHash = process.env.OWNER_PASSWORD_HASH || cfg.ownerPasswordHash || '';
  const enabled = Boolean(cfg.ownerPassword || passwordHash);
  let secret = cfg.sessionSecret;
  if (!secret) {
    // Persist a random signing key beside the data (mode 600), never in the DB or repo.
    const file = path.join(cfg.dataDir, '.session-secret');
    try { secret = fs.readFileSync(file, 'utf8').trim(); } catch {
      secret = crypto.randomBytes(32).toString('hex');
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.writeFileSync(file, secret, { mode: 0o600 });
    }
  }
  const failures = new Map(); // ip -> {n, until}

  function sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }
  function verify(token) {
    const [body, mac] = String(token ?? '').split('.');
    if (!body || !mac) return null;
    const want = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    if (want.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(mac))) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      return p.exp > Date.now() ? p : null;
    } catch { return null; }
  }

  function checkPassword(pw) {
    if (!pw) return false;
    if (passwordHash) return verifyHash(pw, passwordHash);
    const a = crypto.createHash('sha256').update(String(pw)).digest();
    const b = crypto.createHash('sha256').update(cfg.ownerPassword).digest();
    return crypto.timingSafeEqual(a, b);
  }

  return {
    enabled,
    cookieName: COOKIE,
    isAuthed(req) {
      if (!enabled) return true;
      const cookies = parseCookies(req.headers.cookie);
      return Boolean(verify(cookies[COOKIE]));
    },
    login(ip, password) {
      const f = failures.get(ip);
      if (f && f.until > Date.now()) return { ok: false, status: 429, error: 'Too many attempts. Try again in a minute.' };
      if (!checkPassword(password)) {
        const n = (f?.n ?? 0) + 1;
        failures.set(ip, { n, until: n >= 5 ? Date.now() + 60_000 : 0 });
        return { ok: false, status: 401, error: 'Wrong password' };
      }
      failures.delete(ip);
      const token = sign({ sub: 'owner', exp: Date.now() + TTL_MS });
      const cookie = `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TTL_MS / 1000}${cfg.cookieSecure ? '; Secure' : ''}`;
      return { ok: true, cookie };
    },
    logoutCookie() {
      return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${cfg.cookieSecure ? '; Secure' : ''}`;
    },
  };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
