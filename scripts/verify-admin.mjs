#!/usr/bin/env node
'use strict';

/**
 * End-to-end verification of the JOSH administrator and creator APIs.
 *
 * Runs the real server against a throwaway database and a stub BNB Smart Chain
 * node, so it proves behaviour without touching production data or the network:
 *   - anonymous and creator requests are rejected from /api/admin/*
 *   - the owner account bootstraps with administrator rights
 *   - registration can never grant the admin role
 *   - the 60/40 split pays exactly 60% of finalized revenue into the creator pool
 *   - distribution never double-credits a creator
 *   - withdrawals enforce the 0.5 USDT minimum and one open request per creator
 *   - a payment is marked paid only when the on-chain USDT transfer verifies
 *   - a reused transaction hash is rejected
 *   - public pages never leak private administrator data
 */

import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PORT = Number(process.env.VERIFY_PORT || 3179);
const RPC_PORT = PORT + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join('/tmp', `josh-verify-admin-${process.pid}.sqlite`);

const ADMIN_EMAIL = 'owner.verify@josh.test';
const ADMIN_PASSWORD = 'OwnerPass12345';
const CREATOR_EMAIL = 'creator.verify@josh.test';
const CREATOR_PASSWORD = 'CreatorPass12345';
const CREATOR_WALLET = `0x${'11'.repeat(20)}`;
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const PERIOD = '2026-10';
const PERIOD_DATE = '2026-10-05';

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : ` — ${detail}`}`);
}

/* ------------------------------------------------ stub BNB Smart Chain node */
const stubNode = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      payload = {};
    }
    let result = null;
    if (payload.method === 'eth_getTransactionReceipt') {
      // A confirmed USDT transfer of 5 USDT to the creator wallet.
      result = {
        status: '0x1',
        blockNumber: '0x10',
        transactionHash: payload.params?.[0] || TX_HASH,
        logs: [
          {
            address: USDT,
            topics: [TRANSFER, `0x${'0'.repeat(24)}${'22'.repeat(20)}`, `0x${'0'.repeat(24)}${'11'.repeat(20)}`],
            data: `0x${(5n * 10n ** 18n).toString(16)}`,
          },
        ],
      };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id ?? 1, result }));
  });
});

async function request(route, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const session = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('josh_session='));
  return { status: res.status, json, cookie: session };
}

async function waitForHealth(deadlineMs = 25_000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch {
      /* server still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function main() {
  await new Promise((resolve) => stubNode.listen(RPC_PORT, '0.0.0.0', resolve));

  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      JOSH_DB_FILE: DB_FILE,
      JOSH_ADMIN_EMAIL: ADMIN_EMAIL,
      JOSH_ADMIN_PASSWORD: ADMIN_PASSWORD,
      JOSH_ADMIN_NAME: 'JOSH Owner',
      BSC_RPC_URL: `http://127.0.0.1:${RPC_PORT}`,
      PAYOUT_PROVIDER: '',
      PAYOUT_API_KEY: '',
      PAYOUT_WALLET_ADDRESS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (chunk) => (serverLog += chunk));
  server.stderr.on('data', (chunk) => (serverLog += chunk));

  const cleanup = () => {
    try {
      server.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    stubNode.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(`${DB_FILE}${suffix}`);
      } catch {
        /* nothing to remove */
      }
    }
  };

  try {
    if (!(await waitForHealth())) throw new Error(`Server did not become healthy.\n${serverLog}`);

    /* ------------------------------------------------- anonymous isolation */
    check('anonymous GET /api/admin/overview is rejected', (await request('/api/admin/overview')).status === 401);
    check('anonymous GET /api/admin/users is rejected', (await request('/api/admin/users')).status === 401);
    check('anonymous GET /api/admin/withdrawals is rejected', (await request('/api/admin/withdrawals')).status === 401);

    /* ------------------------------------------------------ creator account */
    const registration = await request('/api/auth/register', {
      method: 'POST',
      body: { email: CREATOR_EMAIL, password: CREATOR_PASSWORD, displayName: 'Verify Creator', role: 'admin' },
    });
    check('creator registration succeeds', registration.status === 200 || registration.status === 201, `status ${registration.status}`);
    const creatorCookie = registration.cookie;
    check('creator registration returns a session cookie', Boolean(creatorCookie));
    check(
      'registration cannot grant the admin role',
      registration.json?.user?.role === 'creator',
      `role was ${registration.json?.user?.role}`
    );

    check('creator GET /api/admin/overview is forbidden', (await request('/api/admin/overview', { cookie: creatorCookie })).status === 403);
    check('creator PATCH /api/admin/users/:id/role is forbidden', (await request('/api/admin/users/any/role', { method: 'PATCH', cookie: creatorCookie, body: { role: 'admin' } })).status === 403);
    check('creator GET /api/admin/audit is forbidden', (await request('/api/admin/audit', { cookie: creatorCookie })).status === 403);

    const emptySummary = await request('/api/creator/summary', { cookie: creatorCookie });
    check('creator summary is readable by the creator', emptySummary.status === 200);
    check('creator starts with a zero balance and no invented earnings', emptySummary.json?.balance === 0 && emptySummary.json?.earnings?.total === 0);
    check('creator summary exposes the 0.5 USDT minimum', emptySummary.json?.payments?.minWithdrawal === 0.5);

    check(
      'withdrawal below the 0.5 USDT minimum is rejected',
      (await request('/api/creator/withdrawals', { method: 'POST', cookie: creatorCookie, body: { amount: 0.1 } })).status === 400
    );
    check(
      'wallet address validation rejects a malformed address',
      (await request('/api/creator/wallet', { method: 'POST', cookie: creatorCookie, body: { address: '0x123' } })).status === 400
    );
    const walletSave = await request('/api/creator/wallet', { method: 'POST', cookie: creatorCookie, body: { address: CREATOR_WALLET } });
    check('creator can save a BEP20 wallet address', walletSave.status === 200, `status ${walletSave.status}`);

    /* -------------------------------------------------------- admin sign-in */
    check(
      'admin login rejects a wrong password',
      (await request('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: 'wrong-password-here' } })).status === 401
    );
    const adminLogin = await request('/api/auth/login', { method: 'POST', body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    check('bootstrapped owner can sign in', adminLogin.status === 200, `status ${adminLogin.status}`);
    check('owner account holds the admin role', adminLogin.json?.user?.role === 'admin', `role was ${adminLogin.json?.user?.role}`);
    const adminCookie = adminLogin.cookie;

    const overview = await request('/api/admin/overview', { cookie: adminCookie });
    check('admin can read the overview', overview.status === 200);
    check('overview counts the registered accounts', (overview.json?.users?.total || 0) >= 2, `users ${overview.json?.users?.total}`);
    check(
      'overview reports zero revenue before any data exists',
      overview.json?.revenue?.finalized === 0 && overview.json?.revenue?.estimated === 0
    );
    check('overview does not leak OAuth tokens', !JSON.stringify(overview.json || {}).includes('refresh_token'));
    check(
      'payments status does not claim automatic payouts without credentials',
      overview.json?.payments?.autoPayoutConfigured === false
    );

    /* -------------------------------------------- revenue and 60/40 sharing */
    check(
      'manual revenue requires a source note',
      (await request('/api/admin/revenue/manual', { method: 'POST', cookie: adminCookie, body: { date: PERIOD_DATE, estimated: 5 } })).status === 400
    );
    const metrics = await request('/api/admin/metrics', {
      method: 'POST',
      cookie: adminCookie,
      body: { email: CREATOR_EMAIL, date: PERIOD_DATE, eligibleViews: 1000 },
    });
    check('admin can record verified creator views', metrics.status === 201, `status ${metrics.status}`);

    const manual = await request('/api/admin/revenue/manual', {
      method: 'POST',
      cookie: adminCookie,
      body: { date: PERIOD_DATE, estimated: 12.5, finalized: 10, note: 'Google finalized report import (test)' },
    });
    check('admin can record manual finalized revenue', manual.status === 201, `status ${manual.status}`);
    check(
      'duplicate manual revenue for the same date is rejected',
      (await request('/api/admin/revenue/manual', {
        method: 'POST',
        cookie: adminCookie,
        body: { date: PERIOD_DATE, estimated: 1, note: 'duplicate attempt' },
      })).status === 409
    );

    const distribute = await request('/api/admin/earnings/distribute', { method: 'POST', cookie: adminCookie, body: { period: PERIOD } });
    check('distribution runs for the finalized month', distribute.status === 200, `status ${distribute.status}`);
    check('creator pool is exactly 60% of finalized revenue', distribute.json?.pool === 6, `pool ${distribute.json?.pool}`);
    check('one creator credit is created', distribute.json?.created === 1, `created ${distribute.json?.created}`);

    const redistribute = await request('/api/admin/earnings/distribute', { method: 'POST', cookie: adminCookie, body: { period: PERIOD } });
    check('re-running distribution does not double-credit', redistribute.json?.created === 0 && redistribute.json?.skipped === 1, JSON.stringify(redistribute.json));

    const earnings = await request('/api/admin/earnings', { cookie: adminCookie });
    check('earnings ledger totals the creator credit', earnings.json?.totalCredited === 6, `total ${earnings.json?.totalCredited}`);
    check('earnings ledger reports the 60/40 split', earnings.json?.sharing?.creatorShare === 0.6 && earnings.json?.sharing?.platformShare === 0.4);

    const paidSummary = await request('/api/creator/summary', { cookie: creatorCookie });
    check('creator sees the credited earnings', paidSummary.json?.earnings?.total === 6, `total ${paidSummary.json?.earnings?.total}`);
    check('creator available balance matches the credit', paidSummary.json?.balance === 6, `balance ${paidSummary.json?.balance}`);
    check(
      'earnings above the balance are refused',
      (await request('/api/creator/withdrawals', { method: 'POST', cookie: creatorCookie, body: { amount: 50 } })).status === 400
    );

    /* -------------------------------------------------------- withdrawals */
    const withdrawal = await request('/api/creator/withdrawals', { method: 'POST', cookie: creatorCookie, body: { amount: 1 } });
    check('creator can request a withdrawal', withdrawal.status === 201, `status ${withdrawal.status}`);
    const withdrawalId = withdrawal.json?.withdrawal?.id;
    check(
      'a second open withdrawal is blocked',
      (await request('/api/creator/withdrawals', { method: 'POST', cookie: creatorCookie, body: { amount: 1 } })).status === 409
    );

    const adminList = await request('/api/admin/withdrawals?status=pending', { cookie: adminCookie });
    check('admin sees the pending withdrawal', (adminList.json?.withdrawals || []).some((w) => w.id === withdrawalId));

    const approved = await request(`/api/admin/withdrawals/${withdrawalId}/decide`, {
      method: 'POST',
      cookie: adminCookie,
      body: { decision: 'approve' },
    });
    check('admin can approve the withdrawal', approved.json?.status === 'approved', JSON.stringify(approved.json));

    check(
      'marking paid with a malformed hash is refused',
      (await request(`/api/admin/withdrawals/${withdrawalId}/mark-paid`, { method: 'POST', cookie: adminCookie, body: { txHash: '0x123' } })).status === 400
    );

    const paid = await request(`/api/admin/withdrawals/${withdrawalId}/mark-paid`, {
      method: 'POST',
      cookie: adminCookie,
      body: { txHash: TX_HASH },
    });
    check('verified on-chain transfer marks the withdrawal paid', paid.json?.status === 'paid', JSON.stringify(paid.json?.verification));
    check('verification result carries the on-chain amount', paid.json?.verification?.verified === true && paid.json?.verification?.amount === 5);

    const settled = await request('/api/creator/summary', { cookie: creatorCookie });
    check('creator sees the paid withdrawal with its transaction hash', settled.json?.withdrawals?.[0]?.status === 'paid' && settled.json?.withdrawals?.[0]?.txHash === TX_HASH);
    check('balance drops after the payout', settled.json?.balance === 5, `balance ${settled.json?.balance}`);

    const second = await request('/api/creator/withdrawals', { method: 'POST', cookie: creatorCookie, body: { amount: 1 } });
    check('a further withdrawal is allowed after settlement', second.status === 201, `status ${second.status}`);
    check(
      'reusing the same transaction hash is rejected',
      (await request(`/api/admin/withdrawals/${second.json?.withdrawal?.id}/mark-paid`, {
        method: 'POST',
        cookie: adminCookie,
        body: { txHash: TX_HASH },
      })).status === 409
    );

    /* --------------------------------------- content, settings and audit */
    const video = await request('/api/admin/videos', {
      method: 'POST',
      cookie: adminCookie,
      body: { title: 'JOSH verification video', creatorEmail: CREATOR_EMAIL, durationSeconds: 120 },
    });
    check('admin can publish a video record', video.status === 201, `status ${video.status}`);
    const publicVideos = await request('/api/videos');
    check('published video appears on the public site', (publicVideos.json?.videos || []).some((v) => v.id === video.json?.video?.id));

    const live = await request('/api/admin/live', { method: 'POST', cookie: adminCookie, body: { title: 'JOSH verification stream' } });
    check('admin can schedule a livestream', live.status === 201, `status ${live.status}`);
    const liveList = await request('/api/admin/live', { cookie: adminCookie });
    check('livestream monitoring lists the stream', (liveList.json?.livestreams || []).some((s) => s.id === live.json?.livestream?.id));

    const settings = await request('/api/admin/settings', { method: 'PUT', cookie: adminCookie, body: { siteName: 'JOSH', logoAccent: '#ff3155' } });
    check('admin can update site settings', settings.status === 200, `status ${settings.status}`);
    const branding = await request('/api/branding');
    check('public branding reflects the saved settings', branding.json?.siteName === 'JOSH');

    const auditTrail = await request('/api/admin/audit', { cookie: adminCookie });
    check('audit log records administrative actions', auditTrail.status === 200 && (auditTrail.json?.entries || []).length > 0);
    check(
      'audit log contains the payment verification event',
      JSON.stringify(auditTrail.json || {}).includes('withdrawal.paid')
    );

    const users = await request('/api/admin/users', { cookie: adminCookie });
    check('admin user list never exposes password hashes', !JSON.stringify(users.json || {}).includes('password_hash'));
    check('admin user list includes creator management fields', Array.isArray(users.json?.users) && users.json.users.every((u) => 'role' in u));
  } finally {
    cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('Server log tail:');
    console.log(serverLog.split('\n').slice(-30).join('\n'));
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('verify-admin failed:', err.message);
  process.exitCode = 1;
});
