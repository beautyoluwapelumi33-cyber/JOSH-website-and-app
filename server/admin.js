'use strict';

/**
 * Administrator API. Every route below is mounted behind requireAuth + an
 * explicit role check, so creators and anonymous visitors can never read or
 * change platform data. Nothing here invents revenue, earnings or payments:
 * empty tables return zeros and an explanatory note.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('./db');
const adsense = require('./adsense');
const payments = require('./payments');
const { audit, recent } = require('./audit');
const { requireAuth } = require('./auth');
const { badRequest, notFound, conflict, forbidden } = require('./errors');

const CREATOR_SHARE = 0.6;
const PLATFORM_SHARE = 0.4;

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const nowIso = () => new Date().toISOString();
const num = (value) => Number(value || 0);
const round = (value, dp = 6) => Math.round(num(value) * 10 ** dp) / 10 ** dp;
const periodOf = (date) => String(date || '').slice(0, 7);

function publicUserRow(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
  };
}

function router() {
  const r = express.Router();

  // Authentication first, then the role gate. Both are server-side.
  r.use(requireAuth);
  r.use((req, _res, next) => {
    if (!req.user) return next(forbidden());
    if (req.user.role !== 'admin') return next(forbidden('Administrator access required.'));
    next();
  });

  /* ---------------------------------------------------------------- overview */
  r.get(
    '/overview',
    wrap(async (_req, res) => {
      const users = db.get(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END), 0) AS admins,
                COALESCE(SUM(CASE WHEN role = 'creator' THEN 1 ELSE 0 END), 0) AS creators
           FROM users`
      );
      const newUsers = db.get('SELECT COUNT(*) AS total FROM users WHERE created_at >= ?', [
        new Date(Date.now() - 7 * 86400000).toISOString(),
      ]);
      const videos = db.get(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0) AS published,
                COALESCE(SUM(views), 0) AS views,
                COALESCE(SUM(watch_seconds), 0) AS watch_seconds
           FROM videos`
      );
      const live = db.get(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END), 0) AS active,
                COALESCE(SUM(CASE WHEN status = 'live' THEN viewers ELSE 0 END), 0) AS viewers
           FROM livestreams`
      );
      const revenue = db.get(
        `SELECT COALESCE(SUM(estimated_earnings), 0) AS estimated,
                COALESCE(SUM(finalized_earnings), 0) AS finalized,
                COALESCE(SUM(impressions), 0) AS impressions,
                COALESCE(SUM(clicks), 0) AS clicks,
                COALESCE(SUM(page_views), 0) AS page_views
           FROM ad_revenue_daily`
      );
      const manual = db.get(
        `SELECT COALESCE(SUM(estimated_earnings), 0) AS total FROM ad_revenue_daily WHERE is_manual = 1`
      );
      const earnings = db.get(
        `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(DISTINCT user_id) AS creators FROM creator_earnings`
      );
      const withdrawals = db.get(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) AS pending_amount,
                COALESCE(SUM(CASE WHEN status IN ('approved','processing') THEN 1 ELSE 0 END), 0) AS in_flight,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END), 0) AS paid,
                COALESCE(SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END), 0) AS paid_amount,
                COALESCE(SUM(CASE WHEN status IN ('failed','rejected') THEN 1 ELSE 0 END), 0) AS failed
           FROM withdrawals`
      );

      const finalized = num(revenue.finalized);
      const estimated = num(revenue.estimated);
      const lastSync = db.get('SELECT * FROM adsense_sync_runs ORDER BY started_at DESC LIMIT 1');
      const syncErrors = db.get("SELECT COUNT(*) AS total FROM adsense_sync_runs WHERE status = 'error'");

      res.json({
        generatedAt: nowIso(),
        users: {
          total: num(users.total),
          admins: num(users.admins),
          creators: num(users.creators),
          newThisWeek: num(newUsers.total),
        },
        videos: {
          total: num(videos.total),
          published: num(videos.published),
          views: num(videos.views),
          watchHours: round(num(videos.watch_seconds) / 3600, 2),
        },
        livestreams: {
          total: num(live.total),
          active: num(live.active),
          viewers: num(live.viewers),
        },
        revenue: {
          estimated: round(estimated),
          finalized: round(finalized),
          manualEstimated: round(manual.total),
          impressions: num(revenue.impressions),
          clicks: num(revenue.clicks),
          pageViews: num(revenue.page_views),
        },
        sharing: {
          creatorShare: CREATOR_SHARE,
          platformShare: PLATFORM_SHARE,
          creatorPoolFromFinalized: round(finalized * CREATOR_SHARE),
          platformShareFromFinalized: round(finalized * PLATFORM_SHARE),
          creatorPoolFromEstimated: round(estimated * CREATOR_SHARE),
          note: 'Creator earnings are calculated only from finalized Google revenue, never from estimated figures.',
        },
        earnings: {
          credited: round(earnings.total),
          creators: num(earnings.creators),
        },
        withdrawals: {
          total: num(withdrawals.total),
          pending: num(withdrawals.pending),
          pendingAmount: round(withdrawals.pending_amount),
          inFlight: num(withdrawals.in_flight),
          paid: num(withdrawals.paid),
          paidAmount: round(withdrawals.paid_amount),
          failed: num(withdrawals.failed),
        },
        adsense: adsense.status(),
        payments: payments.status(),
        sync: {
          lastRun: lastSync
            ? {
                at: lastSync.finished_at || lastSync.started_at,
                status: lastSync.status,
                message: lastSync.message,
                rowsUpserted: num(lastSync.rows_upserted),
              }
            : null,
          errorCount: num(syncErrors.total),
        },
      });
    })
  );

  /* ------------------------------------------------------------------- users */
  r.get(
    '/users',
    wrap(async (req, res) => {
      const q = String(req.query.q || '').trim();
      const role = ['admin', 'creator'].includes(req.query.role) ? req.query.role : null;
      const where = [];
      const params = [];
      if (q) {
        where.push('(u.email LIKE ? OR u.display_name LIKE ?)');
        params.push(`%${q}%`, `%${q}%`);
      }
      if (role) {
        where.push('u.role = ?');
        params.push(role);
      }
      const rows = db.all(
        `SELECT u.id, u.email, u.display_name, u.role, u.created_at,
                (SELECT COUNT(*) FROM videos v WHERE v.user_id = u.id AND v.status <> 'removed') AS videos,
                (SELECT COALESCE(SUM(v.views), 0) FROM videos v WHERE v.user_id = u.id) AS views,
                (SELECT COALESCE(SUM(v.watch_seconds), 0) FROM videos v WHERE v.user_id = u.id) AS watch_seconds,
                (SELECT COALESCE(SUM(e.amount), 0) FROM creator_earnings e WHERE e.user_id = u.id) AS earnings,
                (SELECT COUNT(*) FROM withdrawals w WHERE w.user_id = u.id) AS withdrawals,
                (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
           FROM users u
           ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
          ORDER BY u.created_at DESC
          LIMIT 200`,
        [nowIso(), ...params]
      );
      res.json({
        users: rows.map((row) => ({
          ...publicUserRow(row),
          videos: num(row.videos),
          views: num(row.views),
          watchHours: round(num(row.watch_seconds) / 3600, 2),
          earnings: round(row.earnings),
          withdrawals: num(row.withdrawals),
          activeSessions: num(row.active_sessions),
        })),
      });
    })
  );

  r.patch(
    '/users/:id/role',
    wrap(async (req, res) => {
      const role = req.body?.role;
      if (!['admin', 'creator'].includes(role)) throw badRequest('invalid_role', 'Role must be admin or creator.');
      const target = db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
      if (!target) throw notFound('That account does not exist.');
      if (target.id === req.user.id && role !== 'admin') {
        throw badRequest('cannot_demote_self', 'You cannot remove your own administrator access.');
      }
      if (target.role !== role) {
        db.run('UPDATE users SET role = ? WHERE id = ?', [role, target.id]);
        audit({
          actorId: req.user.id,
          action: role === 'admin' ? 'admin.grant' : 'admin.revoke',
          target: target.email,
          metadata: { from: target.role, to: role },
        });
      }
      res.json({ user: publicUserRow(db.get('SELECT * FROM users WHERE id = ?', [target.id])) });
    })
  );

  /* ------------------------------------------------------------------ videos */
  r.get(
    '/videos',
    wrap(async (_req, res) => {
      const rows = db.all(
        `SELECT v.*, u.email AS creator_email, u.display_name AS creator_name
           FROM videos v LEFT JOIN users u ON u.id = v.user_id
          ORDER BY v.created_at DESC LIMIT 200`
      );
      res.json({
        videos: rows.map((row) => ({
          id: row.id,
          title: row.title,
          description: row.description,
          sourceUrl: row.source_url,
          thumbnailUrl: row.thumbnail_url,
          visibility: row.visibility,
          status: row.status,
          durationSeconds: num(row.duration_seconds),
          views: num(row.views),
          watchHours: round(num(row.watch_seconds) / 3600, 2),
          creator: row.creator_email ? { id: row.user_id, email: row.creator_email, name: row.creator_name } : null,
          createdAt: row.created_at,
        })),
      });
    })
  );

  r.post(
    '/videos',
    wrap(async (req, res) => {
      const title = String(req.body?.title || '').trim();
      if (title.length < 2) throw badRequest('invalid_title', 'Enter a video title.');
      let userId = null;
      const email = String(req.body?.creatorEmail || '').trim().toLowerCase();
      if (email) {
        const creator = db.get('SELECT id FROM users WHERE email = ?', [email]);
        if (!creator) throw badRequest('unknown_creator', 'No account exists with that creator email.');
        userId = creator.id;
      }
      const visibility = ['public', 'unlisted', 'private'].includes(req.body?.visibility) ? req.body.visibility : 'public';
      const id = crypto.randomUUID();
      const at = nowIso();
      db.run(
        `INSERT INTO videos (id, user_id, title, description, source_url, thumbnail_url, visibility, status, duration_seconds, views, watch_seconds, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, 0, 0, ?, ?)`,
        [
          id,
          userId,
          title,
          String(req.body?.description || '').trim(),
          String(req.body?.sourceUrl || '').trim() || null,
          String(req.body?.thumbnailUrl || '').trim() || null,
          visibility,
          Math.max(0, Math.min(Number(req.body?.durationSeconds) || 0, 60 * 60 * 12)),
          at,
          at,
        ]
      );
      audit({ actorId: req.user.id, action: 'video.create', target: id, metadata: { title, visibility } });
      res.status(201).json({ video: { id, title, visibility, status: 'published' } });
    })
  );

  r.patch(
    '/videos/:id',
    wrap(async (req, res) => {
      const video = db.get('SELECT * FROM videos WHERE id = ?', [req.params.id]);
      if (!video) throw notFound('That video does not exist.');
      const fields = [];
      const params = [];
      if (typeof req.body?.title === 'string' && req.body.title.trim().length >= 2) {
        fields.push('title = ?');
        params.push(req.body.title.trim());
      }
      if (['public', 'unlisted', 'private'].includes(req.body?.visibility)) {
        fields.push('visibility = ?');
        params.push(req.body.visibility);
      }
      if (['published', 'hidden', 'removed'].includes(req.body?.status)) {
        fields.push('status = ?');
        params.push(req.body.status);
      }
      if (!fields.length) throw badRequest('no_changes', 'Nothing to update.');
      fields.push('updated_at = ?');
      params.push(nowIso(), video.id);
      db.run(`UPDATE videos SET ${fields.join(', ')} WHERE id = ?`, params);
      audit({
        actorId: req.user.id,
        action: 'video.update',
        target: video.id,
        metadata: { visibility: req.body?.visibility || null, status: req.body?.status || null },
      });
      res.json({ ok: true });
    })
  );

  r.delete(
    '/videos/:id',
    wrap(async (req, res) => {
      const video = db.get('SELECT * FROM videos WHERE id = ?', [req.params.id]);
      if (!video) throw notFound('That video does not exist.');
      // Soft removal keeps historical views/watch time and never destroys data.
      db.run("UPDATE videos SET status = 'removed', updated_at = ? WHERE id = ?", [nowIso(), video.id]);
      audit({ actorId: req.user.id, action: 'video.remove', target: video.id, metadata: { title: video.title } });
      res.json({ ok: true, status: 'removed' });
    })
  );

  /* -------------------------------------------------------------- livestream */
  r.get(
    '/live',
    wrap(async (_req, res) => {
      const rows = db.all(
        `SELECT l.*, u.email AS creator_email, u.display_name AS creator_name
           FROM livestreams l LEFT JOIN users u ON u.id = l.user_id
          ORDER BY COALESCE(l.started_at, l.created_at) DESC LIMIT 100`
      );
      res.json({
        livestreams: rows.map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          viewers: num(row.viewers),
          startedAt: row.started_at,
          endedAt: row.ended_at,
          createdAt: row.created_at,
          creator: row.creator_email ? { id: row.user_id, email: row.creator_email, name: row.creator_name } : null,
        })),
      });
    })
  );

  r.post(
    '/live',
    wrap(async (req, res) => {
      const title = String(req.body?.title || '').trim();
      if (title.length < 2) throw badRequest('invalid_title', 'Enter a stream title.');
      let userId = null;
      const email = String(req.body?.creatorEmail || '').trim().toLowerCase();
      if (email) {
        const creator = db.get('SELECT id FROM users WHERE email = ?', [email]);
        if (!creator) throw badRequest('unknown_creator', 'No account exists with that creator email.');
        userId = creator.id;
      }
      const id = crypto.randomUUID();
      const at = nowIso();
      db.run(
        `INSERT INTO livestreams (id, user_id, title, status, viewers, started_at, ended_at, created_at, updated_at)
         VALUES (?, ?, ?, 'scheduled', 0, NULL, NULL, ?, ?)`,
        [id, userId, title, at, at]
      );
      audit({ actorId: req.user.id, action: 'live.create', target: id, metadata: { title } });
      res.status(201).json({ livestream: { id, title, status: 'scheduled' } });
    })
  );

  r.patch(
    '/live/:id',
    wrap(async (req, res) => {
      const stream = db.get('SELECT * FROM livestreams WHERE id = ?', [req.params.id]);
      if (!stream) throw notFound('That livestream does not exist.');
      const status = req.body?.status;
      if (!['scheduled', 'live', 'ended', 'blocked'].includes(status)) {
        throw badRequest('invalid_status', 'Status must be scheduled, live, ended or blocked.');
      }
      const at = nowIso();
      const startedAt = status === 'live' ? stream.started_at || at : stream.started_at;
      const endedAt = status === 'ended' ? at : null;
      const viewers = status === 'ended' ? 0 : Math.max(0, Math.min(Number(req.body?.viewers) || 0, 10_000_000));
      db.run('UPDATE livestreams SET status = ?, viewers = ?, started_at = ?, ended_at = ?, updated_at = ? WHERE id = ?', [
        status,
        viewers,
        startedAt,
        endedAt,
        at,
        stream.id,
      ]);
      audit({ actorId: req.user.id, action: 'live.update', target: stream.id, metadata: { status } });
      res.json({ ok: true, status });
    })
  );

  /* ----------------------------------------------------------------- revenue */
  r.get(
    '/revenue',
    wrap(async (req, res) => {
      const days = Math.max(1, Math.min(Number(req.query.days) || 30, 365));
      const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const rows = db.all(
        'SELECT * FROM ad_revenue_daily WHERE period_date >= ? ORDER BY period_date DESC',
        [since]
      );
      const totals = db.get(
        `SELECT COALESCE(SUM(estimated_earnings), 0) AS estimated,
                COALESCE(SUM(finalized_earnings), 0) AS finalized,
                COALESCE(SUM(impressions), 0) AS impressions,
                COALESCE(SUM(clicks), 0) AS clicks,
                COALESCE(SUM(page_views), 0) AS page_views
           FROM ad_revenue_daily WHERE period_date >= ?`,
        [since]
      );
      const monthly = db.all(
        `SELECT substr(period_date, 1, 7) AS period,
                COALESCE(SUM(estimated_earnings), 0) AS estimated,
                COALESCE(SUM(finalized_earnings), 0) AS finalized,
                COALESCE(SUM(impressions), 0) AS impressions,
                COALESCE(SUM(clicks), 0) AS clicks,
                COALESCE(SUM(page_views), 0) AS page_views
           FROM ad_revenue_daily GROUP BY substr(period_date, 1, 7) ORDER BY period DESC LIMIT 24`
      );
      const syncRuns = db.all('SELECT * FROM adsense_sync_runs ORDER BY started_at DESC LIMIT 10');
      const paymentsSnapshot = adsense.paymentsSnapshot();
      res.json({
        days,
        daily: rows.map((row) => ({
          date: row.period_date,
          source: row.source,
          estimated: round(row.estimated_earnings),
          finalized: round(row.finalized_earnings),
          impressions: num(row.impressions),
          clicks: num(row.clicks),
          pageViews: num(row.page_views),
          isManual: Boolean(row.is_manual),
          note: row.note,
        })),
        totals: {
          estimated: round(totals.estimated),
          finalized: round(totals.finalized),
          impressions: num(totals.impressions),
          clicks: num(totals.clicks),
          pageViews: num(totals.page_views),
        },
        monthly: monthly.map((row) => ({
          period: row.period,
          estimated: round(row.estimated),
          finalized: round(row.finalized),
          impressions: num(row.impressions),
          clicks: num(row.clicks),
          pageViews: num(row.page_views),
        })),
        sharing: {
          creatorShare: CREATOR_SHARE,
          platformShare: PLATFORM_SHARE,
          creatorPool: round(num(totals.finalized) * CREATOR_SHARE),
          platformShareAmount: round(num(totals.finalized) * PLATFORM_SHARE),
        },
        adsense: adsense.status(),
        syncRuns: syncRuns.map((row) => ({
          id: row.id,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          status: row.status,
          message: row.message,
          rowsUpserted: num(row.rows_upserted),
        })),
        googlePayments: paymentsSnapshot,
      });
    })
  );

  r.post(
    '/revenue/manual',
    wrap(async (req, res) => {
      const date = String(req.body?.date || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('invalid_date', 'Use a date in YYYY-MM-DD format.');
      const note = String(req.body?.note || '').trim();
      if (note.length < 4) throw badRequest('note_required', 'Describe where this manual figure came from.');
      const estimated = Number(req.body?.estimated);
      if (!Number.isFinite(estimated) || estimated < 0) throw badRequest('invalid_amount', 'Enter a revenue amount of zero or more.');
      const finalizedInput = req.body?.finalized;
      let finalized = 0;
      if (finalizedInput != null && finalizedInput !== '') {
        finalized = Number(finalizedInput);
        if (!Number.isFinite(finalized) || finalized < 0) {
          throw badRequest('invalid_finalized', 'Finalized revenue must be zero or more.');
        }
      }
      const existing = db.get("SELECT * FROM ad_revenue_daily WHERE period_date = ? AND source = 'manual'", [date]);
      if (existing) throw conflict('duplicate_manual_entry', 'A manual revenue entry already exists for that date.');
      db.run(
        `INSERT INTO ad_revenue_daily (period_date, source, currency, estimated_earnings, finalized_earnings, impressions, clicks, page_views, is_manual, note, updated_at)
         VALUES (?, 'manual', 'USD', ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          date,
          round(estimated),
          round(finalized),
          Math.max(0, Number(req.body?.impressions) || 0),
          Math.max(0, Number(req.body?.clicks) || 0),
          Math.max(0, Number(req.body?.pageViews) || 0),
          note,
          nowIso(),
        ]
      );
      audit({ actorId: req.user.id, action: 'revenue.manual', target: date, metadata: { estimated, note } });
      res.status(201).json({ ok: true, manual: true });
    })
  );

  /* --------------------------------------------------- creator view metrics */
  /**
   * Verified eligible views per creator per day. These are the weights used by
   * the 60/40 distribution, so they are recorded explicitly and audited rather
   * than inferred from raw view counters.
   */
  r.post(
    '/metrics',
    wrap(async (req, res) => {
      const email = String(req.body?.email || '').trim().toLowerCase();
      const date = String(req.body?.date || '').trim();
      const views = Number(req.body?.eligibleViews);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw badRequest('invalid_date', 'Use a date in YYYY-MM-DD format.');
      if (!Number.isFinite(views) || views < 0) throw badRequest('invalid_views', 'Eligible views must be zero or more.');
      const creator = db.get('SELECT id FROM users WHERE email = ?', [email]);
      if (!creator) throw notFound('No account exists with that email.');
      const verified = req.body?.verified === false ? 0 : 1;
      db.run(
        `INSERT INTO creator_metrics_daily (user_id, period_date, eligible_views, verified, source, updated_at)
         VALUES (?, ?, ?, ?, 'admin', ?)
         ON CONFLICT(user_id, period_date) DO UPDATE SET
           eligible_views = excluded.eligible_views,
           verified = excluded.verified,
           source = 'admin',
           updated_at = excluded.updated_at`,
        [creator.id, date, Math.round(views), verified, nowIso()]
      );
      audit({ actorId: req.user.id, action: 'metrics.record', target: email, metadata: { date, views, verified } });
      res.status(201).json({ ok: true, email, date, eligibleViews: Math.round(views), verified: Boolean(verified) });
    })
  );

  /* ---------------------------------------------------------------- earnings */
  r.get(
    '/earnings',
    wrap(async (_req, res) => {
      const rows = db.all(
        `SELECT e.*, u.email, u.display_name
           FROM creator_earnings e JOIN users u ON u.id = e.user_id
          ORDER BY e.period DESC, e.amount DESC LIMIT 300`
      );
      const byCreator = db.all(
        `SELECT e.user_id, u.email, u.display_name,
                COALESCE(SUM(e.amount), 0) AS total,
                COUNT(*) AS periods
           FROM creator_earnings e JOIN users u ON u.id = e.user_id
          GROUP BY e.user_id, u.email, u.display_name
          ORDER BY total DESC LIMIT 100`
      );
      const totals = db.get('SELECT COALESCE(SUM(amount), 0) AS total FROM creator_earnings');
      res.json({
        entries: rows.map((row) => ({
          id: row.id,
          period: row.period,
          userId: row.user_id,
          email: row.email,
          displayName: row.display_name,
          grossPool: round(row.gross_pool),
          shareRate: num(row.share_rate),
          amount: round(row.amount),
          eligibleViews: num(row.eligible_views),
          state: row.state,
          createdAt: row.created_at,
        })),
        byCreator: byCreator.map((row) => ({
          userId: row.user_id,
          email: row.email,
          displayName: row.display_name,
          total: round(row.total),
          periods: num(row.periods),
        })),
        totalCredited: round(totals.total),
        sharing: { creatorShare: CREATOR_SHARE, platformShare: PLATFORM_SHARE },
      });
    })
  );

  r.post(
    '/earnings/distribute',
    wrap(async (req, res) => {
      const period = String(req.body?.period || '').trim();
      if (!/^\d{4}-\d{2}$/.test(period)) throw badRequest('invalid_period', 'Use a month in YYYY-MM format.');

      const revenue = db.get(
        `SELECT COALESCE(SUM(finalized_earnings), 0) AS finalized,
                COALESCE(SUM(estimated_earnings), 0) AS estimated
           FROM ad_revenue_daily WHERE substr(period_date, 1, 7) = ?`,
        [period]
      );
      const eligible = num(revenue.finalized);
      if (eligible <= 0) {
        throw conflict(
          'no_finalized_revenue',
          'No finalized Google revenue exists for that month yet. AdSense finalizes revenue at month end, so creator earnings cannot be credited from estimated figures.'
        );
      }
      const pool = round(eligible * CREATOR_SHARE);
      const metrics = db.all(
        `SELECT user_id, COALESCE(SUM(eligible_views), 0) AS views
           FROM creator_metrics_daily
          WHERE substr(period_date, 1, 7) = ? AND verified = 1
          GROUP BY user_id
         HAVING COALESCE(SUM(eligible_views), 0) > 0`,
        [period]
      );
      if (!metrics.length) {
        throw conflict('no_eligible_views', 'No verified creator view data exists for that month, so there is nothing to distribute.');
      }
      const totalViews = metrics.reduce((sum, row) => sum + num(row.views), 0);
      let created = 0;
      let updated = 0;
      let skipped = 0;

      db.tx(() => {
        for (const row of metrics) {
          const amount = round((pool * num(row.views)) / totalViews);
          const existing = db.get('SELECT * FROM creator_earnings WHERE user_id = ? AND period = ?', [row.user_id, period]);
          if (existing && existing.state === 'finalized') {
            skipped += 1; // already credited: never duplicate a creator credit
            continue;
          }
          if (existing) {
            db.run(
              `UPDATE creator_earnings SET gross_pool = ?, share_rate = ?, amount = ?, eligible_views = ?, state = 'finalized', updated_at = ? WHERE id = ?`,
              [pool, CREATOR_SHARE, amount, num(row.views), nowIso(), existing.id]
            );
            updated += 1;
          } else {
            db.run(
              `INSERT INTO creator_earnings (id, user_id, period, gross_pool, share_rate, amount, eligible_views, state, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'finalized', ?, ?)`,
              [crypto.randomUUID(), row.user_id, period, pool, CREATOR_SHARE, amount, num(row.views), nowIso(), nowIso()]
            );
            created += 1;
          }
        }
      });

      audit({
        actorId: req.user.id,
        action: 'earnings.distribute',
        target: period,
        metadata: { eligible, pool, totalViews, created, updated, skipped },
      });
      res.json({ ok: true, period, eligible, pool, totalViews, created, updated, skipped });
    })
  );

  /* ------------------------------------------------------------- withdrawals */
  r.get(
    '/withdrawals',
    wrap(async (req, res) => {
      const status = ['pending', 'approved', 'processing', 'paid', 'failed', 'rejected'].includes(req.query.status)
        ? req.query.status
        : null;
      const rows = db.all(
        `SELECT w.*, u.email, u.display_name
           FROM withdrawals w JOIN users u ON u.id = w.user_id
          ${status ? 'WHERE w.status = ?' : ''}
          ORDER BY w.created_at DESC LIMIT 200`,
        status ? [status] : []
      );
      res.json({
        withdrawals: rows.map((row) => ({
          id: row.id,
          userId: row.user_id,
          email: row.email,
          displayName: row.display_name,
          amount: round(row.amount),
          address: row.address,
          network: row.network,
          status: row.status,
          txHash: row.tx_hash,
          providerRef: row.provider_ref,
          rejectionReason: row.rejection_reason,
          verificationNote: row.verification_note,
          createdAt: row.created_at,
          decidedAt: row.decided_at,
          verifiedAt: row.verified_at,
        })),
        payments: payments.status(),
      });
    })
  );

  r.post(
    '/withdrawals/:id/decide',
    wrap(async (req, res) => {
      const decision = req.body?.decision;
      if (!['approve', 'reject'].includes(decision)) throw badRequest('invalid_decision', 'Decision must be approve or reject.');
      const w = db.get('SELECT * FROM withdrawals WHERE id = ?', [req.params.id]);
      if (!w) throw notFound('That withdrawal does not exist.');
      if (['paid', 'rejected', 'failed'].includes(w.status)) {
        throw conflict('already_settled', 'That withdrawal is already settled.');
      }
      const at = nowIso();
      if (decision === 'approve') {
        db.run("UPDATE withdrawals SET status = 'approved', decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?", [
          req.user.id,
          at,
          at,
          w.id,
        ]);
        audit({ actorId: req.user.id, action: 'withdrawal.approve', target: w.id, metadata: { amount: w.amount } });
        return res.json({ ok: true, status: 'approved' });
      }
      const reason = String(req.body?.reason || '').trim();
      if (reason.length < 3) throw badRequest('reason_required', 'Give a reason for rejecting this withdrawal.');
      db.run(
        "UPDATE withdrawals SET status = 'rejected', rejection_reason = ?, decided_by = ?, decided_at = ?, updated_at = ? WHERE id = ?",
        [reason.slice(0, 500), req.user.id, at, at, w.id]
      );
      audit({ actorId: req.user.id, action: 'withdrawal.reject', target: w.id, metadata: { amount: w.amount, reason } });
      res.json({ ok: true, status: 'rejected' });
    })
  );

  /**
   * Marks a withdrawal paid ONLY when the blockchain proves the USDT transfer.
   * An unverifiable hash leaves the withdrawal in `processing` with the reason
   * recorded, so nothing is ever reported as paid without evidence.
   */
  r.post(
    '/withdrawals/:id/mark-paid',
    wrap(async (req, res) => {
      const w = db.get('SELECT * FROM withdrawals WHERE id = ?', [req.params.id]);
      if (!w) throw notFound('That withdrawal does not exist.');
      if (w.status === 'paid') throw conflict('already_paid', 'That withdrawal is already marked paid.');
      if (['rejected', 'failed'].includes(w.status)) throw conflict('not_payable', 'That withdrawal cannot be paid.');

      const txHash = String(req.body?.txHash || '').trim();
      if (!payments.isTxHash(txHash)) throw badRequest('invalid_tx_hash', 'Enter the BSC transaction hash (0x followed by 64 characters).');
      const duplicate = db.get('SELECT id FROM withdrawals WHERE tx_hash = ? AND id <> ?', [txHash, w.id]);
      if (duplicate) throw conflict('duplicate_tx_hash', 'That transaction hash is already attached to another withdrawal.');

      const verdict = await payments.verifyUsdtTransfer({ txHash, to: w.address, amount: w.amount });
      const at = nowIso();
      const note = verdict.verified
        ? `${verdict.detail} Verified ${verdict.amount} USDT at block ${verdict.blockNumber || 'unknown'}.`
        : `${verdict.reason}: ${verdict.detail}`;

      if (verdict.verified) {
        db.run(
          `UPDATE withdrawals SET status = 'paid', tx_hash = ?, verification_note = ?, verified_at = ?, decided_by = COALESCE(decided_by, ?), updated_at = ? WHERE id = ?`,
          [txHash, note.slice(0, 500), at, req.user.id, at, w.id]
        );
        audit({ actorId: req.user.id, action: 'withdrawal.paid', target: w.id, metadata: { amount: w.amount, txHash } });
        return res.json({ ok: true, status: 'paid', verification: verdict });
      }

      db.run(
        "UPDATE withdrawals SET status = 'processing', tx_hash = ?, verification_note = ?, updated_at = ? WHERE id = ?",
        [txHash, note.slice(0, 500), at, w.id]
      );
      audit({
        actorId: req.user.id,
        action: 'withdrawal.verify_failed',
        target: w.id,
        metadata: { reason: verdict.reason, txHash },
      });
      res.json({ ok: false, status: 'processing', verification: verdict });
    })
  );

  /* ---------------------------------------------------------------- settings */
  const SETTING_KEYS = ['site_name', 'logo_url', 'logo_accent'];

  r.get(
    '/settings',
    wrap(async (_req, res) => {
      const rows = db.all('SELECT key, value, updated_at FROM settings');
      const map = {};
      for (const row of rows) map[row.key] = row.value;
      res.json({
        settings: {
          siteName: map.site_name || 'JOSH',
          logoUrl: map.logo_url || '',
          logoAccent: map.logo_accent || '#ff3155',
        },
        updatedAt: rows.reduce((latest, row) => (row.updated_at > latest ? row.updated_at : latest), null),
      });
    })
  );

  r.put(
    '/settings',
    wrap(async (req, res) => {
      const changes = [];
      const put = (key, value) => {
        db.run(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [key, String(value), nowIso()]
        );
        changes.push(key);
      };
      if (typeof req.body?.siteName === 'string' && req.body.siteName.trim()) put('site_name', req.body.siteName.trim().slice(0, 40));
      if (typeof req.body?.logoAccent === 'string' && /^#[0-9a-fA-F]{6}$/.test(req.body.logoAccent.trim())) {
        put('logo_accent', req.body.logoAccent.trim());
      }
      if (typeof req.body?.logoUrl === 'string') {
        const url = req.body.logoUrl.trim();
        if (url && !/^https?:\/\//i.test(url)) throw badRequest('invalid_logo_url', 'The logo URL must start with http:// or https://');
        put('logo_url', url.slice(0, 500));
      }
      if (!changes.length) throw badRequest('no_changes', 'Nothing to update.');
      audit({ actorId: req.user.id, action: 'settings.update', target: null, metadata: { keys: changes } });
      res.json({ ok: true, updated: changes });
    })
  );

  /* ------------------------------------------------------------------- audit */
  r.get(
    '/audit',
    wrap(async (req, res) => {
      const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
      res.json({
        entries: recent(limit).map((row) => ({
          id: row.id,
          actorEmail: row.actor_email,
          action: row.action,
          target: row.target,
          metadata: row.metadata,
          createdAt: row.created_at,
        })),
      });
    })
  );

  // Unmatched admin routes stay JSON.
  r.use((_req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Unknown administrator route.' } }));

  return r;
}

module.exports = { router, CREATOR_SHARE, PLATFORM_SHARE };
