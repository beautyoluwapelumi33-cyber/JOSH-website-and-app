#!/usr/bin/env node
/**
 * JOSH — production address and AdSense readiness checks.
 *
 * Verifies the server-side behaviour a permanent production domain depends on:
 *
 *   1. The published address is configurable (PUBLIC_SITE_URL) and never a
 *      localhost/preview host.
 *   2. canonical, og:url and twitter:url follow that address.
 *   3. /ads.txt is public, text/plain, and carries the real publisher line only
 *      when a valid ADSENSE_PUBLISHER_ID is configured (never a placeholder).
 *   4. /robots.txt welcomes Mediapartners-Google and AdsBot-Google.
 *   5. The AdSense ownership meta tag and loader are server-injected, so Google
 *      sees them without executing page scripts.
 *   6. The YouTube-style design and public access are untouched.
 *
 * Run: node scripts/verify-production.mjs
 */

import { createRequire } from 'node:module';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const { createApp } = require('../server/index.js');

const PUBLISHER = 'ca-pub-1234567890123456';
const PROD = 'https://www.josh.tv';
const TENANT = 'https://josh.example';

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function clearEnv() {
  delete process.env.PUBLIC_SITE_URL;
  delete process.env.ADSENSE_PUBLISHER_ID;
}

/** The shipped files document examples inside HTML/`#` comments; ignore those. */
const stripComments = (value) => String(value).replace(/<!--[\s\S]*?-->/g, '');
const sellerLines = (value) =>
  String(value)
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

async function main() {
  clearEnv();
  const app = await createApp();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const local = `http://127.0.0.1:${port}`;

  const get = (path, headers = {}) => fetch(`${local}${path}`, { headers, redirect: 'manual' });

  try {
    console.log('\nPublic address resolution');
    const shipped = await (await get('/')).text();
    check('homepage returns HTML with the YouTube layout', shipped.includes('yt-topbar') && shipped.includes('yt-card'));
    check('homepage keeps the JOSH brand colour', shipped.includes('#ff3155'));
    check(
      'no configured domain falls back to the shipped address',
      shipped.includes('rel="canonical" href="https://wypeqn7rsc.dev.onappjet.com/"')
    );

    const tenantHeaders = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'josh.example' };
    const tenant = await (await get('/', tenantHeaders)).text();
    check('canonical follows the requested production host', tenant.includes(`href="${TENANT}/"`));
    check('og:url follows the requested production host', tenant.includes(`property="og:url" content="${TENANT}/"`));
    check('twitter:url follows the requested production host', tenant.includes(`name="twitter:url" content="${TENANT}/"`));

    process.env.PUBLIC_SITE_URL = PROD;
    const prod = await (await get('/', { 'x-forwarded-host': 'ignored.example' })).text();
    check('PUBLIC_SITE_URL overrides the request host', prod.includes(`href="${PROD}/"`));
    check('PUBLIC_SITE_URL wins for og:url too', prod.includes(`property="og:url" content="${PROD}/"`));

    const config = await (await get('/site-config.js')).text();
    check('site-config.js publishes the configured address', config.includes(`publicUrl: '${PROD}'`));
    check('site-config.js keeps the share text', config.includes('shareText'));

    const localHeader = await (await get('/', { 'x-forwarded-host': 'localhost:3000', 'x-forwarded-proto': 'http' })).text();
    check(
      'a localhost host header never becomes the public address',
      !localHeader.includes('href="http://localhost') && localHeader.includes(`href="${PROD}/"`)
    );

    console.log('\nAdSense crawler access');
    const robots = await get('/robots.txt');
    const robotsBody = await robots.text();
    check('/robots.txt is served as text/plain', (robots.headers.get('content-type') || '').includes('text/plain'));
    check('Mediapartners-Google (AdSense crawler) is allowed', /User-agent: Mediapartners-Google[\s\S]*Allow: \//.test(robotsBody));
    check('AdsBot-Google is allowed', /User-agent: AdsBot-Google[\s\S]*Allow: \//.test(robotsBody));
    check('robots.txt points at the sitemap on the production host', robotsBody.includes(`Sitemap: ${PROD}/sitemap.xml`));

    const sitemap = await get('/sitemap.xml');
    const sitemapBody = await sitemap.text();
    check('/sitemap.xml lists the production home URL', sitemapBody.includes(`<loc>${PROD}/</loc>`));

    console.log('\nads.txt');
    delete process.env.ADSENSE_PUBLISHER_ID;
    const adsUnset = await get('/ads.txt');
    const adsUnsetBody = await adsUnset.text();
    check('/ads.txt is public over HTTPS-equivalent and text/plain', adsUnset.status === 200 && (adsUnset.headers.get('content-type') || '').includes('text/plain'));
    check('unconfigured ads.txt claims no seller', !/google\.com,\s*pub-\d+/.test(sellerLines(adsUnsetBody)));

    process.env.ADSENSE_PUBLISHER_ID = PUBLISHER;
    const adsSet = await (await get('/ads.txt')).text();
    check(
      'configured ads.txt carries the real publisher line',
      sellerLines(adsSet).includes(`google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0`)
    );

    console.log('\nAdSense ownership verification');
    const verified = await (await get('/')).text();
    check('google-adsense-account meta tag is server-injected', verified.includes(`<meta name="google-adsense-account" content="${PUBLISHER}">`));
    check('AdSense loader script is server-injected', verified.includes('pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=pub-1234567890123456'));
    check('verification tags sit inside <head>', verified.indexOf('google-adsense-account') < verified.indexOf('</head>'));
    check('design is unchanged by the verification injection', verified.includes('yt-topbar') && verified.includes('yt-feed'));

    process.env.ADSENSE_PUBLISHER_ID = 'ca-pub-XXXXXXXXXXXXXXXX';
    const invalid = await (await get('/')).text();
    const invalidAds = await (await get('/ads.txt')).text();
    check('an invalid publisher ID injects nothing', !stripComments(invalid).includes('name="google-adsense-account" content="ca-pub-XXXXXXXXXXXXXXXX"'));
    check('an invalid publisher ID writes no ads.txt seller line', !/google\.com,\s*pub-/i.test(sellerLines(invalidAds)));

    console.log('\nPublic access and privacy');
    check('homepage is public without a session', (await get('/')).status === 200);
    check('ads.txt is public without a session', (await get('/ads.txt')).status === 200);
    check('admin/API paths are not exposed as static files', (await get('/server/index.js')).status === 404);
    check('package manifest is not exposed', (await get('/package.json')).status === 404);
    check('health endpoint still answers', (await get('/api/health')).status === 200);
  } finally {
    clearEnv();
    server.close();
  }

  console.log(`\n${failures.length ? 'FAILED' : 'PASSED'}: ${passed} checks passed, ${failures.length} failed.`);
  if (failures.length) {
    for (const name of failures) console.log(` - ${name}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[verify-production] crashed:', err);
  process.exitCode = 1;
});
