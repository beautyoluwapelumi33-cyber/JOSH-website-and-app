# JOSH — permanent production address, custom domain and AdSense verification

This document explains how to give JOSH a permanent production address, and how to make
Google AdSense able to crawl the site and verify ownership. **No website design, layout or
feature has been changed** by any of this work — only URL configuration, crawler files and
verification tags.

---

## 0. Read this first: the current plan

| Item | Status |
| --- | --- |
| Current address | `https://wypeqn7rsc.dev.onappjet.com` — an AppJet **development/testing** address |
| Account plan | **Free** |
| Custom domain | **Not included in Free** — needs **Starter ($5/month)** or **Pro** |
| Code readiness for a real domain | **Done** (see sections 2–4) |
| Your AdSense publisher ID | **Still needed** — nothing is faked until you provide it |

A custom domain cannot be created on the Free plan, and I will not fake one or point DNS at a
workaround. To unlock it: **Settings → Billing → Starter ($5/month) or Pro**.

The development URL keeps working meanwhile, so nothing is broken — but for AdSense review you
want the branded domain, and Google prefers a domain you control.

---

## 1. Connect the custom domain (after upgrading)

1. **Buy/keep a domain** (e.g. `josh.tv`, `watchjosh.com`) from any registrar. A `.com`/`.tv`
   is fine; the domain must be one you control.
2. In AppJet: **Settings → Domains → Add domain**, and enter the domain (add `www.` as a second
   entry if you want both to work).
3. AppJet then shows the **exact DNS records** for that domain. Create them at your registrar:
   - a **CNAME** for `www` (or the subdomain) pointing to the target shown in Settings, and/or
   - **A/ALIAS** records for the apex (`@`) pointing to the IP(s) shown in Settings.
   Copy the values from Settings — do not guess them, they are account-specific.
4. Wait for DNS propagation (usually minutes, up to 24 h). AppJet issues the TLS certificate
   automatically once DNS resolves.
5. Confirm the domain serves the site: open `https://your-domain/` in a browser.

> Large-scale production instead of AppJet hosting: deploy the same `appjet` branch at
> **https://qoddi.com** (select branch `appjet`), which also supports custom domains. Do not
> migrate without deciding that first — AppJet hosting is intended for development and testing.

---

## 2. Point JOSH at the production address (one variable)

All generated links read a single value, resolved in this order:

1. `PUBLIC_SITE_URL` (environment variable)
2. the request's own host (`x-forwarded-proto` / `x-forwarded-host`)
3. the shipped fallback address (`https://wypeqn7rsc.dev.onappjet.com`)

So after the domain is connected, add one variable in
**Settings → Environment variables**:

```
PUBLIC_SITE_URL = https://your-domain.com
```

Then redeploy. From that moment:

- `<link rel="canonical">`, `og:url` and `twitter:url` use the production domain;
- `site-config.js` publishes it, so **Share JOSH** links and the admin "publish link" field use it;
- `robots.txt` and `sitemap.xml` reference it;
- a `localhost`, `127.0.0.1` or `*.local` host header is **never** accepted as the public address.

Nothing in the HTML/CSS/JS layout changes: the server substitutes only those URLs.

---

## 3. Make AdSense able to crawl and verify JOSH

Add your real publisher ID (`ca-pub-` + 16 digits, from AdSense → Account → Settings → Account
information) in **Settings → Environment variables**:

```
ADSENSE_PUBLISHER_ID = ca-pub-1234567890123456
```

When that value is valid, the server injects into `<head>` on every page load:

```html
<meta name="google-adsense-account" content="ca-pub-1234567890123456">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=pub-1234567890123456" crossorigin="anonymous"></script>
```

and serves this at `https://your-domain/ads.txt`:

```
google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0
```

Injection is server-side on purpose: Google's review fetches the HTML **without running page
scripts**, so the meta tag must already be in the response. An invalid or missing ID injects
nothing at all — no placeholder credential is ever served.

`/robots.txt` is now served explicitly and welcomes Google's crawlers:

```
User-agent: Mediapartners-Google   → Allow: /
User-agent: AdsBot-Google          → Allow: /
```

All public pages (home, watch, live, share) remain reachable without a session; only
`/api/*` and the admin dashboard require authentication. Nothing behind a login can be
reviewed by AdSense, which is why the public pages stay open.

### Verification steps in AdSense

1. AdSense → **Sites** → **Add site** → enter `your-domain.com`.
2. Choose **one** verification method:
   - **AdSense code snippet / meta tag** — already served by `ADSENSE_PUBLISHER_ID` (recommended);
   - **ads.txt snippet** — already served once the publisher ID is configured;
   - **DNS record** — add the TXT record Google shows at your registrar (alternative if the
     others are unavailable).
3. Click **Verify**, then **Request review**. Review can take days to a few weeks.
4. After approval, set the ad unit IDs in `adsense-config.js` (or run
   `node scripts/setup-adsense.mjs --publisher … --home-top …`) so ads render in the existing
   placements. Until then every placement stays hidden — no empty boxes, no fake ads.

**Content requirements Google also checks** (outside this code change): a working public site
with real content, an easily reachable **privacy policy** page, clear navigation, and no
misleading or copied content. If you want, I can add a privacy-policy page — that is a new page,
so I have not added it without your go-ahead.

---

## 4. Verify it yourself

```bash
npm run verify:production      # domain resolution, ads.txt, robots, verification tags, design intact
npm run check                  # syntax of the server modules
node scripts/verify-share.mjs  # YouTube-style design guards still pass
```

After deploying, check the live domain:

```bash
curl -sI  https://your-domain/ads.txt      # expect 200 + text/plain
curl -s   https://your-domain/ads.txt      # expect the google.com, pub-… line
curl -s   https://your-domain/robots.txt   # expect Mediapartners-Google allowed
curl -s   https://your-domain/ | grep -o 'rel="canonical"[^>]*'
curl -s   https://your-domain/ | grep -o 'google-adsense-account[^>]*'
```

---

## 5. What is still required from you

| Needed | Where to get it |
| --- | --- |
| Domain name | Your registrar |
| Plan upgrade to attach it | Settings → Billing (Starter $5/month or Pro) |
| `PUBLIC_SITE_URL` value | The domain you connect |
| `ADSENSE_PUBLISHER_ID` | AdSense → Account → Settings → Account information |
| Five ad unit IDs (optional) | AdSense → Ads → By ad unit → Display ads → responsive |
| Google AdSense approval | AdSense site review |

No passwords, payment details or AdSense login are ever needed.
