'use strict';

/**
 * Production public-address resolution for JOSH.
 *
 * The website is served from one origin, but that origin must not be baked into
 * the HTML: a development/preview host is not a permanent production address and
 * Google AdSense needs the real published domain for review, ads.txt and
 * ownership verification.
 *
 * Resolution order for every generated link:
 *   1. PUBLIC_SITE_URL          (Settings -> Environment variables, e.g. https://josh.tv)
 *   2. the request's own host   (x-forwarded-proto / x-forwarded-host, then host)
 *   3. FALLBACK_PUBLIC_URL      (the current AppJet address, so nothing breaks)
 *
 * Localhost, 127.0.0.1, 0.0.0.0 and *.local are never accepted as a public
 * address, so a shared or canonical link can never point at a dev machine.
 *
 * Design rule: this module only rewrites URLs, ad-verification tags and crawler
 * files. It never changes the website's markup or styling.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FALLBACK_PUBLIC_URL = 'https://wypeqn7rsc.dev.onappjet.com';

/** Hosts that must never become the public address. */
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|.*\.local)$/i;

/** AdSense publisher IDs are `ca-pub-` followed by exactly 16 digits. */
const PUBLISHER_RE = /^ca-pub-\d{16}$/;

/** Google's own certification authority ID, required in the ads.txt line. */
const ADS_TXT_AUTHORITY = 'f08c47fec0942fa0';

function normalizeOrigin(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (LOCAL_HOST.test(url.hostname)) return null;
    if (!url.hostname.includes('.')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The operator-configured production address, if one is set and valid. */
function configuredPublicUrl() {
  return normalizeOrigin(process.env.PUBLIC_SITE_URL);
}

function requestOrigin(req) {
  if (!req || !req.headers) return null;
  const proto =
    String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() ||
    (req.secure ? 'https' : 'http');
  const host =
    String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() ||
    req.headers.host ||
    '';
  return normalizeOrigin(`${proto}://${host}`);
}

function resolvePublicUrl(req) {
  return configuredPublicUrl() || requestOrigin(req) || FALLBACK_PUBLIC_URL;
}

/**
 * Point the canonical, Open Graph and Twitter URLs at the resolved public origin.
 * The static file ships with FALLBACK_PUBLIC_URL in exactly those places.
 */
function rewritePublicLinks(html, base) {
  if (!html || !base || base === FALLBACK_PUBLIC_URL) return html;
  return String(html).split(FALLBACK_PUBLIC_URL).join(base);
}

/** Validated AdSense publisher ID from the environment, or null. */
function adsensePublisher() {
  const raw = String(process.env.ADSENSE_PUBLISHER_ID || '').trim();
  return PUBLISHER_RE.test(raw) ? raw : null;
}

/**
 * AdSense ownership-verification tags.
 *
 * Google's review fetches the HTML without executing page scripts, so the meta
 * tag and loader are injected server-side when a real publisher ID is configured.
 * Without a valid ID nothing is added: no placeholder credential is ever served.
 */
function adsenseHeadTags() {
  const pub = adsensePublisher();
  if (!pub) return '';
  const client = pub.replace(/^ca-/, '');
  return [
    `<!-- Google AdSense ownership verification (server-injected from ADSENSE_PUBLISHER_ID). -->`,
    `<meta name="google-adsense-account" content="${pub}">`,
    `<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${client}" crossorigin="anonymous"></script>`,
  ].join('\n');
}

function injectAdsenseVerification(html) {
  const tags = adsenseHeadTags();
  if (!tags || !html) return html;
  const pub = adsensePublisher();
  // Already active in the markup? Then do not duplicate it.
  if (html.includes(`name="google-adsense-account" content="${pub}"`)) return html;
  if (!html.includes('</head>')) return html;
  return html.replace('</head>', `${tags}\n</head>`);
}

/** The full index.html as it must be served for this origin. */
function renderIndex(base) {
  const file = path.join(ROOT, 'index.html');
  let html;
  try {
    html = fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  return injectAdsenseVerification(rewritePublicLinks(html, base));
}

/** site-config.js with the resolved public address substituted in. */
function siteConfigJs(base) {
  const file = path.join(ROOT, 'site-config.js');
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    return `window.JOSH_SITE = ${JSON.stringify({ name: 'JOSH', publicUrl: base })};\n`;
  }
  if (!base) return src;
  return src.replace(/publicUrl:\s*'[^']*'/, `publicUrl: '${base}'`);
}

/**
 * ads.txt at the website root.
 *
 * A configured ADSENSE_PUBLISHER_ID wins; otherwise the checked-in file is served
 * unchanged (it either already carries the real seller line written by
 * scripts/setup-adsense.mjs, or explains that no publisher is configured yet).
 */
function adsTxtBody() {
  const pub = adsensePublisher();
  if (pub) {
    const seller = pub.replace(/^ca-/, '');
    return [
      '# ads.txt - Authorized Digital Sellers for this website',
      '# Generated at request time from ADSENSE_PUBLISHER_ID.',
      '# Publicly readable over HTTPS, as Google requires.',
      `google.com, ${seller}, DIRECT, ${ADS_TXT_AUTHORITY}`,
      '',
    ].join('\n');
  }
  try {
    return fs.readFileSync(path.join(ROOT, 'ads.txt'), 'utf8');
  } catch {
    return '';
  }
}

/** robots.txt that explicitly welcomes Google's AdSense crawlers. */
function robotsTxt(base) {
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    '',
    '# Google AdSense crawler: must be able to read the public pages.',
    'User-agent: Mediapartners-Google',
    'Allow: /',
    '',
    '# Google Ads landing-page crawler.',
    'User-agent: AdsBot-Google',
    'Allow: /',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}

/** Minimal sitemap for the single-page site. */
function sitemapXml(base) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <url>',
    `    <loc>${base}/</loc>`,
    '    <changefreq>daily</changefreq>',
    '  </url>',
    '</urlset>',
    '',
  ].join('\n');
}

module.exports = {
  ROOT,
  FALLBACK_PUBLIC_URL,
  PUBLISHER_RE,
  normalizeOrigin,
  configuredPublicUrl,
  requestOrigin,
  resolvePublicUrl,
  rewritePublicLinks,
  adsensePublisher,
  adsenseHeadTags,
  injectAdsenseVerification,
  renderIndex,
  siteConfigJs,
  adsTxtBody,
  robotsTxt,
  sitemapXml,
};
