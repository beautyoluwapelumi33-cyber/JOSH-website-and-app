/*!
 * JOSH — Google AdSense integration layer (website only).
 *
 * - Inserts the official AdSense tag into <head>, but ONLY when a valid
 *   publisher ID is configured in adsense-config.js.
 * - Renders <ins class="adsbygoogle"> units into the marked ad containers
 *   ([data-ad-slot]) when the matching ad unit ID is configured.
 * - Containers stay hidden until a real unit is requested, so an unconfigured
 *   install shows no empty boxes and never displays fake advertisements.
 *
 * AdMob is intentionally NOT part of this file: AdMob belongs to the Android
 * app build, not to the website.
 */
(function () {
  'use strict';

  var PUBLISHER_RE = /^ca-pub-\d{16}$/;
  var SLOT_RE = /^\d{6,20}$/;
  var LOADER_SRC = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';

  var raw = window.JOSH_ADSENSE || {};
  var config = {
    publisherId: String(raw.publisherId == null ? '' : raw.publisherId).trim(),
    slots: (raw.slots && typeof raw.slots === 'object') ? raw.slots : {},
    enableAutoAds: raw.enableAutoAds === true,
    debug: raw.debug === true
  };

  var state = {
    publisherValid: PUBLISHER_RE.test(config.publisherId),
    loaderAdded: false,
    rendered: [],
    skipped: []
  };

  function slotIdFor(name) {
    var value = String(config.slots[name] == null ? '' : config.slots[name]).trim();
    return SLOT_RE.test(value) ? value : '';
  }

  function log(message, extra) {
    if (!config.debug || !window.console) return;
    if (extra !== undefined) console.info('[JOSH ads] ' + message, extra);
    else console.info('[JOSH ads] ' + message);
  }

  function queue() {
    window.adsbygoogle = window.adsbygoogle || [];
    return window.adsbygoogle;
  }

  function loadAdSenseTag() {
    if (state.loaderAdded) return;
    state.loaderAdded = true;

    var ads = queue();
    if (config.enableAutoAds) {
      ads.push({ google_ad_client: config.publisherId, enable_page_level_ads: true });
    }

    var tag = document.createElement('script');
    tag.async = true;
    tag.crossOrigin = 'anonymous';
    tag.src = LOADER_SRC + '?client=' + encodeURIComponent(config.publisherId);
    document.head.appendChild(tag);
    log('AdSense tag requested for ' + config.publisherId);
  }

  function renderSlot(container) {
    if (!container || container.getAttribute('data-ad-rendered') === 'true') return false;

    var name = container.getAttribute('data-ad-slot') || '';
    var id = slotIdFor(name);

    // No real publisher ID or no real ad unit ID: keep the placement invisible.
    if (!state.publisherValid || !id) {
      container.hidden = true;
      container.setAttribute('data-ad-state', 'off');
      if (state.skipped.indexOf(name) === -1) state.skipped.push(name);
      log('placement "' + name + '" is off (publisher ID or ad unit ID not configured)');
      return false;
    }

    // Reveal to measure, then put it back if its section (or breakpoint) is hidden.
    var wasHidden = container.hidden;
    container.hidden = false;
    if (container.getClientRects().length === 0) {
      container.hidden = wasHidden;
      return false;
    }

    var unit = document.createElement('ins');
    unit.className = 'adsbygoogle';
    unit.style.display = 'block';
    unit.setAttribute('data-ad-client', config.publisherId);
    unit.setAttribute('data-ad-slot', id);
    unit.setAttribute('data-ad-format', 'auto');
    unit.setAttribute('data-full-width-responsive', 'true');
    container.appendChild(unit);
    container.setAttribute('data-ad-state', 'ready');

    try {
      queue().push({});
      container.setAttribute('data-ad-rendered', 'true');
      state.rendered.push(name);
      log('placement "' + name + '" requested (ad unit ' + id + ')');
      return true;
    } catch (error) {
      container.setAttribute('data-ad-state', 'error');
      container.hidden = true;
      log('placement "' + name + '" could not be requested', error);
      return false;
    }
  }

  function renderAll() {
    var containers = document.querySelectorAll('[data-ad-slot]');
    var count = 0;
    for (var i = 0; i < containers.length; i++) {
      if (renderSlot(containers[i])) count++;
    }
    return count;
  }

  function init() {
    if (!state.publisherValid) {
      var off = document.querySelectorAll('[data-ad-slot]');
      for (var i = 0; i < off.length; i++) off[i].hidden = true;
      log('no valid publisher ID in adsense-config.js — every ad placement stays hidden');
      return;
    }
    loadAdSenseTag();
    renderAll();
  }

  // Pages are switched with showPage(); re-check placements after each switch.
  document.addEventListener('josh:page', function () {
    if (state.publisherValid) renderAll();
  });

  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (!state.publisherValid) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAll, 250);
  }, { passive: true });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.JOSH_ADS = {
    config: config,
    render: renderAll,
    status: function () {
      return {
        publisherConfigured: state.publisherValid,
        publisherId: config.publisherId || null,
        autoAds: config.enableAutoAds,
        placements: Array.prototype.map.call(document.querySelectorAll('[data-ad-slot]'), function (el) {
          var name = el.getAttribute('data-ad-slot');
          return {
            name: name,
            adUnitId: slotIdFor(name) || null,
            state: el.getAttribute('data-ad-state') || (el.hidden ? 'off' : 'idle')
          };
        })
      };
    }
  };
})();
