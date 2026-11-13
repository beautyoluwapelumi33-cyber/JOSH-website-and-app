'use strict';

/**
 * Google AdSense Management API v2 client.
 *
 * Real endpoints, real OAuth. Nothing here fabricates a connection: when the
 * OAuth client credentials or the Google authorization are missing, `status()`
 * reports `not_configured` / `awaiting_authorization` and `sync()` refuses to run.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { encryptSecret, decryptSecret, signState, readState } = require('./security');
const { audit } = require('./audit');
const { conflict, badRequest, ApiError } = require('./errors');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://adsense.googleapis.com/v2';
const SCOPE = 'https://www.googleapis.com/auth/adsense.readonly';
const PROVIDER = 'adsense';

function credentials() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  };
}

/** Publisher ID comes from the environment, falling back to adsense-config.js. */
function publisherId() {
  if (process.env.ADSENSE_PUBLISHER_ID) return process.env.ADSENSE_PUBLISHER_ID.trim();
  try {
    const file = path.join(__dirname, '..', 'adsense-config.js');
    const source = fs.readFileSync(file, 'utf8');
    const match = source.match(/publisherId\s*:\s*['"]([^'"]*)['"]/);
    const value = match && match[1] ? match[1].trim() : '';
    return /^ca-pub-\d{16}$/.test(value) ? value : '';
  } catch {
    return '';
  }
}

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function redirectUri(req) {
  return process.env.GOOGLE_REDIRECT_URI || `${baseUrl(req)}/api/adsense/oauth/callback`;
}

function tokenRow() {
  return db.get('SELECT * FROM oauth_tokens WHERE provider = ?', [PROVIDER]);
}

function saveTokens({ refreshToken, accessToken, expiresIn, scope }) {
  const existing = tokenRow();
  const expiresAt = accessToken ? new Date(Date.now() + (Number(expiresIn) || 3600) * 1000).toISOString() : null;
  const refreshEnc = refreshToken ? encryptSecret(refreshToken) : existing ? existing.refresh_token_enc : null;
  const accessEnc = accessToken ? encryptSecret(accessToken) : null;
  db.run(
    `INSERT INTO oauth_tokens (provider, refresh_token_enc, access_token_enc, access_token_expires_at, scope, account_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(provider) DO UPDATE SET
       refresh_token_enc = excluded.refresh_token_enc,
       access_token_enc = excluded.access_token_enc,
       access_token_expires_at = excluded.access_token_expires_at,
       scope = excluded.scope,
       updated_at = excluded.updated_at`,
    [PROVIDER, refreshEnc, accessEnc, expiresAt, scope || existing?.scope || null, existing?.account_id || null, new Date().toISOString()]
  );
}

function setAccountId(accountId) {
  db.run('UPDATE oauth_tokens SET account_id = ?, updated_at = ? WHERE provider = ?', [
    accountId,
    new Date().toISOString(),
    PROVIDER,
  ]);
}

async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

async function exchangeCode({ code, req, fetchImpl = fetch }) {
  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(req),
    grant_type: 'authorization_code',
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await readJson(res);
  if (!res.ok) {
    throw new ApiError(502, 'google_token_error', 'Google rejected the authorization code.', {
      status: res.status,
      error: data.error || null,
      description: data.error_description || null,
    });
  }
  saveTokens({
    refreshToken: data.refresh_token,
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    scope: data.scope,
  });
  return data;
}

async function accessToken({ fetchImpl = fetch } = {}) {
  const row = tokenRow();
  if (!row || !row.refresh_token_enc) {
    throw conflict('adsense_not_authorized', 'Google account authorization has not been completed.');
  }
  if (row.access_token_enc && row.access_token_expires_at) {
    const expires = new Date(row.access_token_expires_at).getTime();
    if (expires - 60_000 > Date.now()) {
      const cached = decryptSecret(row.access_token_enc);
      if (cached) return cached;
    }
  }
  const { clientId, clientSecret } = credentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: decryptSecret(row.refresh_token_enc) || '',
    grant_type: 'refresh_token',
  });
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await readJson(res);
  if (!res.ok || !data.access_token) {
    throw new ApiError(502, 'google_token_refresh_failed', 'Google token refresh failed.', {
      status: res.status,
      error: data.error || null,
    });
  }
  saveTokens({ accessToken: data.access_token, expiresIn: data.expires_in });
  return data.access_token;
}

async function apiGet(pathname, { fetchImpl = fetch, token } = {}) {
  const bearer = token || (await accessToken({ fetchImpl }));
  const res = await fetchImpl(`${API_BASE}${pathname}`, {
    headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
  });
  const data = await readJson(res);
  if (!res.ok) {
    const message = data?.error?.message || 'AdSense API request failed.';
    throw new ApiError(502, 'adsense_api_error', message, {
      status: res.status,
      reason: data?.error?.status || null,
    });
  }
  return data;
}

async function listAccounts(opts = {}) {
  const data = await apiGet('/accounts', opts);
  return Array.isArray(data.accounts) ? data.accounts : [];
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function currentPeriod(now = new Date()) {
  return isoDate(now).slice(0, 7);
}

/**
 * Syncs daily revenue and the payments list.
 * `estimated` is what Google reports live; `finalized` is only recorded for months
 * that have already closed, because AdSense finalises revenue at month end.
 */
async function sync({ days = 30, fetchImpl = fetch, now = new Date(), actorId = null } = {}) {
  const { clientId, clientSecret } = credentials();
  if (!clientId || !clientSecret) {
    throw conflict('adsense_not_configured', 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not configured.');
  }
  const row = tokenRow();
  if (!row || !row.refresh_token_enc) {
    throw conflict('adsense_not_authorized', 'Google account authorization has not been completed.');
  }
  const accountId = row.account_id;
  if (!accountId) {
    throw conflict('adsense_no_account', 'No AdSense account is linked to the authorized Google account.');
  }

  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  db.run('INSERT INTO adsense_sync_runs (id, started_at, status, message, rows_upserted) VALUES (?, ?, ?, ?, ?)', [
    runId,
    startedAt,
    'running',
    null,
    0,
  ]);

  try {
    const start = new Date(now.getTime() - Math.max(1, Math.min(days, 90)) * 86400000);
    const query = [
      'dateRange=CUSTOM',
      `startDate.year=${start.getUTCFullYear()}`,
      `startDate.month=${start.getUTCMonth() + 1}`,
      `startDate.day=${start.getUTCDate()}`,
      `endDate.year=${now.getUTCFullYear()}`,
      `endDate.month=${now.getUTCMonth() + 1}`,
      `endDate.day=${now.getUTCDate()}`,
      'dimensions=DATE',
      'metrics=IMPRESSIONS',
      'metrics=CLICKS',
      'metrics=PAGE_VIEWS',
      'metrics=ESTIMATED_EARNINGS',
      'currencyCode=USD',
    ].join('&');

    const report = await apiGet(`/accounts/${encodeURIComponent(accountId)}/reports:generate?${query}`, { fetchImpl });
    const headers = (report.headers || []).map((h) => String(h.name || '').toUpperCase());
    const closed = currentPeriod(now);
    let rowsUpserted = 0;

    db.tx(() => {
      for (const rowData of report.rows || []) {
        const cells = rowData.cells || [];
        const value = (name) => {
          const idx = headers.indexOf(name);
          return idx === -1 ? '' : String(cells[idx]?.value ?? '');
        };
        const date = value('DATE');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const estimated = Number(value('ESTIMATED_EARNINGS') || 0);
        const isClosedMonth = date.slice(0, 7) < closed;
        db.run(
          `INSERT INTO ad_revenue_daily
             (period_date, source, currency, estimated_earnings, finalized_earnings, impressions, clicks, page_views, is_manual, updated_at)
           VALUES (?, 'adsense', 'USD', ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(period_date, source) DO UPDATE SET
             estimated_earnings = excluded.estimated_earnings,
             finalized_earnings = excluded.finalized_earnings,
             impressions = excluded.impressions,
             clicks = excluded.clicks,
             page_views = excluded.page_views,
             is_manual = 0,
             updated_at = excluded.updated_at`,
          [
            date,
            estimated,
            isClosedMonth ? estimated : 0,
            Number(value('IMPRESSIONS') || 0),
            Number(value('CLICKS') || 0),
            Number(value('PAGE_VIEWS') || 0),
            new Date().toISOString(),
          ]
        );
        rowsUpserted += 1;
      }
    });

    // Payments are a separate Google resource; failure here must not invalidate revenue.
    let payments = null;
    let paymentsError = null;
    try {
      const data = await apiGet(`/accounts/${encodeURIComponent(accountId)}/payments`, { fetchImpl });
      payments = (data.payments || []).map((p) => ({
        id: p.id || p.name || null,
        date: p.date ? `${p.date.year}-${String(p.date.month).padStart(2, '0')}-${String(p.date.day).padStart(2, '0')}` : null,
        amount: p.amount != null ? String(p.amount) : null,
        currency: 'USD',
        state: p.state || p.status || 'UNKNOWN',
      }));
      db.run(
        `INSERT INTO settings (key, value, updated_at) VALUES ('adsense_payments', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [JSON.stringify({ fetchedAt: new Date().toISOString(), payments }), new Date().toISOString()]
      );
    } catch (err) {
      paymentsError = err.message;
    }

    const message = paymentsError
      ? `Revenue synced; payments list unavailable (${paymentsError}).`
      : `Synced ${rowsUpserted} day(s) of revenue.`;
    db.run('UPDATE adsense_sync_runs SET finished_at = ?, status = ?, message = ?, rows_upserted = ? WHERE id = ?', [
      new Date().toISOString(),
      'ok',
      message,
      rowsUpserted,
      runId,
    ]);
    audit({ actorId, action: 'adsense.sync', target: accountId, metadata: { rowsUpserted, paymentsError } });
    return { ok: true, rowsUpserted, paymentsError, message };
  } catch (err) {
    db.run('UPDATE adsense_sync_runs SET finished_at = ?, status = ?, message = ? WHERE id = ?', [
      new Date().toISOString(),
      'error',
      String(err.message).slice(0, 500),
      runId,
    ]);
    audit({ actorId, action: 'adsense.sync_failed', target: accountId, metadata: { message: err.message } });
    throw err;
  }
}

function paymentsSnapshot() {
  const row = db.get("SELECT value FROM settings WHERE key = 'adsense_payments'");
  if (!row) return { fetchedAt: null, payments: [] };
  try {
    return JSON.parse(row.value);
  } catch {
    return { fetchedAt: null, payments: [] };
  }
}

/** Single source of truth for the "is AdSense working?" indicator. */
function status() {
  const { clientId, clientSecret } = credentials();
  const row = tokenRow();
  const lastRun = db.get('SELECT * FROM adsense_sync_runs ORDER BY started_at DESC LIMIT 1');
  const base = {
    publisherId: publisherId() || null,
    accountId: row?.account_id || null,
    authorized: Boolean(row && row.refresh_token_enc),
    credentialsPresent: Boolean(clientId && clientSecret),
    lastSync: lastRun
      ? { at: lastRun.finished_at || lastRun.started_at, status: lastRun.status, message: lastRun.message }
      : null,
    redirectUri: null,
  };
  if (!clientId || !clientSecret) {
    return {
      ...base,
      state: 'not_configured',
      detail: 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not set, so the AdSense API cannot be called.',
      missing: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    };
  }
  if (!row || !row.refresh_token_enc) {
    return {
      ...base,
      state: 'awaiting_authorization',
      detail: 'OAuth client is configured. An administrator must authorize the Google account that owns the AdSense account.',
      missing: ['Google account authorization'],
    };
  }
  if (!row.account_id) {
    return {
      ...base,
      state: 'awaiting_approval',
      detail: 'Google authorized, but no AdSense account was returned. The site may still be awaiting AdSense approval.',
      missing: ['AdSense account approval'],
    };
  }
  if (lastRun && lastRun.status === 'error') {
    return { ...base, state: 'error', detail: lastRun.message || 'The last synchronization failed.' };
  }
  return {
    ...base,
    state: 'connected',
    detail: lastRun ? 'AdSense is authorized and reporting.' : 'AdSense is authorized. Run a sync to import revenue.',
  };
}

function authorizeUrl(req) {
  const { clientId, clientSecret } = credentials();
  if (!clientId || !clientSecret) {
    throw conflict('adsense_not_configured', 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
  }
  const state = signState({ uid: req.user.id, exp: Date.now() + 10 * 60 * 1000, n: crypto.randomBytes(8).toString('hex') });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

async function handleCallback({ code, state, req, fetchImpl = fetch }) {
  const payload = readState(state);
  if (!payload) throw badRequest('invalid_state', 'The authorization request expired or was tampered with.');
  if (!code) throw badRequest('missing_code', 'Google did not return an authorization code.');
  await exchangeCode({ code, req, fetchImpl });
  const accounts = await listAccounts({ fetchImpl });
  if (accounts.length) {
    setAccountId(accounts[0].name || null);
  }
  audit({ actorId: payload.uid, action: 'adsense.authorized', target: accounts[0]?.name || null, metadata: { accounts: accounts.length } });
  return { accounts: accounts.length, accountId: accounts[0]?.name || null };
}

module.exports = {
  SCOPE,
  credentials,
  publisherId,
  status,
  authorizeUrl,
  handleCallback,
  sync,
  listAccounts,
  paymentsSnapshot,
  redirectUri,
  currentPeriod,
  isoDate,
};
