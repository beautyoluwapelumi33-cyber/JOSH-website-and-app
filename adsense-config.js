/**
 * JOSH — Google AdSense configuration (website only, no AdMob).
 *
 * Fill in the values from your own Google AdSense account. Anything left as ""
 * keeps that placement switched off, so the website never shows empty boxes and
 * never uses placeholder credentials as if they were real.
 *
 *   publisherId  AdSense → Account → Settings → Account information
 *                format: ca-pub-################ (16 digits)
 *   slots.*      AdSense → Ads → By ad unit → Display ads (responsive),
 *                copy each unit's numeric data-ad-slot value (~10 digits)
 *
 * Fastest way to fill this in (also writes ads.txt for you):
 *
 *   node scripts/setup-adsense.mjs --publisher ca-pub-################ \
 *     --home-top 0000000000 --home-feed 0000000000 \
 *     --video-below-player 0000000000 --video-sidebar 0000000000 \
 *     --live-top 0000000000
 *
 * Full checklist: README-ADSENSE.md
 */
window.JOSH_ADSENSE = {
  // Your AdSense publisher ID, e.g. "ca-pub-1234567890123456".
  publisherId: "",

  // One numeric ad unit ID per placement. An empty string switches it off.
  slots: {
    homeTop: "",          // homepage, above the video feed
    homeFeed: "",         // homepage, below the video feed
    videoBelowPlayer: "", // video page, below the player (outside the controls)
    videoSidebar: "",     // video page sidebar (desktop only)
    liveTop: ""           // JOSH Live page, above the panels
  },

  // Optional AdSense Auto ads. Off by default so every ad is a deliberate placement.
  enableAutoAds: false,

  // Set to true to log placement decisions in the browser console.
  debug: false
};
