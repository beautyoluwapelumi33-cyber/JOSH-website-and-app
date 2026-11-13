'use strict';

/**
 * Creator-facing API plus the small public surface the website reads.
 *
 * A creator can only ever see their own videos, earnings and withdrawals —
 * every query is scoped by req.user.id, so one creator can never read another's
 * financial data. Administrator accounts are rejected here: they use /api/admin.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const payments = require('./payments');
const { audit } = require('./audit');
const { requireAuth } = require('./auth');
const { badRequest, conflict, notFound, forbidden } = require('./errors');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const nowIso = () => new Date().toISOString();
const num = (value) => Number(value || 0);
const round = (value, dp = 6) => Math.round(num(value) * 10 ** dp) / 10 ** dp;

/** Amount a creator may withdraw right now: credited earnings minus everything committed. */
function balanceFor(userId) {
  const earned = num(db.get('SELECT COALESCE(SUM(amount), 0) AS v FROM creator_earnings WHERE user_id = ?', [userId]).v);
  const committed = num(
    db.get(
      `SELECT COALESCE(SUM(amount), 0) AS v FROM withdrawals
        WHERE user_id = ? AND status IN ('pending','approved','processing','paid')`,
      [userId]
    ).v
  );
  return round(Math.max(0, earned - committed));
}

function creatorRouter() {
  const r = express.Router();
  r.use(requireAuth);
  r.use((req, _res, next) => {
    if (!req.user) return next(forbidden());
    if (req.user.role === 'admin') return next(forbidden('Administrator accounts use the admin dashboard.'));
    next();
  });

  r.get(
    '/summary',
    wrap(async (req, res) => {
      const userId = req.user.id;
      const videos = db.get(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(views), 0) AS views,
                COALESCE(SUM(watch_seconds), 0) AS watch_seconds
           FROM videos WHERE user_id = ? AND status <> 'removed'`,
        [userId]
      );
      const earnings = db.get(
        `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS periods,
                COALESCE(SUM(CASE WHEN state = 'estimated' THEN amount ELSE 0 END), 0) AS estimated
           FROM creator_earnings WHERE user_id = ?`,
        [userId]
      );
      const wallet = db.get('SELECT * FROM wallet_addresses WHERE user_id = ?', [userId]);
      const withdrawals = db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [userId]);
      const periods = db.all(
        'SELECT period, amount, eligible_views, state FROM creator_earnings WHERE user_id = ? ORDER BY period DESC LIMIT 24',
        [userId]
      );
      const ownVideos = db.all(
        `SELECT id, title, status, visibility, views, watch_seconds, created_at
           FROM videos WHERE user_id = ? AND status <> 'removed' ORDER BY created_at DESC LIMIT 50`,
        [userId]
      );
      res.json({
        videos: {
          total: num(videos.total),
          views: num(videos.views),
          watchHours: round(num(videos.watch_seconds) / 3600, 2),
          items: ownVideos.map((row) => ({
            id: row.id,
            title: row.title,
            status: row.status,
            visibility: row.visibility,
            views: num(row.views),
            watchHours: round(num(row.watch_seconds) / 3600, 2),
            createdAt: row.created_at,
          })),
        },
        earnings: {
          total: round(earnings.total),
          periods: num(earnings.periods),
          estimated: round(earnings.estimated),
          history: periods.map((row) => ({
            period: row.period,
            amount: round(row.amount),
            eligibleViews: num(row.eligible_views),
            state: row.state,
          })),
        },
        balance: balanceFor(userId),
        wallet: wallet ? { address: wallet.address, network: wallet.network, updatedAt: wallet.updated_at } : null,
        withdrawals: withdrawals.map((row) => ({
          id: row.id,
          amount: round(row.amount),
          address: row.address,
          network: row.network,
          status: row.status,
          txHash: row.tx_hash,
          rejectionReason: row.rejection_reason,
          verificationNote: row.verification_note,
          createdAt: row.created_at,
          verifiedAt: row.verified_at,
        })),
        payments: {
          minWithdrawal: payments.MIN_WITHDRAWAL,
          network: 'BEP20',
          asset: 'USDT',
        },
      });
    })
  );

  r.post(
    '/wallet',
    wrap(async (req, res) => {
      const address = String(req.body?.address || '').trim();
      if (!payments.isAddress(address)) {
        throw badRequest('invalid_address', 'Enter a valid BEP20 wallet address (0x followed by 40 characters).');
      }
      db.run(
        `INSERT INTO wallet_addresses (user_id, address, network, updated_at) VALUES (?, ?, 'BEP20', ?)
         ON CONFLICT(user_id) DO UPDATE SET address = excluded.address, updated_at = excluded.updated_at`,
        [req.user.id, address, nowIso()]
      );
      audit({ actorId: req.user.id, action: 'wallet.update', target: req.user.id, metadata: { address } });
      res.json({ ok: true, wallet: { address, network: 'BEP20' } });
    })
  );

  r.post(
    '/withdrawals',
    wrap(async (req, res) => {
      const amount = round(Number(req.body?.amount));
      if (!Number.isFinite(amount) || amount <= 0) throw badRequest('invalid_amount', 'Enter a withdrawal amount.');
      if (amount < payments.MIN_WITHDRAWAL) {
        throw badRequest('below_minimum', `The minimum withdrawal is ${payments.MIN_WITHDRAWAL} USDT.`);
      }
      const stored = db.get('SELECT address FROM wallet_addresses WHERE user_id = ?', [req.user.id]);
      const address = String(req.body?.address || stored?.address || '').trim();
      if (!payments.isAddress(address)) {
        throw badRequest('invalid_address', 'Add a valid BEP20 wallet address before requesting a withdrawal.');
      }
      const open = db.get(
        "SELECT id FROM withdrawals WHERE user_id = ? AND status IN ('pending','approved','processing')",
        [req.user.id]
      );
      if (open) throw conflict('withdrawal_in_progress', 'You already have a withdrawal awaiting completion.');

      const balance = balanceFor(req.user.id);
      if (amount > balance) {
        throw badRequest('insufficient_balance', `Your available balance is ${balance} USDT.`);
      }

      const id = crypto.randomUUID();
      const at = nowIso();
      db.run(
        `INSERT INTO withdrawals (id, user_id, amount, address, network, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'BEP20', 'pending', ?, ?)`,
        [id, req.user.id, amount, address, at, at]
      );
      if (!stored) {
        db.run(
          `INSERT INTO wallet_addresses (user_id, address, network, updated_at) VALUES (?, ?, 'BEP20', ?)
           ON CONFLICT(user_id) DO NOTHING`,
          [req.user.id, address, at]
        );
      }
      audit({ actorId: req.user.id, action: 'withdrawal.request', target: id, metadata: { amount } });
      res.status(201).json({ withdrawal: { id, amount, status: 'pending', address } });
    })
  );

  r.get(
    '/withdrawals',
    wrap(async (req, res) => {
      const rows = db.all('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [req.user.id]);
      res.json({
        balance: balanceFor(req.user.id),
        withdrawals: rows.map((row) => ({
          id: row.id,
          amount: round(row.amount),
          status: row.status,
          txHash: row.tx_hash,
          rejectionReason: row.rejection_reason,
          createdAt: row.created_at,
        })),
      });
    })
  );

  r.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown creator route.' } }));
  return r;
}

/** Public, unauthenticated reads: real published videos and safe branding only. */
function publicRouter() {
  const r = express.Router();

  r.get('/videos', (req, res) => {
    const rows = db.all(
      `SELECT v.id, v.title, v.description, v.source_url, v.thumbnail_url, v.views, v.duration_seconds, v.created_at,
              u.display_name AS creator_name
         FROM videos v LEFT JOIN users u ON u.id = v.user_id
        WHERE v.status = 'published' AND v.visibility = 'public'
        ORDER BY v.created_at DESC LIMIT 48`
    );
    res.json({
      videos: rows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        sourceUrl: row.source_url,
        thumbnailUrl: row.thumbnail_url,
        views: num(row.views),
        durationSeconds: num(row.duration_seconds),
        creatorName: row.creator_name || 'JOSH creator',
        createdAt: row.created_at,
      })),
    });
  });

  r.get('/branding', (_req, res) => {
    const rows = db.all("SELECT key, value FROM settings WHERE key IN ('site_name','logo_url','logo_accent')");
    const map = {};
    for (const row of rows) map[row.key] = row.value;
    res.json({
      siteName: map.site_name || 'JOSH',
      logoUrl: map.logo_url || '',
      logoAccent: map.logo_accent || '#ff3155',
    });
  });

  // A view counts once per browser session per video; watch time is bounded per call.
  r.post('/videos/:id/view', (req, res) => {
    const video = db.get("SELECT id FROM videos WHERE id = ? AND status = 'published'", [req.params.id]);
    if (!video) return res.status(404).json({ error: { code: 'not_found', message: 'Video not found.' } });
    db.run('UPDATE videos SET views = views + 1, updated_at = ? WHERE id = ?', [nowIso(), video.id]);
    return res.json({ ok: true });
  });

  r.post('/videos/:id/watch', (req, res) => {
    const video = db.get("SELECT id FROM videos WHERE id = ? AND status = 'published'", [req.params.id]);
    if (!video) return res.status(404).json({ error: { code: 'not_found', message: 'Video not found.' } });
    const seconds = Math.max(0, Math.min(Number(req.body?.seconds) || 0, 600));
    db.run('UPDATE videos SET watch_seconds = watch_seconds + ?, updated_at = ? WHERE id = ?', [
      Math.round(seconds),
      nowIso(),
      video.id,
    ]);
    return res.json({ ok: true });
  });

  return r;
}

module.exports = { router: creatorRouter, publicRouter, balanceFor };
