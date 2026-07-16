import { Router } from 'express';
import { usersPool } from '../lib/usersDb.js';
import {
  SESSION_COOKIE,
  hashPin,
  verifyPin,
  createSession,
  getSessionUser,
  deleteSession,
  readSessionToken,
} from '../lib/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';

const router = Router();

// In production the cookie is set on the parent domain so the same login is
// visible to every consistencykings.com subdomain app. Locally COOKIE_DOMAIN
// is unset → host-only cookie on localhost, and Secure is dropped since
// local dev is plain http.
function cookieOptions() {
  const domain = process.env.COOKIE_DOMAIN;
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60 * 1000,
    ...(domain ? { domain, secure: true } : {}),
  };
}

router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const pin = String(req.body?.pin || '');

    if (!username || username.length > 32) {
      return res.status(400).json({ error: 'Username must be 1-32 characters' });
    }
    if (!/^\d{4}$/.test(pin)) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    }

    const existing = await usersPool.query('SELECT id, pin_hash, role FROM app_user WHERE username = $1', [
      username,
    ]);

    let userId;
    let role;
    let created = false;

    if (existing.rowCount === 0) {
      // No sign-up flow: an unknown username claims the account with this PIN.
      const pinHash = await hashPin(pin);
      const inserted = await usersPool.query(
        'INSERT INTO app_user (username, pin_hash) VALUES ($1, $2) RETURNING id, role',
        [username, pinHash]
      );
      userId = inserted.rows[0].id;
      role = inserted.rows[0].role;
      created = true;
    } else {
      const ok = await verifyPin(pin, existing.rows[0].pin_hash);
      if (!ok) {
        return res.status(401).json({ error: 'Incorrect PIN' });
      }
      userId = existing.rows[0].id;
      role = existing.rows[0].role;
    }

    const token = await createSession(userId);
    res.cookie(SESSION_COOKIE, token, cookieOptions());
    res.json({ username, role, created });
  })
);

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const user = await getSessionUser(readSessionToken(req));
    res.json({ user: user ? { username: user.username, role: user.role } : null });
  })
);

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    await deleteSession(readSessionToken(req));
    // clearCookie must match the attributes the cookie was set with.
    const { maxAge, ...clearOpts } = cookieOptions();
    res.clearCookie(SESSION_COOKIE, clearOpts);
    res.json({ ok: true });
  })
);

export default router;
