#!/usr/bin/env node
/**
 * Verifies the Share JOSH wiring.
 *
 *  - the configured publish link is the official public website URL;
 *  - a preview/localhost address can never be used as the shared link;
 *  - every share target builds a real provider URL containing that link;
 *  - index.html carries the canonical/social metadata and the share dialog;
 *  - the admin entry stays hidden from the public page.
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
if (/<button class="hidden" data-admin-entry/.test(indexHtml)) {
  pass('The admin entry is hidden from the public navigation.');
} else {
  fail('The admin entry is still visible to every visitor.');
}
if (/data-admin-panel hidden/.test(indexHtml)) {
  pass('Administrator panels stay locked until an admin session is confirmed.');
} else {
  fail('Administrator panels are not gated.');
}
if (/fetch\('\/api\/auth\/me'/.test(indexHtml) && /role==='admin'/.test(indexHtml)) {
  pass('The admin entry is only revealed for a server-confirmed admin role.');
} else {
  fail('The admin entry is not gated by a server-side admin role check.');
}

const failed = results.filter(([status]) => status === 'FAIL');
for (const [status, message] of results) console.log(`${status}  ${message}`);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) process.exitCode = 1;
