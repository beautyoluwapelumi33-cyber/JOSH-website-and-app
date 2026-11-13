#!/usr/bin/env node
/**
 * JOSH — AdSense integration check.
 *
 * Verifies that the integration is wired correctly and that the existing site
 * is intact: no fake ads, no placeholder credentials, no AdMob SDK, and the
 * ads never sit inside navigation, the header/footer or the video element.
 *
 * Usage: node scripts/verify-adsense.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

const PUBLISHER_RE = /^ca-pub-\d{16}$/;
const SLOT_RE = /^\d{6,20}$/;
const GOOGLE_CERT_AUTHORITY = 'f08c47fec0942fa0';

const failures = [];
const passes = [];
const notes = [];

const fail = (message) => failures.push(message);
const pass = (message) => passes.push(message);

// ---------------------------------------------------------------- main entry
if (!existsSync(join(ROOT, 'index.html'))) {
  fail('index.html (main HTML entry point) is missing.');
  report();
}

const html = read('index.html');
const head = (/<head[^>]*>([\s\S]*?)<\/head>/i.exec(html) || [, ''])[1];
const body = (/<body[^>]*>([\s\S]*?)<\/body>/i.exec(html) || [, ''])[1];

if (head) pass('index.html is the main HTML entry point and has a <head>.');
else fail('index.html has no <head> section.');

// ------------------------------------------------------- head wiring / loader
const configInHead = /<script[^>]+src="adsense-config\.js"/i.test(head);
const layerInHead = /<script[^>]+src="adsense\.js"/i.test(head);
if (configInHead) pass('adsense-config.js is loaded in the website head.');
else fail('adsense-config.js is not loaded in the website head.');
if (layerInHead) pass('adsense.js (AdSense integration) is loaded in the website head.');
else fail('adsense.js is not loaded in the website head.');

if (existsSync(join(ROOT, 'adsense.js'))) {
  const layer = read('adsense.js');
  if (layer.includes('pagead2.googlesyndication.com/pagead/js/adsbygoogle.js')) {
    pass('adsense.js loads the official AdSense tag from googlesyndication.com.');
  } else {
    fail('adsense.js does not reference the official AdSense tag URL.');
  }
  if (/PUBLISHER_RE\s*=\s*\/\^ca-pub-/.test(layer)) pass('adsense.js validates the publisher ID format before loading.');
  else fail('adsense.js does not validate the publisher ID format.');
} else {
  fail('adsense.js is missing.');
}

// A hard-coded loader tag would require committing a real (or fake) client ID.
const staticLoader = /<script[^>]+adsbygoogle\.js\?client=ca-pub-(\d{16}|X+)/i.exec(head);
if (staticLoader) {
  notes.push('index.html contains a static AdSense tag; keep it in sync with adsense-config.js.');
}

// -------------------------------------------------------------- ad placements
const slotPattern = /data-ad-slot="([A-Za-z0-9_]+)"/g;
const foundSlots = new Set();
let slotMatch;
while ((slotMatch = slotPattern.exec(body || html))) foundSlots.add(slotMatch[1]);

for (const required of ['homeTop', 'homeFeed', 'videoBelowPlayer', 'videoSidebar', 'liveTop']) {
  if (foundSlots.has(required)) pass(`Responsive ad placement "${required}" exists in the page markup.`);
  else fail(`Ad placement "${required}" is missing from the page markup.`);
}

// Ads must never sit inside navigation, header, footer or the video element.
const forbidden = [
  ['<nav>...</nav>', /<nav[\s\S]*?<\/nav>/gi],
  ['<header>...</header>', /<header[\s\S]*?<\/header>/gi],
  ['<footer>...</footer>', /<footer[\s\S]*?<\/footer>/gi],
  ['<video>...</video>', /<video[\s\S]*?<\/video>/gi]
];
for (const [label, pattern] of forbidden) {
  const blocks = (body || html).match(pattern) || [];
  const dirty = blocks.filter((block) => /data-ad-slot|<ins class="adsbygoogle"/i.test(block));
  if (dirty.length) fail(`An ad placement is inside ${label}, which must stay separate from ads.`);
  else pass(`No ad placement inside ${label}.`);
}

// Video controls must remain untouched by the ad code.
if (/player\.controls\s*=\s*true/.test(html)) pass('Video player controls are still enabled in the existing upload flow.');
else notes.push('Could not confirm the existing player controls assignment.');

// --------------------------------------------- existing site features intact
for (const id of ['home', 'upload', 'live', 'creator', 'wallet', 'admin']) {
  if (new RegExp(`id="${id}"`).test(html)) pass(`Existing page section "${id}" is still present.`);
  else fail(`Existing page section "${id}" was removed.`);
}
for (const fn of ['showPage', 'uploadVideo', 'searchVideos']) {
  if (new RegExp(`function ${fn}\\s*\\(`).test(html)) pass(`Existing function "${fn}" is still present.`);
  else fail(`Existing function "${fn}" was removed.`);
}
if (/<nav>[\s\S]*?<\/nav>/i.test(body || html)) pass('Primary navigation is intact.');
else fail('Primary navigation is missing.');

// ------------------------------------------------------- configuration state
const configPath = join(ROOT, 'adsense-config.js');
let publisherId = '';
let slots = {};
if (existsSync(configPath)) {
  const config = readFileSync(configPath, 'utf8');
  publisherId = (/publisherId:\s*"([^"]*)"/.exec(config) || [, ''])[1].trim();
  const slotBlock = (/slots:\s*\{([\s\S]*?)\}/.exec(config) || [, ''])[1];
  for (const line of slotBlock.split('\n')) {
    const match = /([A-Za-z]+):\s*"([^"]*)"/.exec(line);
    if (match) slots[match[1]] = match[2].trim();
  }
} else {
  fail('adsense-config.js is missing.');
}

if (!publisherId) {
  pass('No publisher ID configured: ad placements stay hidden and no ad request is made (no placeholder credentials in use).');
  if (/X{4,}/.test(publisherId)) fail('A placeholder publisher ID is configured.');
} else if (PUBLISHER_RE.test(publisherId)) {
  pass(`Configured publisher ID ${publisherId} has a valid AdSense format.`);
} else {
  fail(`Configured publisher ID "${publisherId}" is not a valid ca-pub-################ value.`);
}

for (const [name, value] of Object.entries(slots)) {
  if (!value) continue;
  if (SLOT_RE.test(value)) pass(`Ad unit ID for "${name}" has a valid numeric format.`);
  else fail(`Ad unit ID for "${name}" is not numeric: "${value}".`);
  if (/X{4,}/i.test(value) || /^0+$/.test(value)) fail(`Ad unit ID for "${name}" looks like a placeholder.`);
}

// ------------------------------------------------------------------ ads.txt
const adsTxtPath = join(ROOT, 'ads.txt');
if (!existsSync(adsTxtPath)) {
  fail('ads.txt is missing from the website root.');
} else {
  const adsTxt = readFileSync(adsTxtPath, 'utf8');
  const active = adsTxt.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  const pubMatch = /^ca-pub-(\d{16})$/.exec(publisherId);
  if (pubMatch) {
    const expected = `google.com, pub-${pubMatch[1]}, DIRECT, ${GOOGLE_CERT_AUTHORITY}`;
    if (active.includes(expected)) pass('ads.txt authorises Google AdSense for the configured publisher ID.');
    else fail(`ads.txt is missing the line: ${expected}`);
  } else if (active.length) {
    fail('ads.txt declares a seller while no real publisher ID is configured.');
  } else {
    pass('ads.txt exists at the website root and declares no seller until a real publisher ID is provided.');
  }
  if (active.some((line) => /pub-0{16}|pub-X{16}/i.test(line))) fail('ads.txt contains a placeholder publisher ID as a real seller line.');
}

// --------------------------------------------------- no AdMob on the website
const sources = ['index.html', 'adsense.js', 'adsense-config.js'].filter((file) => existsSync(join(ROOT, file)));
const admobHits = [];
for (const file of sources) {
  const source = read(file);
  if (/ca-app-pub-\d/.test(source)) admobHits.push(`${file}: ca-app-pub- app ID`);
  if (/<script[^>]+admob/i.test(source)) admobHits.push(`${file}: AdMob SDK script`);
  if (/google-mobile-ads|admob-sdk/i.test(source)) admobHits.push(`${file}: AdMob SDK reference`);
}
if (admobHits.length) fail(`AdMob SDK found on the website (Android only): ${admobHits.join('; ')}`);
else pass('No AdMob SDK or AdMob app ID on the website.');

// -------------------------------------------------------------- fake ad check
const bodyHtml = body || html;
if (/<ins[^>]+adsbygoogle[^>]*>[\s\S]*?<img/i.test(bodyHtml)) fail('A hand-written fake ad unit was found in the markup.');
else pass('No hand-written fake advertisement markup.');
if (/class="ad-slot"[^>]*>\s*<(?!span class="ad-label")/.test(bodyHtml)) {
  notes.push('An ad container has content other than the "Advertisement" label before AdSense fills it.');
}

report();

function report() {
  for (const message of passes) console.log(`PASS  ${message}`);
  for (const message of notes) console.log(`NOTE  ${message}`);
  for (const message of failures) console.error(`FAIL  ${message}`);
  console.log(`\n${passes.length} passed, ${failures.length} failed, ${notes.length} note(s).`);
  if (failures.length) {
    console.error('AdSense integration check FAILED.');
    process.exitCode = 1;
  } else {
    console.log('AdSense integration check passed.');
  }
}
