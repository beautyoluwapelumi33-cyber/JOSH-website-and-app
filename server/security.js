'use strict';

/**
 * Password hashing, session tokens, signed OAuth state and secret encryption.
 * Everything here uses Node's built-in crypto; no secret is ever sent to a browser.
 */

const crypto = require('crypto');

const SESSION_COOKIE = 'josh_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const expected = Buffer.from(parts[2], 'hex');
  const derived = crypto.scryptSync(String(password), Buffer.from(parts[1], 'hex'), expected.length);
  return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function secret() {
  return process.env.SESSION_SECRET || 'josh-development-session-secret';
}

function encryptionKey() {
  const material = process.env.APP_ENCRYPTION_KEY || secret();
  return crypto.scryptSync(material, 'josh-token-encryption-v1', 32);
}

/** AES-256-GCM so stored Google refresh tokens are useless without the server key. */
function encryptSecret(plain) {
  if (!plain) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

function decryptSecret(payload) {
  if (!payload) return null;
  const [version, iv, tag, body] = String(payload).split('.');
  if (version !== 'v1' || !iv || !tag || !body) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function readState(token) {
  const [body, mac] = String(token || '').split('.');
  if (!body || !mac) return null;
  const expected = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (expected.length !== mac.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(mac))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const idx = part.indexOf('=');
      if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
    });
  return out;
}

module.exports = {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  hashPassword,
  verifyPassword,
  newToken,
  sha256,
  encryptSecret,
  decryptSecret,
  signState,
  readState,
  parseCookies,
};
