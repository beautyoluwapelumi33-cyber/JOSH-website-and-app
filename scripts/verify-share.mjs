#!/usr/bin/env node
/**
 * Verifies the Share JOSH wiring.
 *
 *  - the configured publish link is the official public website URL;
 *  - a preview/localhost address can never be used as the shared link;
 *  - every share target builds a real provider URL containing that link;
 *  - index.html carries the canonical/social metadata and the share dialog;
 *  - the Admin navigation entry is restored while the dashboard stays gated.
 *
 * Run with: node scripts/verify-share.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const pass = (message) => results.push(['PASS', message]);
const fail = (message) => results.push(['FAIL', message]);

const configPath = path.join(root, 'site-config.js');
const sharePath = path.join(root, 'share.js');
const indexPath = path.join(root, 'index.html');

const configSource = fs.readFileSync(configPath, 'utf8');
const shareSource = fs.readFileSync(sharePath, 'utf8');
const indexHtml = fs.readFileSync(indexPath, 'utf8');

/** Runs site-config.js + share.js against a minimal DOM and returns the window. */
function loadShare(overrides = {}) {
  const document = {
    readyState: 'complete',
    head: { appendChild() {} },
    createElement: () => ({
      style: {},
      setAttribute() {},
      appendChild() {},
      addEventListener() {},
      classList: { add() {}, remove() {} },
    }),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    execCommand: () => false,
  };
  const window = {};
  const context = vm.createContext({
    window,
    document,
    navigator: {},
    console,
    URL,
    encodeURIComponent,
    setTimeout,
    module: {},
  });
  vm.runInContext(configSource, context, { filename: 'site-config.js' });
  if (overrides.publicUrl !== undefined) {
    window.JOSH_SITE = Object.assign({}, window.JOSH_SITE, { publicUrl: overrides.publicUrl });
  }
  vm.runInContext(shareSource, context, { filename: 'share.js' });
  return window;
}

// 1. Configured publish link.
const share = loadShare();
const configured = String((share.JOSH_SITE && share.JOSH_SITE.publicUrl) || '').trim();
if (!configured) {
  fail('site-config.js has no publicUrl, so the publish link would still be unset.');
} else if (!/^https?:\/\//i.test(configured)) {
  fail(`publicUrl "${configured}" is not an absolute http(s) URL.`);
} else {
  pass(`Official publish link is configured: ${configured}`);
}

const official = share.joshPublicUrl();
if (!official) {
  fail('share.js cannot resolve the official public link.');
} else if (official !== new URL(configured).toString()) {
  fail(`share.js resolved "${official}" instead of the configured publish link.`);
} else {
  pass(`Share JOSH uses the configured public link (${official}).`);
}

// 2. Preview / localhost links must never become the shared link.
for (const preview of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://0.0.0.0:3000', 'http://josh.local']) {
  const candidate = loadShare({ publicUrl: preview });
  if (candidate.joshPublicUrl() === null) {
    pass(`Preview address ${preview} is rejected as a publish link.`);
  } else {
    fail(`Preview address ${preview} was accepted as the public link.`);
  }
}

if (/location\.href/.test(shareSource)) {
  fail('share.js reads location.href, so a preview address could leak into shares.');
} else {
  pass('share.js never derives the shared link from the current browser address.');
}

// 3. Every target builds a real provider URL containing the official link.
if (!official) {
  fail('Share targets cannot be checked without a resolved public link.');
} else {
  const encoded = encodeURIComponent(official);
  const expectations = [
    ['whatsapp', (link) => link.startsWith('https://wa.me/?text=') && link.includes(encoded)],
    ['facebook', (link) => link.startsWith('https://www.facebook.com/sharer/sharer.php?u=') && link.includes(encoded)],
    ['telegram', (link) => link.startsWith('https://t.me/share/url?url=') && link.includes(encoded)],
    ['x', (link) => link.startsWith('https://twitter.com/intent/tweet?') && link.includes(encoded)],
    ['email', (link) => link.startsWith('mailto:?subject=') && link.includes(encoded)],
  ];
  for (const [id, ok] of expectations) {
    const link = share.joshShareLink(id);
    if (!link) fail(`Share target "${id}" produced no link.`);
    else if (!ok(link)) fail(`Share target "${id}" produced an unexpected link: ${link}`);
    else pass(`Share target "${id}" links to the official site.`);
  }
  if (share.joshShareLink('unknown')) fail('Unknown share target returned a link.');
  else pass('Unknown share targets are ignored.');
}

// 4. Page wiring.
const checks = [
  [/<link rel="canonical" href="https:\/\/[^"]+"/, 'index.html declares a canonical publish link.'],
  [/<meta property="og:url" content="https:\/\/[^"]+"/, 'index.html declares the Open Graph publish URL.'],
  [/id="shareJoshBtn"/, 'index.html has a Share JOSH button.'],
  [/id="shareDialog"/, 'index.html contains the share dialog.'],
  [/id="shareUrlField"/, 'The share dialog shows the official link field.'],
  [/<script src="site-config\.js"><\/script>/, 'index.html loads the site configuration.'],
  [/<script src="share\.js"><\/script>/, 'index.html loads the share module.'],
];
for (const [pattern, message] of checks) {
  if (pattern.test(indexHtml)) pass(message);
  else fail(`Missing: ${message}`);
}

const canonicalHref = (/<link rel="canonical" href="([^"]+)"/.exec(indexHtml) || [, ''])[1];
const ogUrl = (/<meta property="og:url" content="([^"]+)"/.exec(indexHtml) || [, ''])[1];
if (canonicalHref && canonicalHref !== ogUrl) {
  fail(`canonical (${canonicalHref}) and og:url (${ogUrl}) disagree.`);
} else if (canonicalHref) {
  pass('Canonical and Open Graph URLs point at the same publish link.');
}

// 5. Admin stays private.
if (/<button[^>]*data-admin-entry[^>]*onclick="showPage\('admin',this\)"[\s\S]{0,400}?Admin<\/button>/.test(indexHtml)) {
  pass('The Admin entry sits in the YouTube-style sidebar navigation.');
} else {
  fail('The Admin navigation entry is missing from the sidebar.');
}
/* YouTube homepage layout tokens plus the white light theme. */
[
  ['body{margin:0;background:#ffffff;color:#0f0f0f;font-family:Arial,sans-serif}', 'the white light theme, Arial font and dark text colours are in place'],
  ['header.yt-topbar{height:56px;background:#ffffff', 'the YouTube 56px white app bar is in place'],
  ['.logo{font-size:27px;font-weight:900;color:#ff3155}', 'the JOSH logo typography and colour are unchanged'],
  ['.yt-feed{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr))', 'the YouTube-style video grid is in place'],
  ['.yt-thumb{position:relative;aspect-ratio:16/9', 'video thumbnails use YouTube-style 16:9 cards'],
  ['.primary{background:#ff3155;color:white}', 'the JOSH button styling is unchanged'],
  ['.yt-chip.active{background:#0f0f0f;color:#ffffff}', 'the YouTube category chip row is styled'],
  ['@media(min-width:1000px){.yt-body{grid-template-columns:240px minmax(0,1fr)}', 'the desktop 240px sidebar rail is in place'],
  ['.panel{background:#ffffff;border:1px solid #e5e5e5', 'panels are white with light grey borders'],
  ['input,textarea,select{background:#ffffff;border:1px solid #d9d9d9;color:#0f0f0f', 'form fields use white surfaces with dark text'],
  ['.watch-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}', 'the video player page layout is unchanged'],
  ['@media(min-width:900px){.watch-layout{grid-template-columns:minmax(0,1fr) 300px}}', 'the responsive 300px watch sidebar is unchanged'],
  ['@media(max-width:899px){.ad-slot[data-ad-slot="videoSidebar"]{display:none!important}}', 'mobile ad behaviour is unchanged'],
  ['footer{text-align:center;padding:30px;color:#606060;border-top:1px solid #e5e5e5;background:#ffffff}', 'the footer uses a white surface with a light grey separator']
].forEach(function(pair){
  if (indexHtml.indexOf(pair[0]) !== -1) pass('Design ok: ' + pair[1] + '.');
  else fail('Design missing: ' + pair[1] + '.');
});

/* The YouTube top bar search must keep driving the feed filter. */
if (/id="search"[^>]*oninput="searchVideos\(\)"/.test(indexHtml)) {
  pass('The top-bar search still filters the video feed.');
} else {
  fail('The top-bar search is not wired to the feed.');
}
if (/class="yt-chip active"/.test(indexHtml) && /function filterChip\(/.test(indexHtml)) {
  pass('The category chip row filters the feed.');
} else {
  fail('The category chip row is not wired to the feed.');
}

/* Advertisements must stay outside the navigation and the video controls. */
const navBlock = (/<aside class="yt-nav"[\s\S]*?<\/aside>/.exec(indexHtml) || [''])[0];
if (navBlock && navBlock.indexOf('ad-slot') === -1) {
  pass('No advertisement sits inside the sidebar navigation.');
} else {
  fail('An advertisement was placed inside the sidebar navigation.');
}
for (const slot of ['homeTop', 'homeFeed', 'videoBelowPlayer', 'videoSidebar', 'liveTop']) {
  if (new RegExp('data-ad-slot="' + slot + '"').test(indexHtml)) pass('Ad slot "' + slot + '" is still present.');
  else fail('Ad slot "' + slot + '" is missing.');
}

/* No dark-theme surfaces may survive anywhere in the page. */
const darkTokens = ['#0e1015', '#171a22', '#1b1f29', '#20242e', '#252b38', '#292e39', '#343b57', '#343947', '#393e4a', '#444b5b', '#8c315a'];
const remainingDark = darkTokens.filter(function(token){ return indexHtml.toLowerCase().indexOf(token) !== -1; });
if (remainingDark.length === 0) pass('No dark-theme surface colours remain in the page.');
else fail('Dark-theme colours are still present: ' + remainingDark.join(', ') + '.');

/* Long videos: nothing may cap duration, so 3h+ playback stays possible. */
if (!/maxduration|durationlimit|max_duration|maxLength\s*=\s*[\d]+\s*\*\s*60/i.test(indexHtml)) {
  pass('No duration cap is applied, so 3-hour and longer videos remain supported.');
} else {
  fail('A duration cap was introduced, which would break 3-hour and longer videos.');
}

/* Logo: the single authorised visual change. */
if ((indexHtml.match(/class="josh-mark"/g) || []).length >= 2) pass('The new JOSH logo mark is applied in the header and footer.');
else fail('The new JOSH logo mark is missing from the header or footer.');
if (indexHtml.indexOf('▶ JOSH') === -1) pass('The old text logo has been replaced by the new logo.');
else fail('The old text logo is still present.');
if (/rel="icon" type="image\/svg\+xml"/.test(indexHtml)) pass('The JOSH favicon uses the new logo mark.');
else fail('The JOSH favicon is missing.');
if (/<section id="home">/.test(indexHtml) && /id="videos"/.test(indexHtml)) pass('The homepage and video feed sections are intact.');
else fail('The homepage or video feed section is missing.');
if (/<aside class="yt-nav"/.test(indexHtml) && /id="ytMenuBtn"/.test(indexHtml)) pass('The homepage carries the YouTube sidebar and its hamburger toggle.');
else fail('The YouTube sidebar or its hamburger toggle is missing.');
if (/class="yt-card"/.test(indexHtml) && /class="yt-avatar"/.test(indexHtml)) pass('Feed cards use the YouTube thumbnail, avatar and title layout.');
else fail('Feed cards are missing the YouTube layout.');

if (/data-admin-panel hidden/.test(indexHtml)) {
  pass('Administrator panels stay locked until an admin session is confirmed.');
} else {
  fail('Administrator panels are not gated.');
}
if (/api\('\/api\/auth\/me'\)/.test(indexHtml) && /role==='admin'/.test(indexHtml)) {
  pass('The admin dashboard is only unlocked for a server-confirmed admin role.');
} else {
  fail('The admin entry is not gated by a server-side admin role check.');
}

const failed = results.filter(([status]) => status === 'FAIL');
for (const [status, message] of results) console.log(`${status}  ${message}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
