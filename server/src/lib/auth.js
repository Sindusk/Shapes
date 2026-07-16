import crypto from 'node:crypto';
import { usersPool } from './usersDb.js';

/**
 * Shared-account auth for consistencykings.com apps. Self-contained on
 * purpose (only depends on usersDb.js) so other apps on the site can copy
 * these two files and get the same login. Security is deliberately light —
 * a 4-digit PIN for a small trusted group — but the PIN is still scrypt-
 * hashed and sessions are random opaque tokens, so nothing sensitive sits
 * in the database in plaintext. Copied verbatim from Stonks' lib/auth.js.
 */

const SCRYPT_KEYLEN = 32;

function scryptAsync(pin, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pin, salt, SCRYPT_KEYLEN, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

export async function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scryptAsync(pin, salt);
  return `${salt}:${key.toString('hex')}`;
}

export async function verifyPin(pin, pinHash) {
  const [salt, keyHex] = pinHash.split(':');
  if (!salt || !keyHex) return false;
  const key = await scryptAsync(pin, salt);
  const expected = Buffer.from(keyHex, 'hex');
  return key.length === expected.length && crypto.timingSafeEqual(key, expected);
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await usersPool.query('INSERT INTO session (token, user_id) VALUES ($1, $2)', [token, userId]);
  return token;
}

export async function getSessionUser(token) {
  if (!token) return null;
  const result = await usersPool.query(
    `UPDATE session SET last_seen_at = now()
     FROM app_user
     WHERE session.token = $1 AND app_user.id = session.user_id
     RETURNING app_user.id, app_user.username, app_user.role`,
    [token]
  );
  return result.rows[0] ?? null;
}

const ROLE_RANK = { user: 0, moderator: 1, administrator: 2 };

/**
 * Express middleware: rejects the request with 403 unless the logged-in
 * user's role is at least `minRole`. Attaches the resolved user to
 * req.user for handlers that need it.
 */
export function requireRole(minRole) {
  return async (req, res, next) => {
    const user = await getSessionUser(readSessionToken(req));
    if (!user || ROLE_RANK[user.role] < ROLE_RANK[minRole]) {
      const error = minRole === 'user' ? 'Login required' : 'Moderator or administrator access required';
      return res.status(403).json({ error });
    }
    req.user = user;
    next();
  };
}

export async function deleteSession(token) {
  if (!token) return;
  await usersPool.query('DELETE FROM session WHERE token = $1', [token]);
}

export const SESSION_COOKIE = 'ck_session';

/** Pull the session token out of the Cookie header without cookie-parser. */
export function readSessionToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}
