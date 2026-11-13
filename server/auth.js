'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const {
  hashPassword,
  verifyPassword,
  newToken,
  sha256,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  parseCookies,
} = require('./security');
const { audit } = require('./audit');
const { badRequest, unauthorized, forbidden, conflict } = require('./errors');

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name || '',
    role: row.role,
    createdAt: row.created_at,
  };
}

function isSecureRequest(req) {
  return Boolean(req.secure) || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
}

function issueSession(userId, req, res) {
  const token = newToken();
  const now = Date.now();
  db.run('DELETE FROM sessions WHERE expires_at < ?', [new Date(now).toISOString()]);
  db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', [
    sha256(token),
    userId,
    new Date(now).toISOString(),
    new Date(now + SESSION_TTL_MS).toISOString(),
  ]);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isSecureRequest(req),
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

/** Attaches req.user when a valid session cookie is present. Never throws. */
function attachUser(req, _res, next) {
  req.user = null;
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) {
    const row = db.get(
      `SELECT u.*, s.expires_at FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
      [sha256(token)]
    );
    if (row && row.expires_at > new Date().toISOString()) req.user = row;
  }
  next();
}

function requireAuth(req, _res, next) {
  if (!req.user) return next(unauthorized());
  next();
}

function requireRole(role) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role !== role) return next(forbidden());
    next();
  };
}

/** Brute-force damping: 10 failed attempts per IP+email per 15 minutes. */
const attempts = new Map();
function tooManyAttempts(key) {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.first > 15 * 60 * 1000) {
    attempts.delete(key);
    return false;
  }
  return entry.count >= 10;
}
function recordFailure(key) {
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > 15 * 60 * 1000) {
    attempts.set(key, { first: Date.now(), count: 1 });
    return;
  }
  entry.count += 1;
}

function createUser({ email, password, displayName = '', role = 'creator' }) {
  const normalized = normalizeEmail(email);
  if (!validEmail(normalized)) throw badRequest('invalid_email', 'Enter a valid email address.');
  if (String(password || '').length < 8) {
    throw badRequest('weak_password', 'Password must be at least 8 characters.');
  }
  const id = crypto.randomUUID();
  try {
    db.run(
      'INSERT INTO users (id, email, password_hash, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, normalized, hashPassword(password), String(displayName || '').slice(0, 80), role, new Date().toISOString()]
    );
  } catch (err) {
    if (db.isUniqueError(err)) throw conflict('email_taken', 'An account with that email already exists.');
    throw err;
  }
  return db.get('SELECT * FROM users WHERE id = ?', [id]);
}

/**
 * Ensures an administrator account exists. Used by the create-admin script and by
 * the boot-time bootstrap, so the website owner keeps administrator rights even
 * when the database file is recreated (no persistent disk on the Free plan).
 * Never accepts a role from a request body: only this server-side path grants it.
 */
function ensureAdmin({ email, password, displayName } = {}) {
  const normalized = normalizeEmail(email);
  if (!validEmail(normalized)) throw badRequest('invalid_email', 'Enter a valid administrator email address.');
  const existing = db.get('SELECT * FROM users WHERE email = ?', [normalized]);
  if (existing) {
    const promoted = existing.role !== 'admin';
    if (promoted) db.run('UPDATE users SET role = ? WHERE id = ?', ['admin', existing.id]);
    return { user: db.get('SELECT * FROM users WHERE id = ?', [existing.id]), created: false, promoted };
  }
  if (String(password || '').length < 8) {
    throw badRequest('weak_password', 'Administrator password must be at least 8 characters.');
  }
  const user = createUser({
    email: normalized,
    password,
    displayName: displayName || 'JOSH Owner',
    role: 'admin',
  });
  return { user, created: true, promoted: false };
}

function router() {
  const r = express.Router();

  r.post('/register', (req, res, next) => {
    try {
      const user = createUser({
        email: req.body && req.body.email,
        password: req.body && req.body.password,
        displayName: req.body && req.body.displayName,
        // Role is never taken from the request body: registration always creates a creator.
        role: 'creator',
      });
      issueSession(user.id, req, res);
      audit({ actorId: user.id, action: 'auth.register', target: user.id });
      res.status(201).json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  r.post('/login', (req, res, next) => {
    try {
      const email = normalizeEmail(req.body && req.body.email);
      const password = String((req.body && req.body.password) || '');
      const key = `${req.ip}|${email}`;
      if (tooManyAttempts(key)) {
        throw conflict('too_many_attempts', 'Too many sign-in attempts. Try again in a few minutes.');
      }
      const user = db.get('SELECT * FROM users WHERE email = ?', [email]);
      if (!user || !verifyPassword(password, user.password_hash)) {
        recordFailure(key);
        throw unauthorized('Email or password is incorrect.');
      }
      attempts.delete(key);
      issueSession(user.id, req, res);
      audit({ actorId: user.id, action: 'auth.login', target: user.id });
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  r.post('/logout', (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.json({ ok: true });
  });

  r.get('/me', (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  return r;
}

module.exports = {
  router,
  createUser,
  ensureAdmin,
  publicUser,
  attachUser,
  requireAuth,
  requireRole,
  normalizeEmail,
  validEmail,
};
