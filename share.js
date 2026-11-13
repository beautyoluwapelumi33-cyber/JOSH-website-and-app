'use strict';

/**
 * Share JOSH.
 *
 * The shared link always comes from JOSH_SITE.publicUrl (site-config.js), i.e.
 * the official published website. The current browser address is never used,
 * so a preview/localhost address can never leak into a share message.
 *
 * Every target opens a real provider share URL. Nothing is faked: if the
 * browser blocks the pop-up or the device has no share sheet, the visitor is
 * told to copy the link instead.
 */
(function () {
  var cfg = window.JOSH_SITE || {};

  function shareText() {
    return (cfg.shareText || 'JOSH — watch, create and earn from your videos.').trim();
  }

  function blockedPattern() {
    try {
      return new RegExp(cfg.blockedHostPattern || '^(localhost|127\\.\\d+\\.\\d+\\.\\d+|0\\.0\\.0\\.0)$', 'i');
    } catch (err) {
      return /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/i;
    }
  }

  /** The official public link, or null when it is not configured. */
  function publicUrl() {
    var raw = typeof cfg.publicUrl === 'string' ? cfg.publicUrl.trim() : '';
    if (!raw) return null;
    var parsed;
    try {
      parsed = new URL(raw);
    } catch (err) {
      return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!parsed.hostname || blockedPattern().test(parsed.hostname)) return null;
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString();
  }

  var TARGETS = [
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      short: 'WA',
      link: function (url, text) {
        return 'https://wa.me/?text=' + encodeURIComponent(text + ' ' + url);
      }
    },
    {
      id: 'facebook',
      label: 'Facebook',
      short: 'f',
      link: function (url) {
        return 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(url);
      }
    },
    {
      id: 'telegram',
      label: 'Telegram',
      short: 'TG',
      link: function (url, text) {
        return 'https://t.me/share/url?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text);
      }
    },
    {
      id: 'x',
      label: 'X (Twitter)',
      short: 'X',
      link: function (url, text) {
        return 'https://twitter.com/intent/tweet?url=' + encodeURIComponent(url) + '&text=' + encodeURIComponent(text);
      }
    },
    {
      id: 'email',
      label: 'Email',
      short: '@',
      link: function (url, text) {
        return 'mailto:?subject=' + encodeURIComponent('JOSH — watch, create and earn') +
          '&body=' + encodeURIComponent(text + '\n' + url);
      }
    }
  ];

  function el(id) {
    return document.getElementById(id);
  }

  function setStatus(message) {
    var status = el('shareStatus');
    if (status) status.textContent = message || '';
  }

  /** Keep canonical + social metadata pointing at the official URL. */
  function applyMetadata(url) {
    if (!url) return;
    var canonical = document.querySelector('link[rel="canonical"]');
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.rel = 'canonical';
      document.head.appendChild(canonical);
    }
    canonical.href = url;

    var ogUrl = document.querySelector('meta[property="og:url"]');
    if (ogUrl) ogUrl.setAttribute('content', url);
    var twitterUrl = document.querySelector('meta[name="twitter:url"]');
    if (twitterUrl) twitterUrl.setAttribute('content', url);
  }

  function renderTargets(url) {
    var grid = el('shareTargets');
    if (!grid) return;
    grid.textContent = '';

    TARGETS.forEach(function (target) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'share-target';
      button.setAttribute('data-share-target', target.id);
      button.disabled = !url;

      var icon = document.createElement('span');
      icon.className = 'ico';
      icon.textContent = target.short;
      icon.setAttribute('aria-hidden', 'true');

      var label = document.createElement('span');
      label.textContent = target.label;

      button.appendChild(icon);
      button.appendChild(label);
      button.addEventListener('click', function () {
        openTarget(target);
      });
      grid.appendChild(button);
    });

    if (typeof navigator !== 'undefined' && typeof navigator.share === 'function') {
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'share-target';
      more.setAttribute('data-share-target', 'more');
      more.disabled = !url;
      var moreIcon = document.createElement('span');
      moreIcon.className = 'ico';
      moreIcon.textContent = '•••';
      moreIcon.setAttribute('aria-hidden', 'true');
      var moreLabel = document.createElement('span');
      moreLabel.textContent = 'More apps';
      more.appendChild(moreIcon);
      more.appendChild(moreLabel);
      more.addEventListener('click', nativeShare);
      grid.appendChild(more);
    }
  }

  function openTarget(target) {
    var url = publicUrl();
    if (!url) {
      setStatus('The official public link is not configured, so nothing can be shared yet.');
      return;
    }
    var href = target.link(url, shareText());
    var win = null;
    try {
      win = window.open(href, '_blank', 'noopener,noreferrer');
    } catch (err) {
      win = null;
    }
    if (!win) {
      setStatus('Your browser blocked the ' + target.label + ' window. Allow pop-ups for JOSH, or use Copy link.');
      return;
    }
    setStatus('Opened the ' + target.label + ' share window.');
  }

  function nativeShare() {
    var url = publicUrl();
    if (!url) {
      setStatus('The official public link is not configured, so nothing can be shared yet.');
      return;
    }
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
      copyLink();
      return;
    }
    navigator.share({ title: cfg.name || 'JOSH', text: shareText(), url: url }).then(function () {
      setStatus('Shared.');
    }).catch(function (err) {
      if (err && err.name === 'AbortError') return;
      setStatus('Your device could not open the share sheet. Use Copy link instead.');
    });
  }

  function copyLink() {
    var url = publicUrl();
    if (!url) {
      setStatus('The official public link is not configured, so there is nothing to copy.');
      return;
    }
    var field = el('shareUrlField');
    if (field) {
      field.value = url;
      field.select();
    }

    function done() {
      setStatus('Official link copied. Paste it into any app.');
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(fallbackCopy);
      return;
    }
    fallbackCopy();

    function fallbackCopy() {
      try {
        if (field) {
          field.focus();
          field.select();
          if (document.execCommand('copy')) {
            done();
            return;
          }
        }
      } catch (err) {
        /* fall through to the manual message */
      }
      setStatus('Copy the link from the box above.');
    }
  }

  function openShareDialog() {
    var dialog = el('shareDialog');
    if (!dialog) return;
    var url = publicUrl();
    var field = el('shareUrlField');
    var note = el('shareNote');

    if (field) field.value = url || '';
    setStatus('');

    if (note) {
      note.textContent = url
        ? 'This is the official JOSH website link. Anyone can open it — no account or admin access needed.'
        : 'The official public website link has not been set. Add publicUrl in site-config.js before sharing.';
    }

    renderTargets(url);
    dialog.classList.remove('hidden');
    dialog.setAttribute('aria-hidden', 'false');

    var copyBtn = el('shareCopyBtn');
    if (copyBtn) copyBtn.disabled = !url;

    var first = dialog.querySelector('[data-share-target]');
    if (first && !first.disabled) first.focus();
  }

  function closeShareDialog() {
    var dialog = el('shareDialog');
    if (!dialog) return;
    dialog.classList.add('hidden');
    dialog.setAttribute('aria-hidden', 'true');
    setStatus('');
    var trigger = el('shareJoshBtn');
    if (trigger) trigger.focus();
  }

  function init() {
    var url = publicUrl();
    applyMetadata(url);

    var field = el('shareUrlField');
    if (field && url) field.value = url;

    var copyBtn = el('shareCopyBtn');
    if (copyBtn) {
      copyBtn.disabled = !url;
      copyBtn.addEventListener('click', copyLink);
    }

    var dialog = el('shareDialog');
    if (dialog) {
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog) closeShareDialog();
      });
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && !dialog.classList.contains('hidden')) closeShareDialog();
      });
    }

    // Expose the official link for the rest of the page (admin publish field).
    window.JOSH_PUBLIC_URL = url;
  }

  window.openShareDialog = openShareDialog;
  window.closeShareDialog = closeShareDialog;
  window.copyJoshLink = copyLink;
  window.shareJoshNative = nativeShare;
  window.joshPublicUrl = publicUrl;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
