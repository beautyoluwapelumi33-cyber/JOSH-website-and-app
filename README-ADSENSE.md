# Google AdSense integration — JOSH website

AdSense is integrated into the existing website **without changing its design or removing
any feature**. AdMob is **not** part of this website; it belongs to the Android app build.

---

## 1. What was added

| File | Purpose |
| --- | --- |
| `index.html` | Main entry point. Loads the two AdSense files in `<head>` and contains the ad placements and the video watch page. |
| `adsense-config.js` | **Your configuration**: publisher ID + one ad unit ID per placement. All values are empty by default. |
| `adsense.js` | Integration layer: validates the publisher ID, inserts the official AdSense tag into `<head>`, and renders responsive ad units into the marked containers. |
| `ads.txt` | Served at the website root (`https://your-domain/ads.txt`). Written from your real publisher ID. |
| `scripts/setup-adsense.mjs` | Writes `adsense-config.js` and `ads.txt` from your real IDs, and validates them (`--check`). |
| `scripts/verify-adsense.mjs` | Checks the integration is correct and the existing site is intact. |

### Placements (all responsive, all in their own blocks)

| Placement key | Where it appears |
| --- | --- |
| `homeTop` | Homepage, between the search box and the video feed |
| `homeFeed` | Homepage, after the video feed |
| `videoBelowPlayer` | Video page, below the player — outside the player element, so it never covers controls |
| `videoSidebar` | Video page sidebar, desktop only (hidden under 900 px) |
| `liveTop` | JOSH Live page, above the panels |

Ads are **not** placed in the header, the navigation bar, the video element, the upload form,
the earnings/withdrawal page or the admin login — that keeps them separate from navigation and
controls, and avoids ads next to payment or login forms.

### Behaviour while unconfigured

If `publisherId` or a given ad unit ID is empty:

* no request is sent to Google,
* the placement stays hidden (zero height, no empty box),
* no placeholder or fake advertisement is ever rendered.

---

## 2. Exactly which AdSense details to provide

Please send these six values:

1. **Publisher ID** — looks like `ca-pub-1234567890123456` (16 digits).
   AdSense → **Account** → **Settings** → **Account information** → *Publisher ID*.
2. **Homepage top ad unit ID** (numeric, ~10 digits, e.g. `1234567890`).
3. **Homepage feed ad unit ID**.
4. **Video page below-player ad unit ID**.
5. **Video page sidebar ad unit ID**.
6. **Live page ad unit ID**.

Create each unit in AdSense under **Ads → By ad unit → Display ads**, choose **Responsive**,
and copy the numeric **`data-ad-slot`** value from the generated code. Units 2–6 are optional:
any placement you leave out simply stays off.

Also tell me:

* whether you want **Auto ads** enabled (`enableAutoAds`), which lets Google add its own
  placements on top of these — it is off by default so every ad stays deliberate;
* the **domain** you will serve the site from, so `ads.txt` can be confirmed at
  `https://<domain>/ads.txt`.

You do **not** need to send any account password, payment details, or the AdSense login.

---

## 3. How to apply your IDs

Either edit `adsense-config.js` by hand, or run:

```bash
node scripts/setup-adsense.mjs \
  --publisher ca-pub-1234567890123456 \
  --home-top 1234567890 \
  --home-feed 1234567890 \
  --video-below-player 1234567890 \
  --video-sidebar 1234567890 \
  --live-top 1234567890
```

This writes `adsense-config.js` **and** `ads.txt`, which will then contain:

```
google.com, pub-1234567890123456, DIRECT, f08c47fec0942fa0
```

Verify at any time:

```bash
node scripts/setup-adsense.mjs --check
node scripts/verify-adsense.mjs
```

In the browser console, `JOSH_ADS.status()` lists every placement and whether it is off,
ready, or requesting an ad.

---

## 4. Go-live checklist

1. Add the site to AdSense and complete **site review/approval**. Ads cannot serve before the
   account and site are approved — nothing on the page needs to change for that.
2. Deploy, then confirm `https://<domain>/ads.txt` returns the file over HTTPS (HTTP 200,
   `text/plain`).
3. Optional site verification: add your own client ID to the two commented tags in `<head>`
   (`adsbygoogle.js?client=...` and `google-adsense-account`), or use the AdSense snippet check.
4. Ads appear only after Google serves them; an approved site may still show blank space for a
   while, and ad blockers hide them entirely.

No deployment has been performed — the changes are committed to the repository only, ready for
you to review and release.
