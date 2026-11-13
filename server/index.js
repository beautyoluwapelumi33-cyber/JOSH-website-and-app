'use strict';

/**
 * JOSH server entry point.
 *
 * Serves the existing static site (index.html and its assets) exactly as it is,
 * and exposes the secure API modules that already exist in this folder:
 *   - /api/auth/*     account registration, sign-in, session, sign-out
 *   - /api/adsense/*  administrator-only AdSense status, authorization, sync
 *
 * Design rule: this file must never change the website's markup or styling.
 * It only serves the files in the repository root over HTTP.
 */

const path = require('path');
const express = require('express');

const db = require('./db');
const auth = require('./auth');
const adsense = require('./adsense');
const siteUrl = require('./site-url');
const { ApiError } = require('./errors');
const adminRoutes = require('./admin');
const creatorRoutes = require('./creator');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.JOSH_DB_FILE || path.join(process.env.JOSH_DATA_DIR || '/tmp', 'josh.sqlite');

/**
 * Backend source, dependencies and tooling live next to the public files, so the
 * static handler must never expose them. Anything not meant for a browser 404s.
 */
const PRIVATE_PATH = /^\/(server|scripts|supabase|tests|node_modules)(\/|$)|^\/(package(-lock)?\.json|Dockerfile|README[\w.-]*\.md|\.git|\.env[\w.]*)/i;

function blockPrivateFiles(req, res, next) {
  if (PRIVATE_PATH.test(req.path)) return res.status(404).type('text/plain').send('Not found');
  next();
}

function adsenseRoutes() {
  const r = express.Router();

  // Advertiser-side integration state: configured / awaiting approval / error.
  r.get('/adsense/status', auth.requireRole('admin'), (req, res) => res.json(adsense.status()));

  // Returns the Google consent URL; the administrator is redirected by the browser.
  r.get('/adsense/authorize', auth.requireRole('admin'), async (req, res, next) => {
    try {
      res.json({ url: await adsense.authorizeUrl(req) });
    } catch (err) {
      next(err);
    }
  });

  // Google redirects here with an authorization code. Never a browser-facing JSON call.
  r.get('/adsense/callback', async (req, res, next) => {
    try {
      await adsense.handleCallback({ code: req.query.code, state: req.query.state, req });
      res.redirect('/?adsense=connected');
    } catch (err) {
      next(err);
    }
  });

  r.post('/adsense/sync', auth.requireRole('admin'), async (req, res, next) => {
    try {
      const days = Number(req.body && req.body.days) || 30;
      res.json(await adsense.sync({ days, actorId: req.user.id }));
    } catch (err) {
      next(err);
    }
  });

  r.get('/adsense/payments', auth.requireRole('admin'), async (req, res, next) => {
    try {
      res.json(await adsense.paymentsSnapshot());
    } catch (err) {
      next(err);
    }
  });

  return r;
}

/**
 * Public-address, crawler and AdSense-verification routes.
 *
 * Registered before the static handler so a configured production domain
 * (PUBLIC_SITE_URL) wins over the address that ships inside the files. These
 * routes only change URLs, crawler files and verification tags — never markup
 * or styling.
 */
function siteRoutes() {
  const r = express.Router();

  // Google's AdSense crawler must be able to read the public pages.
  r.get('/robots.txt', (req, res) =>
    res.type('text/plain').send(siteUrl.robotsTxt(siteUrl.resolvePublicUrl(req)))
  );

  r.get('/sitemap.xml', (req, res) =>
    res.type('application/xml').send(siteUrl.sitemapXml(siteUrl.resolvePublicUrl(req)))
  );

  // Google fetches https://<domain>/ads.txt over HTTPS before serving ads.
  r.get('/ads.txt', (req, res) => res.type('text/plain').send(siteUrl.adsTxtBody()));

  // Share links, canonical and Open Graph URLs all come from this one value.
  r.get('/site-config.js', (req, res) =>
    res.type('application/javascript').send(siteUrl.siteConfigJs(siteUrl.resolvePublicUrl(req)))
  );

  r.get(['/', '/index.html'], (req, res) =>
    res.type('html').send(siteUrl.renderIndex(siteUrl.resolvePublicUrl(req)))
  );

  return r;
}

function bootstrapOwnerAdmin() {
  const email = (process.env.JOSH_ADMIN_EMAIL || '').trim();
  const password = process.env.JOSH_ADMIN_PASSWORD || '';
  if (!email) {
    console.log('[josh] JOSH_ADMIN_EMAIL is not set, so no owner administrator is bootstrapped.');
    return;
  }
  try {
    const result = auth.ensureAdmin({ email, password, displayName: process.env.JOSH_ADMIN_NAME || 'JOSH Owner' });
    if (result.created) console.log('[josh] owner administrator created:', result.user.email);
    else if (result.promoted) console.log('[josh] existing account promoted to administrator:', result.user.email);
    else console.log('[josh] owner administrator present:', result.user.email);
  } catch (err) {
    // A weak or missing password must not stop the website from serving.
    console.error('[josh] administrator bootstrap skipped:', err.message);
  }
}

async function createApp() {
  await db.open(DATA_FILE);
  bootstrapOwnerAdmin();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.use(express.json({ limit: '100kb' }));

  app.use(blockPrivateFiles);
  app.use(auth.attachUser);

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.use('/api/auth', auth.router());
  // One-time owner claim; refuses as soon as an administrator exists.
  app.use('/api/setup', auth.setupRouter());
  app.use('/api/admin', adminRoutes.router());
  app.use('/api/creator', creatorRoutes.router());
  app.use('/api', creatorRoutes.publicRouter());
  app.use('/api', adsenseRoutes());

  // Unknown API paths must stay JSON so the page never parses HTML as an error body.
  app.use('/api', (req, res) =>
    res.status(404).json({ error: { code: 'not_found', message: 'Unknown API route.' } })
  );

  // Domain-aware crawler files, ads.txt, site config and the HTML entry point.
  app.use(siteRoutes());

  // The existing website, served unchanged.
  app.use(express.static(ROOT, { extensions: ['html'], index: 'index.html', dotfiles: 'ignore', maxAge: 0 }));
  app.get('*', (req, res) =>
    res.type('html').send(siteUrl.renderIndex(siteUrl.resolvePublicUrl(req)))
  );

  app.use((err, req, res, _next) => {
    const known = err instanceof ApiError;
    const status = known ? err.status : 500;
    const body = {
      error: {
        code: (known && err.code) || 'server_error',
        message: known ? err.message : 'Something went wrong. Please try again.',
      },
    };
    if (known && err.details) body.error.details = err.details;
    if (!known) console.error('[josh] unhandled error:', err);
    res.status(status).json(body);
  });

  return app;
}

if (require.main === module) {
  createApp()
    .then((app) => {
      app.listen(PORT, '0.0.0.0', () => {
        console.log(`[josh] listening on http://0.0.0.0:${PORT}`);
      });
    })
    .catch((err) => {
      console.error('[josh] failed to start:', err);
      process.exit(1);
    });
}

module.exports = { createApp, PORT };
