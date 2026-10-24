/**
 * SHEPU ROOMS — friend-ui.js
 *
 * The Friends panel on index.html. All data comes from Friends; this file
 * only renders, binds and translates errors. Firebase is never loaded for
 * guests or email/demo sessions just to show the panel.
 */

const FriendUI = (() => {
  'use strict';

  const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
  const PRESENCE_TICK_MS = 60 * 1000;

  const els = {};
  let currentTab = 'friends';
  let opened = false;
  let previousFocus = null;
  let presenceTimer = null;
  let lastState = null;

  let searchResult = null;
  let searchError = '';
  let searchBusy = false;
  let handleBusy = false;
  let handleMsg = '';
  let handleMsgType = '';

  // Handle availability is checked against Firestore while the user types.
  // Keeping the sequence number means a slow, older lookup can never
  // overwrite the result for what is currently in the box.
  let handleCheckTimer = null;
  let handleCheckSeq = 0;
  let handleAvailable = null;
  let handleCheckedFor = '';
  let handleChecking = false;

  const busy = new Set();

  const SVG = {
    search: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>',
    send: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>',
    userMinus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="23" y1="11" x2="17" y2="11"></line></svg>',
    refresh: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>',
    users: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    lock: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>',
    warning: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
    check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
    block: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"></line></svg>',
  };

  const AVATAR_COLORS = [
    'linear-gradient(135deg,#2563eb,#1d4ed8)',
    'linear-gradient(135deg,#7c3aed,#6d28d9)',
    'linear-gradient(135deg,#0891b2,#0e7490)',
    'linear-gradient(135deg,#059669,#047857)',
    'linear-gradient(135deg,#d97706,#b45309)',
    'linear-gradient(135deg,#db2777,#be185d)',
  ];

  function esc(value) {
    const s = String(value == null ? '' : value);
    if (typeof window.escapeHtml === 'function') return window.escapeHtml(s);
    return s.replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m]));
  }

  function spin() {
    return '<span class="friends-spinner" aria-hidden="true"></span>';
  }

  function icon(name, size = 16) {
    try {
      if (window.Icons && typeof Icons[name] === 'function') return Icons[name](size);
    } catch { /* fall through */ }
    return SVG[name] || '';
  }

  function $(id) { return document.getElementById(id); }

  function cacheEls() {
    els.modal = $('friends-modal');
    els.openBtn = $('friends-open-btn');
    els.badge = $('friends-badge');
    els.close = $('friends-close');
    els.subtitle = $('friends-subtitle');
    els.gate = $('friends-gate');
    els.gateIcon = $('friends-gate-icon');
    els.gateTitle = $('friends-gate-title');
    els.gateMessage = $('friends-gate-message');
    els.gateAction = $('friends-gate-action');
    els.gateSecondary = $('friends-gate-secondary');
    els.main = $('friends-main');
    els.handleSetup = $('friends-handle-setup');
    els.handleForm = $('friends-handle-form');
    els.handleInput = $('friends-handle-input');
    els.handleSave = $('friends-handle-save');
    els.handleMsg = $('friends-handle-msg');
    els.tabs = document.querySelectorAll('.friends-tab-btn');
    els.tabFriends = $('friends-panel-friends');
    els.tabRequests = $('friends-panel-requests');
    els.tabAdd = $('friends-panel-add');
    els.friendCount = $('friends-tab-count');
    els.requestCount = $('friends-requests-count');
    els.list = $('friends-list');
    els.listNote = $('friends-list-note');
    els.loadMore = $('friends-load-more');
    els.incomingList = $('friends-incoming-list');
    els.outgoingList = $('friends-outgoing-list');
    els.requestsEmpty = $('friends-requests-empty');
    els.searchForm = $('friends-search-form');
    els.searchInput = $('friends-search-input');
    els.searchBtn = $('friends-search-btn');
    els.searchResult = $('friends-search-result');
    els.addNote = $('friends-add-note');
    els.footerHandle = $('friends-footer-handle');
    els.footerCopyHandle = $('friends-copy-handle');
    els.footerPresence = $('friends-footer-presence');
  }

  function bind() {
    if (els.openBtn) {
      els.openBtn.addEventListener('click', () => {
        const state = Friends.getState();
        // Open the tab that matters: pending requests first, then the friend
        // list, and "Add friend" only for someone who has no friends yet.
        const tab = (state.incoming && state.incoming.length)
          ? 'requests'
          : ((state.totalFriends || (state.friends || []).length) ? 'friends' : 'add');
        open(tab);
      });
    }
    if (els.close) els.close.addEventListener('click', close);
    if (els.modal) {
      els.modal.addEventListener('click', (e) => {
        if (e.target === els.modal) close();
      });
    }

    els.tabs.forEach((btn) => {
      btn.addEventListener('click', () => setTab(btn.dataset.tab, true));
    });

    // Standard tablist keyboard support: arrows move between tabs, Home and
    // End jump to the first and last one.
    const tablist = els.tabs.length ? els.tabs[0].parentElement : null;
    if (tablist) {
      tablist.addEventListener('keydown', (e) => {
        const order = ['add', 'requests', 'friends'];
        const i = order.indexOf(currentTab);
        if (i < 0) return;
        let next = null;
        if (e.key === 'ArrowRight') next = order[(i + 1) % order.length];
        else if (e.key === 'ArrowLeft') next = order[(i - 1 + order.length) % order.length];
        else if (e.key === 'Home') next = order[0];
        else if (e.key === 'End') next = order[order.length - 1];
        if (!next) return;
        e.preventDefault();
        setTab(next, true);
      });
    }

    if (els.handleForm) {
      els.handleForm.addEventListener('submit', (e) => {
        e.preventDefault();
        claimHandle();
      });
    }

    if (els.handleInput) {
      els.handleInput.addEventListener('input', scheduleHandleCheck);
    }

    if (els.footerCopyHandle) {
      els.footerCopyHandle.addEventListener('click', copyOwnHandle);
    }

    if (els.modal) els.modal.addEventListener('keydown', trapFocus);

    if (els.searchForm) {
      els.searchForm.addEventListener('submit', (e) => {
        e.preventDefault();
        runSearch();
      });
    }

    if (els.loadMore) {
      els.loadMore.addEventListener('click', () => {
        Friends.loadMoreFriends().catch((err) => {
          UI.toast('error', 'Friends', Friends.friendly(err));
        });
      });
    }

    if (els.main) els.main.addEventListener('click', onAction);
    if (els.gateAction) els.gateAction.addEventListener('click', onGateAction);
    if (els.gateSecondary) els.gateSecondary.addEventListener('click', close);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && opened) {
        e.stopPropagation();
        close();
      }
    });
  }

  function maybeBackgroundInit() {
    try {
      const auth = Storage.getAuth();
      if (!auth) return;
      const hasToken = !!(Auth.hasGoogleToken && Auth.hasGoogleToken());
      const linked = localStorage.getItem('shepu_social_linked') === '1';
      const eligible = !auth.isDemo && !auth.isEmailAuth
        && !String(auth.accessToken || '').startsWith('email_token_')
        && !String(auth.accessToken || '').startsWith('demo_token_');
      if (!eligible) return;
      if (!hasToken && !linked) return;
      Friends.init().catch(() => {});
    } catch { /* non-fatal */ }
  }

  function open(tab) {
    if (!els.modal) return;
    setTab(tab || currentTab, false);
    previousFocus = document.activeElement;
    opened = true;
    els.modal.classList.remove('hidden');
    els.modal.setAttribute('aria-hidden', 'false');
    document.body.classList.add('friends-modal-open');

    Friends.setPanelVisible(true);
    render(Friends.getState());
    setTimeout(focusInitial, 70);
    startPresenceTimer();

    // Trigger init when the panel is actually opened — covers the case where
    // maybeBackgroundInit() skipped (no token yet) or init stalled.
    const s = Friends.getState();
    if (s.status === 'idle' || s.status === 'error') {
      Friends.init().catch(() => {});
    }
  }

  function close() {
    if (!els.modal || !opened) return;
    opened = false;
    els.modal.classList.add('hidden');
    els.modal.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('friends-modal-open');
    Friends.setPanelVisible(false);
    stopPresenceTimer();
    try {
      if (previousFocus && typeof previousFocus.focus === 'function') {
        previousFocus.focus({ preventScroll: true });
      }
    } catch { /* ignore */ }
  }

  function isVisible(el) {
    return !!(el && el.isConnected && !el.hidden && el.getClientRects().length);
  }

  function focusInitial() {
    try {
      if (!opened) return;
      if (els.gate && !els.gate.hidden) {
        if (els.gateAction && isVisible(els.gateAction)) { els.gateAction.focus(); return; }
        if (els.close) { els.close.focus(); return; }
      }
      if (els.handleSetup && !els.handleSetup.hidden && els.handleInput) {
        els.handleInput.focus();
        return;
      }
      if (currentTab === 'add' && els.searchInput && isVisible(els.searchInput)) {
        els.searchInput.focus();
        return;
      }
      if (currentTab === 'friends' && els.list && isVisible(els.list)) {
        els.list.focus();
        return;
      }
      if (currentTab === 'requests') {
        const first = els.incomingList && els.incomingList.querySelector('button');
        if (first) { first.focus(); return; }
      }
      if (els.close) els.close.focus();
    } catch { /* ignore */ }
  }

  function focusables() {
    if (!els.modal) return [];
    return [...els.modal.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.disabled && isVisible(el));
  }

  // The Friends panel is a modal dialog: Tab must cycle inside it instead of
  // silently moving focus to the page behind the overlay.
  function trapFocus(e) {
    if (!opened || e.key !== 'Tab') return;
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !els.modal.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !els.modal.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  function setTab(tab, focus) {
    if (!['friends', 'requests', 'add'].includes(tab)) return;
    currentTab = tab;
    els.tabs.forEach((btn) => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
      btn.tabIndex = active ? 0 : -1;
    });
    [els.tabFriends, els.tabRequests, els.tabAdd].forEach((panel) => {
      if (!panel) return;
      const active = panel.id === `friends-panel-${tab}`;
      panel.classList.toggle('active', active);
      panel.hidden = !active;
    });
    if (focus) {
      if (tab === 'add' && els.searchInput) els.searchInput.focus();
      else if (tab === 'friends' && els.list) els.list.focus();
      else if (tab === 'requests') {
        const first = els.incomingList && els.incomingList.querySelector('button');
        if (first) first.focus();
      }
    }
  }

  function render(state) {
    lastState = state;
    updateBadge(state);
    if (!opened) return;

    if (state.status === 'gate') {
      showGate(state);
      return;
    }
    if (state.status === 'error') {
      showGate(state);
      return;
    }
    if (state.status === 'idle' || state.status === 'loading') {
      showGate(state);
      return;
    }

    els.gate.hidden = true;
    els.main.hidden = false;
    // Keep the visible panel and the highlighted tab in step even when the
    // panel was opened from a badge or the default markup changed.
    setTab(currentTab, false);

    renderHeader(state);
    renderHandleSetup(state);
    renderFriends(state);
    renderRequests(state);
    renderAdd(state);
    renderFooter(state);
    updateTabs(state);
  }

  function updateBadge(state) {
    const count = state.incoming ? state.incoming.length : 0;
    if (els.badge) {
      els.badge.hidden = count === 0;
      els.badge.textContent = count > 9 ? '9+' : String(count);
    }
    if (els.openBtn) {
      els.openBtn.setAttribute(
        'aria-label',
        count ? `Friends, ${count} pending request${count === 1 ? '' : 's'}` : 'Friends'
      );
    }
  }

  function showGate(state) {
    els.main.hidden = true;
    els.gate.hidden = false;
    els.gateAction.hidden = false;
    els.gateSecondary.hidden = false;
    els.gateAction.disabled = false;

    if (state.status === 'loading' || state.status === 'idle') {
      els.gateIcon.innerHTML = spin();
      els.gateTitle.textContent = 'Connecting to Friends…';
      els.gateMessage.textContent = 'Loading your friend graph. Chat and rooms keep working normally.';
      els.gateAction.hidden = true;
      els.gateSecondary.hidden = true;
      return;
    }

    if (state.status === 'error') {
      els.gateIcon.innerHTML = SVG.warning;
      els.gateTitle.textContent = 'Friends are unavailable';
      els.gateMessage.textContent = (state.error && state.error.message) || 'Something went wrong.';
      els.gateAction.textContent = 'Retry';
      els.gateAction.dataset.action = 'retry';
      els.gateSecondary.textContent = 'Close';
      els.gateSecondary.hidden = false;
      return;
    }

    const gate = state.gate || { kind: 'signin', title: 'Sign in to use Friends', message: '', action: 'Sign in', actionType: 'login' };
    els.gateIcon.innerHTML = gate.kind === 'reconnect' ? SVG.warning : SVG.lock;
    els.gateTitle.textContent = gate.title || 'Sign in to use Friends';
    els.gateMessage.textContent = gate.message || '';
    els.gateAction.textContent = gate.action || 'Continue';
    els.gateAction.dataset.action = gate.actionType || 'login';
    els.gateSecondary.textContent = gate.kind === 'reconnect' ? 'Not now' : 'Keep chatting';
    els.gateSecondary.hidden = false;
  }

  function renderHeader(state) {
    const handle = state.profile && state.profile.handle;
    if (els.subtitle) {
      els.subtitle.textContent = handle
        ? `@${handle} · private by design`
        : 'Private by design · no message data';
    }
  }

  function renderHandleSetup(state) {
    const hasHandle = !!(state.profile && state.profile.handle);
    els.handleSetup.hidden = hasHandle;
    if (hasHandle) return;

    els.handleSave.disabled = handleBusy || handleChecking || handleAvailable === false;
    els.handleSave.textContent = handleBusy ? 'Claiming…' : (handleChecking ? 'Checking…' : 'Claim');
    els.handleMsg.textContent = handleMsg || '';
    els.handleMsg.className = 'friends-hint' + (handleMsgType ? ` is-${handleMsgType}` : '');
  }

  function presence(friend) {
    if (!friend || friend.showPresence === false) return { active: false, text: 'Offline' };
    const ms = tsToMs(friend.lastActiveAt);
    if (!ms) return { active: false, text: 'Offline' };
    const diff = Date.now() - ms;
    if (diff < 0 || diff < ACTIVE_WINDOW_MS) return { active: true, text: 'Active now' };
    return { active: false, text: relative(diff) + ' ago' };
  }

  function tsToMs(ts) {
    if (!ts) return 0;
    try {
      if (typeof ts.toMillis === 'function') return ts.toMillis();
      if (typeof ts.seconds === 'number') return ts.seconds * 1000;
      if (ts instanceof Date) return ts.getTime();
      if (typeof ts === 'number') return ts;
    } catch { /* ignore */ }
    return 0;
  }

  function relative(diff) {
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${Math.max(1, mins)}m`;
    const hours = Math.floor(diff / 3600000);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(diff / 86400000);
    if (days < 7) return `${days}d`;
    try {
      return new Date(Date.now() - diff).toLocaleDateString();
    } catch {
      return `${days}d`;
    }
  }

  function initialsFor(name, handle) {
    const clean = String(name || '').trim();
    if (clean) {
      return clean.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    }
    const h = String(handle || '').replace(/^@/, '');
    return (h.slice(0, 2) || '?').toUpperCase();
  }

  function avatarStyle(uid) {
    const s = String(uid || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function avatarHtml(uid, name, handle, showDot, avatar) {
    const initials = esc(initialsFor(name, handle));
    const img = avatar
      ? `<img class="friends-avatar-img" src="${esc(avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">`
      : '';
    return `<div class="friends-avatar" style="background:${avatarStyle(uid)}"><span class="friends-avatar-initials">${initials}</span>${img}${showDot ? '<span class="friends-active-dot" aria-label="Active now"></span>' : ''}</div>`;
  }

  function timeAgo(ts) {
    const ms = tsToMs(ts);
    if (!ms) return '';
    const diff = Date.now() - ms;
    if (diff < 0 || diff < 60000) return 'just now';
    return relative(diff) + ' ago';
  }

  function byNewest(a, b) {
    return tsToMs(b && b.createdAt) - tsToMs(a && a.createdAt);
  }

  function renderFriends(state) {
    if (!els.list) return;
    const friends = state.friends || [];
    const parts = [];

    if (state.friendsLoading && friends.length === 0) {
      parts.push('<div class="friends-skeleton"></div><div class="friends-skeleton"></div><div class="friends-skeleton"></div>');
      els.list.innerHTML = parts.join('');
      els.listNote.textContent = '';
      els.listNote.hidden = true;
      els.loadMore.hidden = true;
      return;
    }

    if (state.failedFriendReads > 0 || state.friendsError) {
      const msg = state.friendsError || 'Some friends could not be loaded. Check your connection.';
      parts.push(`<div class="friends-banner">${esc(msg)} <button type="button" class="friends-link-btn" data-action="refresh">${SVG.refresh} Refresh</button></div>`);
    }

    if (friends.length === 0) {
      if (state.totalFriends > 0) {
        parts.push(`<div class="friends-empty">${icon('users', 30)}<div class="friends-empty-title">Couldn't load your friends</div><div>Try refreshing. Your friend list is only read when this panel is open.</div><button type="button" class="friends-btn primary small" data-action="refresh">${SVG.refresh} Refresh</button></div>`);
      } else {
        parts.push(`<div class="friends-empty">${icon('users', 30)}<div class="friends-empty-title">No friends yet</div><div>Find people by their exact @handle. They never see your email or rooms.</div><button type="button" class="friends-btn primary small" data-action="go-add">Find friends</button></div>`);
      }
    } else {
      friends.forEach((friend) => {
        const p = presence(friend);
        const name = friend.name || 'Pchat user';
        const handleText = friend.handle ? `@${friend.handle}` : (friend.missing ? 'Profile unavailable' : 'No handle');
        const meta = `${handleText} · ${p.text}`;
        parts.push(`
          <div class="friends-row" data-uid="${esc(friend.uid)}">
            ${avatarHtml(friend.uid, name, friend.handle, p.active, friend.avatar)}
            <div class="friends-info">
              <div class="friends-name">${esc(name)}</div>
              <div class="friends-subline${p.active ? ' is-active' : ''}">${esc(meta)}</div>
            </div>
            <button type="button" class="friends-icon-btn" data-action="invite-room" data-uid="${esc(friend.uid)}" title="Invite ${esc(name)} to a room" aria-label="Invite ${esc(name)} to a room">${SVG.send}</button>
            <button type="button" class="friends-icon-btn" data-action="block" data-uid="${esc(friend.uid)}" title="Block ${esc(name)}" aria-label="Block ${esc(name)}">${SVG.block}</button>
            <button type="button" class="friends-icon-btn" data-action="unfriend" data-uid="${esc(friend.uid)}" title="Unfriend ${esc(name)}" aria-label="Unfriend ${esc(name)}">${SVG.userMinus}</button>
          </div>`);
      });
      if (state.friendsLoading) {
        parts.push(`<div class="friends-hint friends-refreshing">${spin()} Refreshing…</div>`);
      }
    }

    els.list.innerHTML = parts.join('');
    els.listNote.textContent = '';
    els.listNote.hidden = true;
    els.loadMore.hidden = !state.hasMoreFriends;
    els.loadMore.textContent = `Show more friends (${state.totalFriends - friends.length} left)`;
  }

  function requestName(req) {
    return req.fromName || 'Someone';
  }

  function renderRequests(state) {
    if (!els.incomingList || !els.outgoingList) return;
    const incoming = (state.incoming || []).slice().sort(byNewest);
    const outgoing = (state.outgoing || []).slice().sort(byNewest);

    const incomingHtml = incoming.length
      ? incoming.map((req) => {
        const name = requestName(req);
        const handle = req.fromHandle ? `@${req.fromHandle}` : 'no handle';
        const when = req.createdAt ? ` · ${timeAgo(req.createdAt)}` : '';
        const acceptKey = `accept:${req.id}`;
        const declineKey = `decline:${req.id}`;
        return `
          <div class="friends-request-card">
            ${avatarHtml(req.from, name, req.fromHandle, false, req.fromAvatar)}
            <div class="friends-info">
              <div class="friends-name">${esc(name)}</div>
              <div class="friends-subline">${esc(handle)} wants to be friends${when ? esc(when) : ''}</div>
            </div>
            <div class="friends-request-actions">
              <button type="button" class="friends-btn primary small" data-action="accept" data-id="${esc(req.id)}" ${busy.has(acceptKey) ? 'disabled' : ''}>${busy.has(acceptKey) ? '…' : 'Accept'}</button>
              <button type="button" class="friends-btn ghost small" data-action="decline" data-id="${esc(req.id)}" ${busy.has(declineKey) ? 'disabled' : ''}>${busy.has(declineKey) ? '…' : 'Decline'}</button>
            </div>
          </div>`;
      }).join('')
      : '<div class="friends-empty small">No pending requests.</div>';

    const outgoingHtml = outgoing.length
      ? outgoing.map((req) => {
        const label = req.toHandle ? `@${req.toHandle}` : 'a user';
        const key = `cancel:${req.id}`;
        return `
          <div class="friends-request-card">
            ${avatarHtml(req.to, '', req.toHandle, false, req.toAvatar)}
            <div class="friends-info">
              <div class="friends-name">${esc(label)}</div>
              <div class="friends-subline">${req.createdAt ? `Sent ${timeAgo(req.createdAt)} · ` : ''}Waiting for a reply</div>
            </div>
            <button type="button" class="friends-btn ghost small" data-action="cancel" data-id="${esc(req.id)}" ${busy.has(key) ? 'disabled' : ''}>${busy.has(key) ? '…' : 'Cancel'}</button>
          </div>`;
      }).join('')
      : '<div class="friends-empty small">No sent requests.</div>';

    els.incomingList.innerHTML = `
      <div class="friends-section-title">Requests for you ${incoming.length ? `<span class="friends-pill">${incoming.length}</span>` : ''}</div>
      ${incomingHtml}`;
    els.outgoingList.innerHTML = `
      <div class="friends-section-title">Sent ${outgoing.length ? `<span class="friends-pill muted">${outgoing.length}</span>` : ''}</div>
      ${outgoingHtml}`;
    if (els.requestsEmpty) els.requestsEmpty.hidden = (incoming.length + outgoing.length) > 0;
  }

  function renderAdd(state) {
    if (!els.searchForm) return;
    const hasHandle = !!(state.profile && state.profile.handle);
    els.searchForm.hidden = !hasHandle;
    if (els.addNote) els.addNote.hidden = true;

    if (!hasHandle) {
      els.searchResult.innerHTML = `<div class="friends-empty small">${icon('lock', 24)}<div>Claim your handle above, then search for friends.</div></div>`;
      return;
    }

    if (searchBusy) {
      els.searchResult.innerHTML = `<div class="friends-hint friends-refreshing">${spin()} Searching…</div>`;
      return;
    }
    if (searchError) {
      els.searchResult.innerHTML = `<div class="friends-banner is-error">${esc(searchError)}</div>`;
      return;
    }
    if (!searchResult) {
      els.searchResult.innerHTML = `<div class="friends-empty small">${SVG.lock}<div>Search by exact @handle. Your email, rooms and messages stay private.</div></div>`;
      return;
    }

    const r = searchResult;
    const handle = `@${r.handle}`;
    if (!r.found) {
      els.searchResult.innerHTML = `<div class="friends-empty small">${icon('search', 26)}<div>No user found with <strong>${esc(handle)}</strong>.</div></div>`;
      return;
    }
    if (r.isSelf) {
      els.searchResult.innerHTML = `<div class="friends-result-card"><div class="friends-result-main">${esc(handle)}</div><div class="friends-hint">That is your own handle.</div></div>`;
      return;
    }
    if (r.isFriend) {
      els.searchResult.innerHTML = `<div class="friends-result-card"><div class="friends-result-main">${esc(handle)}</div><div class="friends-hint">You are already friends.</div></div>`;
      return;
    }
    if (r.blocked) {
      els.searchResult.innerHTML = `<div class="friends-result-card"><div class="friends-result-main">${esc(handle)}</div><div class="friends-hint">You blocked this user. Unblock them in Settings → Friends first.</div></div>`;
      return;
    }
    if (r.incoming && r.incomingRequest) {
      const key = `accept:${r.incomingRequest.id}`;
      els.searchResult.innerHTML = `
        <div class="friends-result-card">
          <div class="friends-result-main">${esc(handle)}</div>
          <div class="friends-hint">They already sent you a request.</div>
          <div class="friends-result-actions">
            <button type="button" class="friends-btn primary small" data-action="accept" data-id="${esc(r.incomingRequest.id)}" ${busy.has(key) ? 'disabled' : ''}>${busy.has(key) ? '…' : 'Accept request'}</button>
          </div>
        </div>`;
      return;
    }
    if (r.outgoing) {
      const out = (state.outgoing || []).find((req) => req.to === r.uid);
      const key = out ? `cancel:${out.id}` : '';
      els.searchResult.innerHTML = `
        <div class="friends-result-card">
          <div class="friends-result-main">${esc(handle)}</div>
          <div class="friends-hint">Request sent. Waiting for a reply.</div>
          ${out ? `<div class="friends-result-actions"><button type="button" class="friends-btn ghost small" data-action="cancel" data-id="${esc(out.id)}" ${busy.has(key) ? 'disabled' : ''}>${busy.has(key) ? '…' : 'Cancel request'}</button></div>` : ''}
        </div>`;
      return;
    }

    els.searchResult.innerHTML = `
      <div class="friends-result-card">
        <div class="friends-result-main">${esc(handle)}</div>
        <div class="friends-hint">A request lets them see your name and handle. Your email and rooms stay private.</div>
        <div class="friends-result-actions">
          <button type="button" class="friends-btn primary small" data-action="send" ${busy.has('send') ? 'disabled' : ''}>${busy.has('send') ? 'Sending…' : `${SVG.send} Send request`}</button>
        </div>
      </div>`;
  }

  function renderFooter(state) {
    const handle = state.profile && state.profile.handle;
    if (els.footerHandle) els.footerHandle.textContent = handle ? `@${handle}` : 'No handle yet';
    if (els.footerCopyHandle) {
      els.footerCopyHandle.hidden = !handle;
      els.footerCopyHandle.title = handle ? `Copy @${handle} to share with a friend` : '';
    }
    if (els.footerPresence) els.footerPresence.textContent = 'Active = seen in the last 15 minutes';
  }

  function updateTabs(state) {
    if (els.friendCount) {
      els.friendCount.textContent = state.totalFriends ? String(state.totalFriends) : '';
      els.friendCount.hidden = !state.totalFriends;
    }
    if (els.requestCount) {
      els.requestCount.textContent = state.incoming.length ? String(state.incoming.length) : '';
      els.requestCount.hidden = !state.incoming.length;
    }
  }

  // Check the handle against Firestore a moment after typing stops. The
  // permanent commitment deserves a real availability answer, not a format
  // check followed by a surprise at submit time.
  function scheduleHandleCheck() {
    clearTimeout(handleCheckTimer);
    const handle = Friends.normalizeHandle(els.handleInput.value);
    handleAvailable = null;
    handleCheckedFor = '';
    handleChecking = false;

    if (!handle) {
      handleMsg = '';
      handleMsgType = '';
      render(lastState || Friends.getState());
      return;
    }
    if (!Friends.HANDLE_RE.test(handle)) {
      handleMsg = 'Use 3–20 characters: a–z, 0–9, or _';
      handleMsgType = 'error';
      render(lastState || Friends.getState());
      return;
    }

    handleChecking = true;
    handleMsg = 'Checking availability…';
    handleMsgType = '';
    render(lastState || Friends.getState());

    const seq = ++handleCheckSeq;
    handleCheckTimer = setTimeout(async () => {
      try {
        const result = await Friends.checkHandle(handle);
        if (seq !== handleCheckSeq) return;
        handleChecking = false;
        handleCheckedFor = handle;
        handleAvailable = !!(result && result.available);
        if (handleAvailable) {
          handleMsg = `@${handle} is available`;
          handleMsgType = 'ok';
        } else {
          handleMsg = `@${handle} is already taken. Try another one.`;
          handleMsgType = 'error';
        }
      } catch (err) {
        if (seq !== handleCheckSeq) return;
        handleChecking = false;
        handleAvailable = null;
        handleMsg = Friends.friendly(err);
        handleMsgType = 'error';
      }
      render(lastState || Friends.getState());
    }, 450);
  }

  async function claimHandle() {
    if (handleBusy) return;
    const handle = Friends.normalizeHandle(els.handleInput.value);
    handleMsg = '';
    handleMsgType = '';
    if (!Friends.HANDLE_RE.test(handle)) {
      handleMsg = 'Use 3–20 characters: a–z, 0–9, or _';
      handleMsgType = 'error';
      render(lastState || Friends.getState());
      els.handleInput.focus();
      return;
    }
    if (handleAvailable === false && handleCheckedFor === handle) {
      handleMsg = `@${handle} is already taken. Try another one.`;
      handleMsgType = 'error';
      render(lastState || Friends.getState());
      els.handleInput.focus();
      return;
    }

    const ok = await UI.confirmDialog({
      title: `Claim @${handle}?`,
      message: 'Friends will find you by this handle. It is permanent in v1 and cannot be changed later.',
      confirmText: 'Claim handle',
      cancelText: 'Choose another',
    });
    if (!ok) {
      els.handleInput.focus();
      return;
    }

    handleBusy = true;
    render(lastState || Friends.getState());
    try {
      await Friends.claimHandle(handle);
      handleMsg = '';
      handleMsgType = '';
      handleAvailable = null;
      handleCheckedFor = '';
      els.handleInput.value = '';
      UI.toast('success', 'Handle claimed', `You are now @${handle}. Copy it from the footer to share.`);
      currentTab = 'add';
      setTab('add', false);
      setTimeout(() => { try { els.searchInput.focus(); } catch {} }, 80);
    } catch (err) {
      handleMsg = Friends.friendly(err);
      handleMsgType = 'error';
      UI.toast('error', 'Could not claim handle', handleMsg);
    } finally {
      handleBusy = false;
      render(Friends.getState());
    }
  }

  async function copyOwnHandle() {
    const handle = (Friends.getState().profile && Friends.getState().profile.handle) || '';
    if (!handle) return;
    let ok = false;
    try { ok = await UI.copyText('@' + handle); } catch { ok = false; }
    if (ok) UI.toast('success', 'Handle copied', `Send @${handle} to a friend so they can add you.`);
    else UI.toast('error', 'Copy failed', 'Your browser blocked clipboard access.');
  }

  async function runSearch() {
    if (searchBusy) return;
    const state = Friends.getState();
    if (!(state.profile && state.profile.handle)) {
      searchError = 'Claim your handle first.';
      render(state);
      return;
    }
    const handle = Friends.normalizeHandle(els.searchInput.value);
    if (!Friends.HANDLE_RE.test(handle)) {
      searchError = 'Use an exact handle: 3–20 characters (a–z, 0–9, _).';
      searchResult = null;
      render(state);
      return;
    }

    searchBusy = true;
    searchError = '';
    searchResult = null;
    render(state);
    try {
      searchResult = await Friends.search(handle);
    } catch (err) {
      searchError = Friends.friendly(err);
    } finally {
      searchBusy = false;
      render(Friends.getState());
    }
  }

  async function sendRequest() {
    if (!searchResult || !searchResult.found || searchResult.isSelf || searchResult.isFriend) return;
    if (busy.has('send')) return;
    busy.add('send');
    render(lastState || Friends.getState());
    try {
      await Friends.sendRequest({ uid: searchResult.uid, handle: searchResult.handle });
      searchResult = { ...searchResult, outgoing: true };
      searchError = '';
      UI.toast('success', 'Request sent', `Waiting for @${searchResult.handle} to reply.`);
    } catch (err) {
      searchError = Friends.friendly(err);
      UI.toast('error', 'Request not sent', searchError);
    } finally {
      busy.delete('send');
      render(Friends.getState());
    }
  }

  // Close the loop after accepting a friend: let them invite that friend to
  // one of their rooms without first having to open the room's share modal.
  function openRoomChooser(friend) {
    if (!friend) return;
    if (typeof Rooms === 'undefined' || typeof Rooms.getMyRooms !== 'function') {
      UI.toast('info', 'Rooms unavailable', 'Open a room to invite a friend.');
      return;
    }
    let rooms = [];
    try {
      const seen = new Set();
      [...(Rooms.getMyRooms() || []), ...(Rooms.getJoinedRooms() || [])].forEach((r) => {
        if (!r || !r.id || seen.has(r.id)) return;
        seen.add(r.id);
        rooms.push(r);
      });
    } catch { rooms = []; }

    if (!rooms.length) {
      UI.toast('info', 'No rooms yet', 'Create or join a room first, then invite a friend to it.');
      return;
    }
    if (rooms.length === 1) {
      openInviteForRoom(rooms[0], friend);
      return;
    }

    const overlay = document.createElement('div');
    overlay.className = 'friends-room-picker';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Choose a room');
    overlay.innerHTML = `
      <div class="friends-room-picker-card">
        <div class="friends-room-picker-head">
          <div>
            <div class="friends-room-picker-title">Invite ${esc(friend.name || 'friend')}</div>
            <div class="friends-room-picker-sub">Choose a room — the invite is encrypted.</div>
          </div>
          <button type="button" class="friends-icon-btn" data-close aria-label="Close">${SVG.close}</button>
        </div>
        <div class="friends-room-picker-list" role="list"></div>
      </div>`;
    const list = overlay.querySelector('.friends-room-picker-list');
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    rooms.forEach((room) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'friends-room-choice';
      b.setAttribute('role', 'listitem');
      b.textContent = room.name || 'Private room';
      b.addEventListener('click', () => {
        close();
        openInviteForRoom(room, friend);
      });
      list.appendChild(b);
    });
    overlay.querySelector('[data-close]').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    overlay.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const items = [...overlay.querySelectorAll('button')].filter((el) => !el.disabled && el.getClientRects().length);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    const first = overlay.querySelector('.friends-room-choice');
    if (first) setTimeout(() => first.focus(), 40);
  }

  function openInviteForRoom(room, friend) {
    if (typeof Invites === 'undefined' || typeof Invites.openPicker !== 'function') {
      UI.toast('error', 'Invites unavailable', 'Friends are still connecting. Try again in a moment.');
      return;
    }
    if (typeof Rooms === 'undefined' || typeof Rooms.getShareUrls !== 'function') {
      UI.toast('error', 'Room not ready', 'Open the room and invite from there.');
      return;
    }
    try {
      const urls = Rooms.getShareUrls(room.id, room.deploymentUrl, room.name);
      Invites.openPicker({
        roomId: room.id,
        roomName: room.name || 'Private room',
        link: urls.defaultUrl,
        passwordLocked: !!room.passwordLocked,
        preselectUid: friend.uid,
      });
    } catch (err) {
      UI.toast('error', 'Invite not ready', (err && err.message) || 'Open the room and try again.');
    }
  }

  async function onAction(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || !els.main.contains(btn)) return;
    const action = btn.dataset.action;
    const state = Friends.getState();

    if (action === 'go-add') {
      setTab('add', true);
      if (state.profile && !state.profile.handle && els.handleInput) els.handleInput.focus();
      return;
    }
    if (action === 'refresh') {
      Friends.refresh({ force: true }).catch((err) => {
        UI.toast('error', 'Friends', Friends.friendly(err));
      });
      return;
    }
    if (action === 'invite-room') {
      const friend = (state.friends || []).find((f) => f.uid === btn.dataset.uid);
      if (friend) openRoomChooser(friend);
      return;
    }
    if (action === 'block') {
      const friend = (state.friends || []).find((f) => f.uid === btn.dataset.uid);
      if (!friend) return;
      const confirmed = await UI.confirmDialog({
        title: `Block ${friend.name || 'this user'}?`,
        message: 'They will be removed from your friends and cannot send new friend requests or room invites. You can unblock them later in Settings → Friends.',
        confirmText: 'Block',
        cancelText: 'Cancel',
        danger: true,
      });
      if (!confirmed) return;
      try {
        await Friends.block(friend.uid, { name: friend.name, handle: friend.handle });
        UI.toast('info', 'Blocked', `${friend.name || 'User'} can no longer contact you through Friends.`);
      } catch (err) {
        UI.toast('error', 'Could not block', Friends.friendly(err));
      }
      return;
    }
    if (action === 'unfriend') {
      const friendUid = btn.dataset.uid;
      const friend = (state.friends || []).find((f) => f.uid === friendUid);
      if (!friend) return;
      const ok = await UI.confirmDialog({
        title: 'Unfriend?',
        message: `${friend.name || 'This user'} will be removed from your friends list on both sides.`,
        confirmText: 'Unfriend',
        cancelText: 'Keep',
        danger: true,
      });
      if (!ok) return;
      const key = `unfriend:${friendUid}`;
      if (busy.has(key)) return;
      busy.add(key);
      render(state);
      try {
        await Friends.unfriend(friendUid);
        UI.toast('info', 'Unfriended', `${friend.name || 'User'} was removed.`);
      } catch (err) {
        UI.toast('error', 'Could not unfriend', Friends.friendly(err));
      } finally {
        busy.delete(key);
        render(Friends.getState());
      }
      return;
    }
    if (action === 'accept') {
      const req = (state.incoming || []).find((r) => r.id === btn.dataset.id);
      if (!req) return;
      const key = `accept:${req.id}`;
      if (busy.has(key)) return;
      busy.add(key);
      render(state);
      try {
        await Friends.acceptRequest(req);
        UI.toast('success', 'Friend added', `${req.fromName || 'Your friend'} is now in your friends list.`);
      } catch (err) {
        UI.toast('error', 'Could not accept', Friends.friendly(err));
      } finally {
        busy.delete(key);
        render(Friends.getState());
      }
      return;
    }
    if (action === 'decline') {
      const req = (state.incoming || []).find((r) => r.id === btn.dataset.id);
      if (!req) return;
      const key = `decline:${req.id}`;
      if (busy.has(key)) return;
      busy.add(key);
      render(state);
      try {
        await Friends.declineRequest(req);
        UI.toast('info', 'Request declined', 'The request was removed.');
      } catch (err) {
        UI.toast('error', 'Could not decline', Friends.friendly(err));
      } finally {
        busy.delete(key);
        render(Friends.getState());
      }
      return;
    }
    if (action === 'cancel') {
      const req = (state.outgoing || []).find((r) => r.id === btn.dataset.id);
      if (!req) return;
      const key = `cancel:${req.id}`;
      if (busy.has(key)) return;
      busy.add(key);
      render(state);
      try {
        await Friends.cancelRequest(req);
        UI.toast('info', 'Request canceled', 'You can send a new request later.');
      } catch (err) {
        UI.toast('error', 'Could not cancel', Friends.friendly(err));
      } finally {
        busy.delete(key);
        render(Friends.getState());
      }
      return;
    }
    if (action === 'send') {
      await sendRequest();
    }
  }

  async function onGateAction() {
    const action = els.gateAction.dataset.action;
    if (action === 'login') {
      const redirect = location.pathname + location.search;
      location.href = 'login.html?redirect=' + encodeURIComponent(redirect);
      return;
    }
    if (action === 'reconnect') {
      if (els.gateAction.disabled) return;
      els.gateAction.disabled = true;
      els.gateAction.textContent = 'Reconnecting…';
      try {
        await Friends.reconnect();
        UI.toast('success', 'Google connected', 'Friends are ready.');
      } catch (err) {
        UI.toast('error', 'Reconnect failed', Friends.friendly(err));
      } finally {
        render(Friends.getState());
      }
      return;
    }
    if (action === 'retry' || action === 'close') {
      if (action === 'close') { close(); return; }
      Friends.init({ force: true }).catch((err) => {
        UI.toast('error', 'Friends', Friends.friendly(err));
      });
    }
  }

  function onEvent(type, payload) {
    // Request toasts are announced centrally by friends.js so they also show
    // on room/settings pages. Only the acceptance confirmation lives here.
    if (type === 'friend-accepted') {
      const msg = payload && payload.handle
        ? `@${payload.handle} accepted your request.`
        : 'Your friend request was accepted.';
      UI.toast('success', 'Friend added', msg, 5000);
    }
  }

  function startPresenceTimer() {
    stopPresenceTimer();
    presenceTimer = setInterval(() => {
      if (!opened) return;
      const state = Friends.getState();
      if (state.status !== 'ready') return;

      // Re-render the relative labels every minute without a read.
      renderFriends(state);

      // While the panel stays open, let the 5-minute cache decide when a
      // presence refresh is due. When the rows are fresh this is a local
      // no-op; when they expire it re-reads the visible page once.
      Friends.refresh().catch(() => { /* keep cached rows */ });
    }, PRESENCE_TICK_MS);
  }

  function stopPresenceTimer() {
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
  }

  function init() {
    cacheEls();
    if (!els.modal) return;
    bind();
    Friends.subscribe(render);
    Friends.subscribe((state) => {
      // When Friends confirms a handle exists, persist a fast-path flag so
      // login.html skips the setup-handle page for this user on all future logins.
      if (state.status === 'ready' && state.profile && state.profile.handle) {
        try { localStorage.setItem('shepu_handle_set', '1'); } catch { /**/ }
      }
    });
    Friends.onEvent(onEvent);
    maybeBackgroundInit();
    render(Friends.getState());
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    open,
    close,
    refresh: () => Friends.refresh({ force: true }),
    _state: () => Friends.getState(),
  };
})();

window.FriendUI = FriendUI;
