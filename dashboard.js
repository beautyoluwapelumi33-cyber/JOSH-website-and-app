/* JOSH dashboards — private administrator console and creator earnings.
 *
 * Every request is authorised by the server (session cookie + role check);
 * this file only renders what the API returns for the signed-in account.
 * No financial value is computed here: balances, the 60/40 split, payment
 * states and transaction hashes all come from the backend, so the browser
 * can never invent earnings or mark a payout as paid. */
(function () {
  'use strict';

  var PUBLIC_URL = (typeof window.JOSH_PUBLIC_URL === 'string' ? window.JOSH_PUBLIC_URL : '').trim();
  var state = { user: null, tab: 'overview' };

  /* ------------------------------------------------------------------ *
   * DOM helpers
   * ------------------------------------------------------------------ */
  function $(id) {
    return document.getElementById(id);
  }

  function h(tag, attrs, kids) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        var value = attrs[key];
        if (value === null || value === undefined || value === false) return;
        if (key === 'text') node.textContent = String(value);
        else if (key === 'class') node.className = String(value);
        else if (key === 'value') node.value = String(value);
        else node.setAttribute(key, value === true ? '' : String(value));
      });
    }
    (kids || []).forEach(function (kid) {
      if (kid === null || kid === undefined || kid === false) return;
      node.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    });
    return node;
  }

  function num(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function money(value) {
    return num(value).toFixed(2);
  }

  function when(iso) {
    if (!iso) return '—';
    var date = new Date(iso);
    if (Number.isNaN(date.getTime())) return String(iso);
    return date.toLocaleString();
  }

  function fill(hostId, node) {
    var host = $(hostId);
    if (!host) return;
    host.textContent = '';
    host.appendChild(node);
  }

  function flash(hostId, text, isError) {
    var host = $(hostId);
    if (!host) return;
    var line = h('p', { class: 'muted admin-note' + (isError ? ' auth-error' : ''), text: text });
    host.insertBefore(line, host.firstChild);
  }

  function setText(id, text) {
    var el = $(id);
    if (el) el.textContent = text;
  }

  function stat(label, value) {
    return h('div', { class: 'stat' }, [label, h('strong', { text: value })]);
  }

  function pill(status) {
    var clean = String(status || 'unknown').toLowerCase().replace(/[^a-z_]/g, '');
    return h('span', { class: 'pill ' + clean, text: String(status || 'unknown') });
  }

  function button(label, onClick, primary) {
    var el = h('button', { type: 'button', class: primary ? 'primary' : '', text: label });
    el.addEventListener('click', onClick);
    return el;
  }

  function table(headers, rows, emptyText) {
    var wrap = h('div', { class: 'admin-table-wrap' });
    if (!rows.length) {
      wrap.appendChild(h('p', { class: 'muted admin-note', text: emptyText || 'No records yet.' }));
      return wrap;
    }
    var head = h('tr', null, headers.map(function (label) {
      return h('th', { text: label });
    }));
    var body = h('tbody', null, rows.map(function (cells) {
      return h('tr', null, cells.map(function (cell) {
        return h('td', null, [cell]);
      }));
    }));
    wrap.appendChild(h('table', { class: 'admin-table' }, [h('thead', null, [head]), body]));
    return wrap;
  }

  /* ------------------------------------------------------------------ *
   * API helper — always sends the session cookie
   * ------------------------------------------------------------------ */
  async function api(path, options) {
    var config = Object.assign({ method: 'GET', credentials: 'include' }, options || {});
    config.headers = Object.assign({ Accept: 'application/json' }, config.headers || {});
    if (config.body && typeof config.body !== 'string') {
      config.headers['Content-Type'] = 'application/json';
      config.body = JSON.stringify(config.body);
    }
    try {
      var response = await fetch(path, config);
      var type = response.headers.get('content-type') || '';
      var data = type.indexOf('application/json') >= 0 ? await response.json().catch(function () { return null; }) : null;
      return { ok: response.ok, status: response.status, data: data };
    } catch (err) {
      return { ok: false, status: 0, data: null, networkError: true };
    }
  }

  function message(result, fallback) {
    var data = result && result.data;
    if (result && result.networkError) return 'Cannot reach the JOSH server. Check your connection and try again.';
    if (data && data.error && data.error.message) return data.error.message;
    if (data && typeof data.message === 'string' && data.message) return data.message;
    if (result && result.status === 401) return 'Please sign in with an administrator account.';
    if (result && result.status === 403) return 'This account does not have administrator permission.';
    return fallback || 'Request failed (' + (result && result.status) + ').';
  }

  /* ------------------------------------------------------------------ *
   * Administrator entry visibility
   * ------------------------------------------------------------------ */
  function revealEntry() {
    document.querySelectorAll('[data-admin-entry]').forEach(function (el) {
      el.classList.remove('hidden');
    });
  }

  function adminNote(text, isError) {
    var el = $('adminLoginNote');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'muted admin-note' + (isError ? ' auth-error' : '');
  }

  function lockAdmin() {
    state.user = null;
    var panel = document.querySelector('[data-admin-panel]');
    var login = $('adminLoginPanel');
    if (panel) panel.hidden = true;
    if (login) login.hidden = false;
    setText('adminStatus', 'This dashboard is private. Sign in with an administrator account — the public website never exposes administrator data.');
  }

  function unlockAdmin(user) {
    if (!user || user.role !== 'admin') {
      lockAdmin();
      adminNote('This account is not an administrator.', true);
      return;
    }
    state.user = user;
    revealEntry();
    var login = $('adminLoginPanel');
    var panel = document.querySelector('[data-admin-panel]');
    if (login) login.hidden = true;
    if (panel) panel.hidden = false;
    setText('adminStatus', 'Signed in as ' + (user.email || 'administrator') + '. Private administrator data only.');
    var link = $('adminPublishLink');
    if (link) link.value = PUBLIC_URL || window.location.origin;
    adminNote('');
    switchTab(state.tab);
  }

  function copyPublishLink() {
    var input = $('adminPublishLink');
    if (!input) return;
    var value = input.value || PUBLIC_URL || window.location.origin;
    var done = function () { adminNote('Official link copied: ' + value); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(value).then(done).catch(function () { input.select(); done(); });
    } else {
      input.select();
      try { document.execCommand('copy'); } catch (err) { /* selection still visible */ }
      done();
    }
  }

  window.copyPublishLink = copyPublishLink;
  window.revealEntry = revealEntry;
  window.unlockAdmin = unlockAdmin;

  /* ------------------------------------------------------------------ *
   * Admin tabs
   * ------------------------------------------------------------------ */
  function switchTab(name) {
    state.tab = name;
    document.querySelectorAll('[data-admin-tab]').forEach(function (tab) {
      var on = tab.getAttribute('data-admin-tab') === name;
      tab.classList.toggle('active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('[data-admin-block]').forEach(function (block) {
      block.hidden = block.getAttribute('data-admin-block') !== name;
    });
    loadTab(name);
  }

  function loadTab(name) {
    if (!state.user) return;
    var loaders = {
      overview: loadOverview,
      users: loadUsers,
      videos: loadVideos,
      live: loadLive,
      revenue: loadRevenue,
      earnings: loadEarnings,
      withdrawals: loadWithdrawals,
      settings: loadSettings,
      audit: loadAudit
    };
    var loader = loaders[name];
    if (loader) loader();
  }

  /* ------------------------------------------------------------------ *
   * Overview
   * ------------------------------------------------------------------ */
  async function loadOverview() {
    var result = await api('/api/admin/overview');
    if (!result.ok) {
      fill('adminOverviewStats', h('p', { class: 'muted admin-note', text: message(result, 'Could not load the overview.') }));
      return;
    }
    var d = result.data || {};
    var users = d.users || {};
    var videos = d.videos || {};
    var live = d.livestreams || {};
    var revenue = d.revenue || {};
    var sharing = d.sharing || {};
    var earnings = d.earnings || {};
    var withdrawals = d.withdrawals || {};
    var ads = d.adsense || {};
    var pay = d.payments || {};
    var sync = d.sync || {};

    fill('adminOverviewStats', h('div', { class: 'stats' }, [
      stat('Registered users', String(num(users.total))),
      stat('Creators', String(num(users.creators))),
      stat('Administrators', String(num(users.admins))),
      stat('New this week', String(num(users.newThisWeek))),
      stat('Videos', String(num(videos.total))),
      stat('Total views', String(num(videos.views))),
      stat('Watch hours', money(videos.watchHours)),
      stat('Active livestreams', String(num(live.active))),
      stat('Estimated revenue', '$' + money(revenue.estimated)),
      stat('Finalized revenue', '$' + money(revenue.finalized)),
      stat('Ad impressions', String(num(revenue.impressions))),
      stat('Ad clicks', String(num(revenue.clicks))),
      stat('Page views', String(num(revenue.pageViews))),
      stat('Creator pool (60%)', '$' + money(sharing.creatorPoolFromFinalized)),
      stat('JOSH share (40%)', '$' + money(sharing.platformShareFromFinalized)),
      stat('Creator earnings credited', '$' + money(earnings.credited)),
      stat('Pending withdrawals', String(num(withdrawals.pending))),
      stat('Paid out (USDT)', money(withdrawals.paidAmount))
    ]));

    var bits = [];
    bits.push('AdSense: ' + String(ads.state || ads.status || 'unknown') + (ads.message ? ' — ' + ads.message : ''));
    bits.push('Payouts: ' + (pay.autoPayoutConfigured ? 'automated provider configured' : 'manual approval with on-chain verification') + (pay.message ? ' — ' + pay.message : ''));
    bits.push(sync.lastRun ? 'Last revenue sync ' + when(sync.lastRun.at) + ' (' + (sync.lastRun.status || 'unknown') + ')' : 'No AdSense synchronization has run yet.');
    if (sharing.note) bits.push(sharing.note);
    setText('adminOverviewNote', bits.filter(Boolean).join(' · '));
  }

  /* ------------------------------------------------------------------ *
   * Users and creator management
   * ------------------------------------------------------------------ */
  async function changeRole(id, role, select) {
    select.disabled = true;
    var result = await api('/api/admin/users/' + encodeURIComponent(id) + '/role', {
      method: 'PATCH',
      body: { role: role }
    });
    select.disabled = false;
    if (!result.ok) {
      flash('adminUsersHost', message(result, 'Could not change that role.'), true);
      return;
    }
    flash('adminUsersHost', 'Role updated to ' + role + '.', false);
    loadUsers();
  }

  async function loadUsers() {
    var result = await api('/api/admin/users');
    if (!result.ok) {
      fill('adminUsersHost', h('p', { class: 'muted admin-note', text: message(result, 'Could not load users.') }));
      return;
    }
    var users = (result.data && result.data.users) || [];
    var rows = users.map(function (user) {
      var select = h('select', { 'aria-label': 'Role for ' + (user.email || 'account') }, ['creator', 'admin'].map(function (role) {
        var option = h('option', { value: role, text: role });
        if ((user.role || 'creator') === role) option.selected = true;
        return option;
      }));
      select.addEventListener('change', function () {
        changeRole(user.id, select.value, select);
      });
      return [
        user.email || '—',
        user.displayName || user.name || '—',
        String(user.role || 'creator'),
        String(num(user.videos)),
        String(num(user.views)),
        '$' + money(user.earnings),
        String(num(user.withdrawals)),
        when(user.createdAt),
        select
      ];
    });
    fill('adminUsersHost', table(
      ['Email', 'Name', 'Role', 'Videos', 'Views', 'Earnings', 'Withdrawals', 'Joined', 'Set role'],
      rows,
      'No accounts yet.'
    ));
  }

  /* ------------------------------------------------------------------ *
   * Videos
   * ------------------------------------------------------------------ */
  async function addVideo() {
    var title = ($('adminVideoTitle') || {}).value || '';
    var body = {
      title: title.trim(),
      creatorEmail: (($('adminVideoCreator') || {}).value || '').trim(),
      sourceUrl: (($('adminVideoUrl') || {}).value || '').trim(),
      visibility: 'public'
    };
    var result = await api('/api/admin/videos', { method: 'POST', body: body });
    if (!result.ok) {
      flash('adminVideosHost', message(result, 'Could not publish that video record.'), true);
      return;
    }
    if ($('adminVideoTitle')) $('adminVideoTitle').value = '';
    flash('adminVideosHost', 'Video record published.', false);
    loadVideos();
  }

  async function removeVideo(id) {
    var result = await api('/api/admin/videos/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!result.ok) {
      flash('adminVideosHost', message(result, 'Could not remove that video.'), true);
      return;
    }
    flash('adminVideosHost', 'Video removed.', false);
    loadVideos();
  }

  async function loadVideos() {
    var result = await api('/api/admin/videos');
    if (!result.ok) {
      fill('adminVideosHost', h('p', { class: 'muted admin-note', text: message(result, 'Could not load videos.') }));
      return;
    }
    var videos = (result.data && result.data.videos) || [];
    var rows = videos.map(function (video) {
      return [
        video.title || '—',
        (video.creator && (video.creator.email || video.creator.name)) || 'Unassigned',
        String(video.visibility || 'public'),
        String(video.status || 'published'),
        String(num(video.views)),
        money(video.watchHours),
        when(video.createdAt),
        button('Remove', function () { removeVideo(video.id); })
      ];
    });
    fill('adminVideosHost', table(
      ['Title', 'Creator', 'Visibility', 'Status', 'Views', 'Watch hours', 'Added', 'Action'],
      rows,
      'No videos yet.'
    ));
  }

  /* ------------------------------------------------------------------ *
   * Livestreams
   * ------------------------------------------------------------------ */
  async function addLive() {
    var body = {
      title: (($('adminLiveTitle') || {}).value || '').trim(),
      creatorEmail: (($('adminLiveCreator') || {}).value || '').trim(),
      streamUrl: (($('adminLiveUrl') || {}).value || '').trim()
    };
    var result = await api('/api/admin/live', { method: 'POST', body: body });
    if (!result.ok) {
      flash('adminLiveHost', message(result, 'Could not schedule that stream.'), true);
      return;
    }
    if ($('adminLiveTitle')) $('adminLiveTitle').value = '';
    flash('adminLiveHost', 'Stream scheduled.', false);
    loadLive();
  }

  async function setLiveStatus(id, status) {
    var result = await api('/api/admin/live/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: { status: status }
    });
    if (!result.ok) {
      flash('adminLiveHost', message(result, 'Could not update that stream.'), true);
      return;
    }
    flash('adminLiveHost', 'Stream marked ' + status + '.', false);
    loadLive();
  }

  async function loadLive() {
    var result = await api('/api/admin/live');
    if (!result.ok) {
      fill('adminLiveHost', h('p', { class: 'muted admin-note', text: message(result, 'Could not load livestreams.') }));
      return;
    }
    var streams = (result.data && result.data.livestreams) || result.data && result.data.live || [];
    var rows = streams.map(function (stream) {
      var live = String(stream.status || '') === 'live';
      return [
        stream.title || '—',
        (stream.creator && (stream.creator.email || stream.creator.name)) || 'Unassigned',
        pill(stream.status || 'scheduled'),
        String(num(stream.viewers)),
        when(stream.startedAt),
        when(stream.endedAt),
        button(live ? 'End stream' : 'Go live', function () { setLiveStatus(stream.id, live ? 'ended' : 'live'); })
      ];
    });
    fill('adminLiveHost', table(
      ['Title', 'Creator', 'Status', 'Viewers', 'Started', 'Ended', 'Action'],
      rows,
      'No livestreams yet.'
    ));
  }

  /* ------------------------------------------------------------------ *
   * Advertising revenue
   * ------------------------------------------------------------------ */
  async function addRevenue() {
    var body = {
      date: (($('adminRevDate') || {}).value || '').trim(),
      estimated: Number((($('adminRevEstimated') || {}).value || '0')),
      finalized: (($('adminRevFinalized') || {}).value || ''),
      note: (($('adminRevNote') || {}).value || '').trim()
    };
    if (body.finalized === '') delete body.finalized;
    var result = await api('/api/admin/revenue/manual', { method: 'POST', body: body });
    if (!result.ok) {
      flash('adminRevenueHost', message(result, 'Could not record that revenue.'), true);
      return;
    }
    if ($('adminRevNote')) $('adminRevNote').value = '';
    flash('adminRevenueHost', 'Manual revenue entry recorded.', false);
    loadRevenue();
  }

  async function loadRevenue() {
    var overview = await api('/api/admin/overview');
    var ads = (overview.ok && overview.data && overview.data.adsense) || {};
    var sync = (overview.ok && overview.data && overview.data.sync) || {};
    var adRows = [
      ['Connection state', pill(ads.state || ads.status || 'not_configured')],
      ['Publisher ID', ads.publisherId || 'Not configured'],
      ['Account', ads.accountId || 'Not connected']
    ];
    if (ads.message) adRows.push(['Detail', ads.message]);
    adRows.push(['Last synchronization', sync.lastRun ? when(sync.lastRun.at) + ' — ' + (sync.lastRun.status || 'unknown') : 'Never run']);
    adRows.push(['Synchronization errors', String(num(sync.errorCount))]);
    adRows.push(['Revenue model', 'Estimated revenue is Google reporting data; finalized revenue is the settled amount used for the 60/40 split. Payments received from Google are tracked separately.']);

    fill('adminAdsenseHost', h('div', { class: 'admin-table-wrap' }, [
      h('table', { class: 'admin-table' }, [
        h('tbody', null, adRows.map(function (row) {
          return h('tr', null, [h('th', { text: row[0] }), h('td', { text: row[1] })]);
        }))
      ])
    ]));

    var result = await api('/api/admin/revenue');
    if (!result.ok) {
      fill('adminRevenueHost', h('p', { class: 'muted admin-note', text: message(result, 'Could not load revenue.') }));
      return;
    }
    var data = result.data || {};
    var daily = data.daily || [];
    var totals = data.totals || {};
    var rows = daily.map(function (day) {
      return [
        day.date || '—',
        day.source || 'adsense',
        day.isManual ? 'manual' : 'AdSense',
        '$' + money(day.estimated),
        '$' + money(day.finalized),
        String(num(day.impressions)),
        String(num(day.clicks)),
        String(num(day.pageViews)),
        day.note || '—'
      ];
    });
    var summary = h('p', { class: 'muted admin-note', text:
      'Estimated $' + money(totals.estimated) + ' · Finalized $' + money(totals.finalized) +
      ' · Impressions ' + num(totals.impressions) + ' · Clicks ' + num(totals.clicks) +
      ' · Page views ' + num(totals.pageViews) + ' · ' + num(data.days) + ' day(s) of data.' });
    fill('adminRevenueHost', h('div', null, [
      summary,
      table(['Date', 'Source', 'Type', 'Estimated', 'Finalized', 'Impressions', 'Clicks', 'Page views', 'Note'], rows, 'No revenue recorded yet.')
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Creator earnings (60% / 40%)
   * ------------------------------------------------------------------ */
  async function distribute() {
    var period = (($('adminPeriod') || {}).value || '').trim();
    var result = await api('/api/admin/earnings/distribute', { method: 'POST', body: { period: period } });
    if (!result.ok) {
      flash('adminEarningsHost', message(result, 'Could not distribute that period.'), true);
      return;
    }
    flash('adminEarningsHost', (result.data && result.data.message) || 'Period distributed.', false);
    loadEarnings();
  }

  async function addMetric() {
    var body = {
      email: (($('adminMetricEmail') || {}).value || '').trim(),
      date: (($('adminMetricDate') || {}).value || '').trim(),
      eligibleViews: Number((($('adminMetricViews') || {}).value || '0')),
      verified: true
    };
    var result = await api('/api/admin/metrics', { method: 'POST', body: body });
    if (!result.ok) {
      flash('adminEarningsHost', message(result, 'Could not save those verified views.'), true);
      return;
    }
    if ($('adminMetricViews')) $('adminMetricViews').value = '';
    flash('adminEarningsHost', 'Verified views saved.', false);
    loadEarnings();
  }

  async function loadEarnings() {
    var result = await api('/api/admin/earnings');
    if (!result.ok) {
      fill('adminEarningsHost', h('p', { class: 'muted admin-note', text: message(result, 'Could not load earnings.') }));
      return;
    }
    var data = result.data || {};
    var sharing = data.sharing || {};
    var entries = data.entries || [];
    var byCreator = data.byCreator || [];

    var headline = h('div', { class: 'stats' }, [
      stat('Creator share', Math.round(num(sharing.creatorShare) * 100) + '%'),
      stat('JOSH share', Math.round(num(sharing.platformShare) * 100) + '%'),
      stat('Creator pool (finalized)', '$' + money(sharing.creatorPoolFromFinalized)),
      stat('JOSH share (finalized)', '$' + money(sharing.platformShareFromFinalized)),
      stat('Credited to creators', '$' + money(data.totalCredited))
    ]);

    var entryRows = entries.map(function (entry) {
      return [
        entry.period || '—',
        entry.email || '—',
        '$' + money(entry.amount),
        String(num(entry.eligibleViews)),
        money(entry.grossPool),
        String(Math.round(num(entry.shareRate) * 100)) + '%',
        pill(entry.state || 'credited')
      ];
    });

    var creatorRows = byCreator.map(function (row) {
      return [
        row.email || row.display_name || '—',
        '$' + money(row.total),
        String(num(row.periods)) + ' period(s)'
      ];
    });

    fill('adminEarningsHost', h('div', null, [
      headline,
      h('p', { class: 'muted admin-note', text: sharing.note || 'Creator earnings use finalized revenue only; estimated revenue never credits a creator.' }),
      table(['Period', 'Creator', 'Credit', 'Eligible views', 'Pool', 'Share', 'State'], entryRows, 'No creator credits yet.'),
      h('h3', { class: 'admin-subhead', text: 'Earnings per creator' }),
      table(['Creator', 'Total credited', 'Periods'], creatorRows, 'No creator earnings yet.')
    ]));
  }

  /* ------------------------------------------------------------------ *
   * Withdrawals
   * ------------------------------------------------------------------ */
  async function decide(id, decision) {
    var body = { decision: decision };
    if (decision === 'reject') {
      body.reason = 'Rejected by administrator';
    }
    var result = await api('/api/admin/withdrawals/' + encodeURIComponent(id) + '/decide', { method: 'POST', body: body });
    if (!result.ok) {
      flash('adminWithdrawalsHost', message(result, 'Could not update that request.'), true);
      return;
    }
    flash('adminWithdrawalsHost', 'Request ' + decision + 'd.', false);
    loadWithdrawals();
  }

  async function markPaid(id, input, trigger) {
    var txHash = (input.value || '').trim();
    if (!txHash) {
      flash('adminWithdrawalsHost', 'Enter the BEP20 transaction hash before marking a payout as paid.', true);
      return;
    }
    trigger.disabled = true;
    var result = await api('/api/admin/withdrawals/' + encodeURIComponent(id) + '/mark-paid', {
      method: 'POST',
      body: { txHash: txHash }
    });
    trigger.disabled = false;
    if (!result.ok) {
      flash('adminWithdrawalsHost', message(result, 'The transfer could not be verified on BNB Smart Chain.'), true);
      return;
    }
    flash('adminWithdrawalsHost', (result.data && result.data.message) || 'Transfer verified on chain and marked paid.', false);
    loadWithdrawals();
  }

  async function loadWithdrawals() {
    var result = await api('/api/admin/withdrawals');
    if (!result.ok) {
      fill('adminWithdrawalsHost', h('p', { class: 'muted admin-note', text: message(result, 'Could not load withdrawals.') }));
      return;
    }
    var data = result.data || {};
    var pay = data.payments || {};
    setText('adminPaymentsNote',
      (pay.autoPayoutConfigured
        ? 'Automated payout provider is configured.'
        : 'Payouts are released manually: a request is only marked paid after the transfer is verified on BNB Smart Chain.') +
      (pay.message ? ' ' + pay.message : ''));

    var rows = (data.withdrawals || []).map(function (w) {
      var actions = h('div', { class: 'admin-actions' });
      if (w.status === 'pending') {
        actions.appendChild(button('Approve', function () { decide(w.id, 'approve'); }, true));
        actions.appendChild(button('Reject', function () { decide(w.id, 'reject'); }));
      }
      if (w.status === 'approved' || w.status === 'processing') {
        var input = h('input', { placeholder: 'BEP20 tx hash 0x…', 'aria-label': 'Transaction hash' });
        var verify = button('Verify & mark paid', function () { markPaid(w.id, input, verify); }, true);
        actions.appendChild(input);
        actions.appendChild(verify);
      }
      if (!actions.childNodes.length) actions.appendChild(document.createTextNode('—'));
      return [
        w.email || w.displayName || '—',
        money(w.amount) + ' USDT',
        String(w.network || 'BEP20'),
        h('span', { class: 'admin-mono', text: w.address || '—' }),
        pill(w.status || 'pending'),
        h('span', { class: 'admin-mono', text: w.txHash || '—' }),
        when(w.createdAt),
        actions
      ];
    });

    fill('adminWithdrawalsHost', table(
      ['Creator', 'Amount', 'Network', 'Wallet', 'Status', 'Transaction', 'Requested', 'Action'],
      rows,
      'No withdrawal requests yet.'
    ));
  }

  /* ------------------------------------------------------------------ *
   * Settings
   * ------------------------------------------------------------------ */
  async function saveSettings() {
    var body = {
      siteName: (($('adminSiteName') || {}).value || '').trim(),
      logoAccent: (($('adminLogoAccent') || {}).value || '').trim(),
      logoUrl: (($('adminLogoUrl') || {}).value || '').trim()
    };
    var result = await api('/api/admin/settings', { method: 'PUT', body: body });
    if (!result.ok) {
      flash('adminSettingsNote', message(result, 'Could not save settings.'), true);
      return;
    }
    flash('adminSettingsNote', 'Settings saved.', false);
    loadSettings();
  }

  async function loadSettings() {
    var result = await api('/api/admin/settings');
    if (!result.ok) {
      flash('adminSettingsNote', message(result, 'Could not load settings.'), true);
      return;
    }
    var settings = (result.data && result.data.settings) || {};
    if ($('adminSiteName')) $('adminSiteName').value = settings.siteName || 'JOSH';
    if ($('adminLogoAccent')) $('adminLogoAccent').value = settings.logoAccent || '#ff3155';
    if ($('adminLogoUrl')) $('adminLogoUrl').value = settings.logoUrl || '';
    var link = $('adminPublishLink');
    if (link) link.value = PUBLIC_URL || window.location.origin;
  }

  /* ------------------------------------------------------------------ *
   * Audit log
   * ------------------------------------------------------------------ */
  async function loadAudit() {
    var result = await api('/api/admin/audit');
    if (!result.ok) {
      fill('adminAuditHost', h('p', { class: 'muted admin-note', text: message(result, 'Could not load the audit log.') }));
      return;
    }
    var entries = (result.data && result.data.entries) || [];
    var rows = entries.map(function (entry) {
      return [
        when(entry.createdAt),
        entry.actorEmail || 'system',
        String(entry.action || '—'),
        String(entry.target || '—'),
        entry.metadata ? JSON.stringify(entry.metadata) : '—'
      ];
    });
    fill('adminAuditHost', table(['When', 'Actor', 'Action', 'Target', 'Detail'], rows, 'No administrative actions recorded yet.'));
  }

  /* ------------------------------------------------------------------ *
   * Creator earnings and withdrawals
   * ------------------------------------------------------------------ */
  async function saveWallet() {
    var address = (($('walletAddress') || {}).value || '').trim();
    var result = await api('/api/creator/wallet', { method: 'POST', body: { address: address } });
    var status = $('walletStatus');
    if (!result.ok) {
      if (status) { status.textContent = message(result, 'Could not save that wallet address.'); status.className = 'auth-error'; }
      return;
    }
    if (status) { status.textContent = 'Wallet address saved. It is used as the default payout destination.'; status.className = 'muted'; }
    loadWallet();
  }

  async function requestWithdrawal() {
    var amount = (($('withdrawAmount') || {}).value || '').trim();
    var address = (($('walletAddress') || {}).value || '').trim();
    var trigger = $('withdrawBtn');
    if (trigger) trigger.disabled = true;
    var result = await api('/api/creator/withdrawals', { method: 'POST', body: { amount: amount, address: address } });
    if (trigger) trigger.disabled = false;
    var status = $('walletStatus');
    if (!result.ok) {
      if (status) { status.textContent = message(result, 'Could not request that withdrawal.'); status.className = 'auth-error'; }
      return;
    }
    if ($('withdrawAmount')) $('withdrawAmount').value = '';
    if (status) { status.textContent = 'Withdrawal requested. It stays pending until an administrator approves and verifies the transfer.'; status.className = 'muted'; }
    loadWallet();
  }

  function renderWithdrawals(list) {
    var host = $('withdrawHistory');
    if (!host) return;
    host.textContent = '';
    if (!list.length) {
      host.appendChild(h('p', { class: 'muted', text: 'No withdrawals yet.' }));
      return;
    }
    var rows = list.map(function (w) {
      return [
        when(w.createdAt),
        money(w.amount) + ' USDT',
        pill(w.status || 'pending'),
        h('span', { class: 'admin-mono', text: w.txHash || '—' }),
        w.rejectionReason || w.verificationNote || '—'
      ];
    });
    host.appendChild(table(['Requested', 'Amount', 'Status', 'Transaction', 'Note'], rows, 'No withdrawals yet.'));
  }

  async function loadWallet() {
    var status = $('walletStatus');
    var result = await api('/api/creator/summary');
    if (result.status === 401) {
      if (status) { status.textContent = 'Sign in as a creator to see verified earnings and request a withdrawal.'; status.className = 'muted'; }
      return;
    }
    if (result.status === 403) {
      if (status) { status.textContent = 'Administrator accounts manage platform finances in the admin dashboard.'; status.className = 'muted'; }
      return;
    }
    if (!result.ok) {
      if (status) { status.textContent = message(result, 'Could not load your earnings.'); status.className = 'auth-error'; }
      return;
    }
    var data = result.data || {};
    var earnings = data.earnings || {};
    var pay = data.payments || {};
    setText('walletBalance', money(data.balance) + ' USDT');
    setText('walletEarned', money(earnings.total) + ' USDT');
    setText('walletEstimated', money(earnings.estimated) + ' USDT');
    setText('walletMin', money(pay.minWithdrawal || 0.5) + ' USDT');
    if (status) {
      status.textContent = 'Only finalized advertising revenue credits your balance; estimated revenue is shown for information only.';
      status.className = 'muted';
    }
    if ($('walletAddress') && data.wallet && data.wallet.address) $('walletAddress').value = data.wallet.address;
    renderWithdrawals(data.withdrawals || []);
  }

  /* ------------------------------------------------------------------ *
   * Wiring
   * ------------------------------------------------------------------ */
  function bindAdmin() {
    var form = $('adminLoginForm');
    if (form) {
      form.addEventListener('submit', async function (event) {
        event.preventDefault();
        var data = new FormData(form);
        var email = String(data.get('email') || '').trim();
        var password = String(data.get('password') || '');
        if (!email || !password) {
          adminNote('Enter the administrator email and password.', true);
          return;
        }
        adminNote('Signing in…');
        var result = await api('/api/auth/login', { method: 'POST', body: { email: email, password: password } });
        if (!result.ok) {
          adminNote(message(result, 'Sign-in failed.'), true);
          return;
        }
        var user = result.data && result.data.user;
        if (!user || user.role !== 'admin') {
          adminNote('That account is not an administrator.', true);
          return;
        }
        form.reset();
        if (typeof window.setSignedIn === 'function') window.setSignedIn(user);
        unlockAdmin(user);
      });
    }

    document.querySelectorAll('[data-admin-tab]').forEach(function (tab) {
      tab.addEventListener('click', function () {
        switchTab(tab.getAttribute('data-admin-tab'));
      });
    });

    if ($('adminVideoAddBtn')) $('adminVideoAddBtn').addEventListener('click', addVideo);
    if ($('adminLiveAddBtn')) $('adminLiveAddBtn').addEventListener('click', addLive);
    if ($('adminRevAddBtn')) $('adminRevAddBtn').addEventListener('click', addRevenue);
    if ($('adminDistributeBtn')) $('adminDistributeBtn').addEventListener('click', distribute);
    if ($('adminMetricAddBtn')) $('adminMetricAddBtn').addEventListener('click', addMetric);
    if ($('adminSettingsSave')) $('adminSettingsSave').addEventListener('click', saveSettings);
  }

  function bindWallet() {
    if ($('walletSaveBtn')) $('walletSaveBtn').addEventListener('click', saveWallet);
    if ($('withdrawBtn')) $('withdrawBtn').addEventListener('click', requestWithdrawal);
  }

  async function checkAdminSession() {
    var result = await api('/api/auth/me');
    var user = result.ok && result.data && result.data.user;
    if (user && user.role === 'admin') {
      revealEntry();
      unlockAdmin(user);
    } else if (!user) {
      lockAdmin();
    }
  }

  function boot() {
    bindAdmin();
    bindWallet();

    var wantsAdmin = /(?:\?|&)admin=1(?:&|$)/.test(window.location.search);
    if (wantsAdmin) revealEntry();

    document.addEventListener('josh:page', function (event) {
      var id = event && event.detail && event.detail.id;
      if (id === 'admin') {
        if (state.user && state.user.role === 'admin') loadTab(state.tab);
        else checkAdminSession();
      }
      if (id === 'wallet') loadWallet();
    });

    /* Keep the private panel in sync when the main site signs a user in/out. */
    var original = window.setSignedIn;
    if (typeof original === 'function') {
      window.setSignedIn = function (user) {
        original(user);
        if (user && user.role === 'admin') unlockAdmin(user);
        else if (!user) lockAdmin();
      };
    }

    var walletSection = $('wallet');
    if (walletSection && !walletSection.classList.contains('hidden')) loadWallet();
    if (wantsAdmin) checkAdminSession();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
