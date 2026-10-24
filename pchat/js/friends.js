/**
 * SHEPU ROOMS — friends.js
 *
 * Social graph data layer. Firebase is used ONLY for identity, the friend
 * graph and presence timestamps. Messages and rooms never touch Firestore.
 *
 * Public surface:
 *   Friends.init({force})
 *   Friends.reconnect()
 *   Friends.refresh({force})
 *   Friends.setPanelVisible(bool)
 *   Friends.getState()
 *   Friends.subscribe(fn) / Friends.onEvent(fn)
 *   Friends.claimHandle(handle)
 *   Friends.search(handle)
 *   Friends.sendRequest({uid, handle})
 *   Friends.acceptRequest(request)
 *   Friends.declineRequest(request)
 *   Friends.cancelRequest(request)
 *   Friends.unfriend(uid)
 *   Friends.reset()
 *   Friends.debug()
 *
 * The module never opens a Google popup on its own. A popup is only opened
 * from Friends.reconnect(), which must be called from a click handler.
 */

const Friends = (() => {
  'use strict';

  const ACTIVE_WINDOW_MS = 15 * 60 * 1000;
  const FRIEND_PAGE_SIZE = 20;
  // Friend rows are cached for five minutes, in memory and in localStorage.
  // The panel still has a manual Refresh button. This is the main read-quota
  // guard: reopening the panel or reloading the page must not re-read 20 docs.
  const REFRESH_CACHE_MS = 5 * 60 * 1000;
  const FRIENDS_CACHE_PREFIX = 'shepu_friends_cache_';
  const HANDLE_RE = /^[a-z0-9_]{3,20}$/;

  // Presence: write at most once per 12 minutes, only while the page is
  // visible and the user has interacted in the last two minutes. This keeps
  // an idle tab from writing forever and leaves a 3-minute safety margin.
  const PRESENCE_THROTTLE_MS = (typeof Firebase !== 'undefined'
    && Firebase.PRESENCE_THROTTLE_MS) || 12 * 60 * 1000;
  const PRESENCE_CHECK_MS = 60 * 1000;
  const PRESENCE_IDLE_MS = 2 * 60 * 1000;
  const PRESENCE_LOCK_MS = 30 * 1000;

  let fsMod = null;
  let db = null;
  let auth = null;
  let uid = null;

  let status = 'idle'; // idle | loading | ready | gate | error
  let gate = null;
  let error = null;
  let listenerError = null;

  let profile = null;
  let friends = [];
  let incoming = [];
  let outgoing = [];
  let friendLimit = FRIEND_PAGE_SIZE;
  let friendsLoading = false;
  let friendsError = null;
  let failedFriendReads = 0;

  let lastRefreshAt = 0;
  let lastProfileAt = 0;
  let friendsLoaded = false;
  let panelVisible = false;
  let initPromise = null;

  let unsubIncoming = null;
  let unsubOutgoing = null;
  let listenersAttached = false;
  let firstIncoming = true;
  let firstOutgoing = true;

  const selfHandling = new Set();
  let profileRefreshTimer = null;
  let profileRefreshQueue = [];

  let presenceTimer = null;
  let presenceBound = false;
  let presenceLastWriteAt = 0;
  let presenceLastInteractionAt = 0;
  let presenceWriteInFlight = false;
  let presenceDisabled = false;

  const stateListeners = new Set();
  const eventListeners = new Set();

  // ── Small helpers ──────────────────────────────────────────────
  function makeError(code, message, cause) {
    const e = new Error(message || code);
    e.code = code;
    if (cause) e.cause = cause;
    return e;
  }

  function gateError(kind, message) {
    const e = makeError('firebase/gate/' + kind, message);
    e.isGate = true;
    e.gateKind = kind;
    return e;
  }

  function friendly(err) {
    if (!err) return 'Something went wrong.';
    const custom = {
      'friends/not-ready': 'Friends are still connecting. Try again in a moment.',
      'friends/no-handle': 'Choose your @handle first, then send the request.',
      'friends/handle-invalid': 'Handle must be 3–20 characters: a–z, 0–9, or _.',
      'friends/handle-taken': 'That handle is already taken. Try another one.',
      'friends/handle-set': 'Your handle is already set. It cannot be changed in v1.',
      'friends/self': 'That is your own handle.',
      'friends/not-found': 'No user found with that handle.',
      'friends/already-friends': 'You are already friends.',
      'friends/already-pending': 'A friend request is already pending.',
      'friends/not-friends': 'You are not friends with this user.',
      'friends/blocked': 'You blocked this user. Unblock them in Settings → Friends first.',
      'friends/not-recipient': 'This request is not addressed to you.',
      'friends/not-sender': 'This request was not sent by you.',
      'friends/profile-missing': 'Your social profile is missing. Reconnect to recreate it.',
      'firebase/gate/signin': 'Sign in with Google to use Friends.',
      'firebase/gate/google': 'Friends need a Google sign-in. Chat keeps working without it.',
      'firebase/gate/reconnect': 'Your Google session expired. Reconnect to use Friends.',
      'firebase/not-configured': 'Friends are not available in this build yet.',
      'firebase/not-google': 'Friends need a Google sign-in. Chat keeps working without it.',
      'permission-denied': 'Friends could not complete that just now. Please try again.',
      'failed-precondition': 'Friends are temporarily unavailable. Please try again.',
      'resource-exhausted': 'Friends are paused for a little while. Chat still works.',
      'unavailable': 'Friends are offline right now. Chat still works.',
    };
    if (custom[err.code]) return custom[err.code];
    if (typeof Firebase !== 'undefined' && Firebase.friendlyError) {
      const mapped = Firebase.friendlyError(err);
      if (mapped && mapped !== String(err)) return mapped;
    }
    return err.message || String(err);
  }

  function normalizeHandle(raw) {
    return String(raw == null ? '' : raw).trim().replace(/^@+/, '').toLowerCase();
  }

  function normalizeProfile(data) {
    const d = data || {};
    const list = Array.isArray(d.friendUids) ? d.friendUids : [];
    return {
      name: d.name || '',
      handle: d.handle || '',
      avatar: d.avatar || '',
      pubKey: d.pubKey || null,
      friendUids: [...new Set(list.filter((x) => typeof x === 'string' && x))],
      blockedUids: [...new Set((Array.isArray(d.blockedUids) ? d.blockedUids : [])
        .filter((x) => typeof x === 'string' && x && x !== uid))],
      blockedInfo: (d.blockedInfo && typeof d.blockedInfo === 'object') ? d.blockedInfo : {},
      lastActiveAt: d.lastActiveAt || null,
      showPresence: !(d.flags && d.flags.showPresence === false),
      flags: d.flags || { showPresence: true },
      createdAt: d.createdAt || null,
    };
  }

  function normalizeRequest(id, data) {
    const d = data || {};
    return {
      id,
      from: d.from || '',
      to: d.to || '',
      fromName: d.fromName || '',
      fromHandle: d.fromHandle || '',
      toHandle: d.toHandle || '',
      status: d.status || 'pending',
      createdAt: d.createdAt || null,
    };
  }

  function tsToMillis(ts) {
    if (!ts) return 0;
    try {
      if (typeof ts.toMillis === 'function') return ts.toMillis();
      if (typeof ts.seconds === 'number') return ts.seconds * 1000;
      if (ts instanceof Date) return ts.getTime();
      if (typeof ts === 'number') return ts;
    } catch { /* ignore */ }
    return 0;
  }

  function friendsCacheKey(forUid) {
    return FRIENDS_CACHE_PREFIX + (forUid || uid);
  }

  function clearFriendsCache(forUid) {
    try { localStorage.removeItem(friendsCacheKey(forUid)); } catch { /* ignore */ }
  }

  // Only restore cached rows when the current friendUids match the cache.
  // A newly accepted friend therefore invalidates the old list immediately.
  function readFriendsCache() {
    if (!uid || !profile) return null;
    try {
      const raw = localStorage.getItem(friendsCacheKey());
      if (!raw) return null;
      const cache = JSON.parse(raw);
      if (!cache || cache.uid !== uid
        || !Array.isArray(cache.friendUids) || !Array.isArray(cache.friends)) return null;
      const at = Number(cache.at) || 0;
      if (!at || Date.now() - at > REFRESH_CACHE_MS) return null;

      const current = ownFriendUids();
      if (current.length !== cache.friendUids.length) return null;
      const cached = new Set(cache.friendUids);
      if (!current.every((id) => cached.has(id))) return null;
      return cache;
    } catch {
      return null;
    }
  }

  function writeFriendsCache() {
    if (!uid || !profile || !friendsLoaded) return;
    try {
      localStorage.setItem(friendsCacheKey(), JSON.stringify({
        uid,
        at: Date.now(),
        friendUids: ownFriendUids(),
        friends: friends.map((f) => ({
          uid: f.uid,
          name: f.name || '',
          handle: f.handle || '',
          avatar: f.avatar || '',
          pubKey: f.pubKey || '',
          lastActiveAtMs: tsToMillis(f.lastActiveAt),
          showPresence: f.showPresence !== false,
          missing: !!f.missing,
        })),
      }));
    } catch { /* quota / private mode: keep the in-memory list */ }
  }

  function restoreFriendsCache(cache) {
    friends = (cache.friends || []).slice(0, friendLimit).map((f) => ({
      uid: f.uid,
      name: f.name || 'Pchat user',
      handle: f.handle || '',
      avatar: f.avatar || '',
      pubKey: f.pubKey || null,
      lastActiveAt: f.lastActiveAtMs ? new Date(f.lastActiveAtMs) : null,
      showPresence: f.showPresence !== false,
      missing: !!f.missing,
    }));
    friendsLoaded = true;
    friendsLoading = false;
    failedFriendReads = 0;
    friendsError = null;
    lastRefreshAt = Number(cache.at) || Date.now();
  }

  function ownFriendUids() {
    const blocked = new Set((profile && profile.blockedUids) || []);
    return ((profile && profile.friendUids) || []).filter((id) => id && id !== uid && !blocked.has(id));
  }

  function ownBlockedUids() {
    return ((profile && profile.blockedUids) || []).filter((id) => id && id !== uid);
  }

  function isBlocked(friendUid) {
    return ownBlockedUids().includes(friendUid);
  }

  function getState() {
    const total = ownFriendUids().length;
    return {
      status,
      gate,
      error,
      uid,
      profile,
      friends,
      incoming,
      outgoing,
      friendLimit,
      hasMoreFriends: total > friendLimit,
      totalFriends: total,
      friendsLoading,
      friendsError,
      failedFriendReads,
      listenerError,
      panelVisible,
    };
  }

  function emit() {
    const state = getState();
    stateListeners.forEach((fn) => {
      try { fn(state); } catch (err) { console.warn('[Friends] listener failed:', err); }
    });
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    stateListeners.add(fn);
    try { fn(getState()); } catch { /* ignore */ }
    return () => stateListeners.delete(fn);
  }

  function onEvent(fn) {
    if (typeof fn !== 'function') return () => {};
    eventListeners.add(fn);
    return () => eventListeners.delete(fn);
  }

  function emitEvent(type, payload) {
    eventListeners.forEach((fn) => {
      try { fn(type, payload); } catch (err) { console.warn('[Friends] event listener failed:', err); }
    });
  }

  function markSelfHandling(id) {
    if (!id) return;
    selfHandling.add(id);
    setTimeout(() => selfHandling.delete(id), 10000);
  }

  // ── Auth / profile bootstrap ───────────────────────────────────
  function gateCopy(kind) {
    if (kind === 'google') {
      return {
        kind: 'google',
        title: 'Google sign-in needed',
        message: 'You are signed in with email or demo mode. Friends work across devices with Google; chat stays exactly the same.',
        action: 'Sign in with Google',
        actionType: 'login',
      };
    }
    if (kind === 'reconnect') {
      return {
        kind: 'reconnect',
        title: 'Reconnect Google',
        message: 'Your Google session expired. Reconnect to see your friends and requests. Chat is not affected.',
        action: 'Reconnect',
        actionType: 'reconnect',
      };
    }
    return {
      kind: 'signin',
      title: 'Sign in to use Friends',
      message: 'Friends work across devices with a Google sign-in. Chat and rooms keep working without it.',
      action: 'Sign in with Google',
      actionType: 'login',
    };
  }

  async function resolveFirebaseUser() {
    const appAuth = Storage.getAuth();
    const isRealGoogle = !!(appAuth
      && appAuth.accessToken
      && !appAuth.isDemo
      && !appAuth.isEmailAuth
      && !String(appAuth.accessToken).startsWith('demo_token_')
      && !String(appAuth.accessToken).startsWith('email_token_'));

    let user = Firebase.currentUser();

    // Email/demo/logged-out sessions must never inherit a stale Firebase
    // session from another person on a shared device.
    if (!isRealGoogle) {
      if (user) {
        try { await Firebase.signOut(); } catch { /* ignore */ }
      }
      throw gateError(appAuth ? 'google' : 'signin',
        appAuth ? 'Friends need Google sign-in.' : 'Sign in to use Friends.');
    }

    if (!user) {
      if (!(Date.now() < (appAuth.expiresAt || 0))) {
        throw gateError('reconnect', 'Google token expired.');
      }
      await Firebase.signInWithGoogleToken(appAuth.accessToken);
      user = Firebase.currentUser();
    } else if (appAuth.user && appAuth.user.email && user.email
      && appAuth.user.email.toLowerCase() !== user.email.toLowerCase()) {
      // A different Google account is signed into the app. Switch the
      // Firebase session if we still have a valid GIS token.
      if (!(Date.now() < (appAuth.expiresAt || 0))) {
        try { await Firebase.signOut(); } catch { /* ignore */ }
        throw gateError('reconnect', 'Google account changed.');
      }
      await Firebase.signInWithGoogleToken(appAuth.accessToken);
      user = Firebase.currentUser();
    }

    if (!user) throw gateError('signin', 'Firebase did not return a user.');
    return user;
  }

  async function init(opts = {}) {
    // Kill switch: disable without removing script tags.
    if (window.CONFIG && window.CONFIG.FRIENDS_ENABLED === false) {
      status = 'error';
      error = { code: 'friends/disabled', message: 'Friends feature is currently disabled.' };
      emit();
      return getState();
    }
    const force = !!opts.force;
    if (force) {
      detachListeners();
      initPromise = null;
      friendLimit = FRIEND_PAGE_SIZE;
    } else if (status === 'ready') {
      return getState();
    } else if (initPromise) {
      return initPromise;
    }

    status = 'loading';
    gate = null;
    error = null;
    listenerError = null;
    presenceDisabled = false;

    // Gate cheaply before loading ~300 KB of Firebase for guests/email users.
    if (typeof Firebase === 'undefined') {
      status = 'error';
      error = { code: 'firebase/unavailable', message: 'Firebase failed to load. Refresh the page and try again.' };
      emit();
      return getState();
    }
    if (!Firebase.isConfigured()) {
      status = 'error';
      error = { code: 'firebase/not-configured', message: friendly(makeError('firebase/not-configured')) };
      emit();
      return getState();
    }
    const earlyAuth = Storage.getAuth();
    const earlyGoogle = !!(earlyAuth
      && earlyAuth.accessToken
      && !earlyAuth.isDemo
      && !earlyAuth.isEmailAuth
      && !String(earlyAuth.accessToken).startsWith('demo_token_')
      && !String(earlyAuth.accessToken).startsWith('email_token_'));
    if (!earlyGoogle) {
      status = 'gate';
      gate = gateCopy(earlyAuth ? 'google' : 'signin');
      emit();
      return getState();
    }

    emit();

    initPromise = (async () => {
      try {
        await Firebase.ready();
        const user = await resolveFirebaseUser();
        const previousUid = uid;
        uid = user.uid;
        if (previousUid && previousUid !== uid) clearFriendsCache(previousUid);

        const sdk = await Firebase.sdk();
        fsMod = sdk.fsMod;
        db = sdk.db;
        auth = sdk.auth;

        const appAuth = Storage.getAuth() || {};
        const ensured = await Firebase.ensureProfile(appAuth.user || {});
        profile = normalizeProfile(ensured && ensured.data);
        // ensureProfile may have written lastActiveAt with serverTimestamp();
        // show a local "just now" until the next real read refreshes it. If
        // the write was throttled, keep the timestamp we already know.
        if (ensured && ensured.presenceWritten) profile.lastActiveAt = new Date();

        status = 'ready';
        gate = null;
        error = null;
        // ensureProfile just read/created the profile, but the friend docs
        // have not been read yet. The first panel open must not be throttled.
        lastProfileAt = Date.now();
        friendsLoaded = false;
        attachListeners();
        startPresence(ensured && ensured.presenceWritten ? Date.now() : 0);
        emit();
        return getState();
      } catch (err) {
        detachListeners();
        if (err && err.isGate) {
          status = 'gate';
          gate = gateCopy(err.gateKind);
        } else {
          status = 'error';
          error = {
            code: (err && err.code) || 'friends/init',
            message: friendly(err),
          };
        }
        console.warn('[Friends] init failed:', err);
        emit();
        return getState();
      } finally {
        initPromise = null;
      }
    })();

    return initPromise;
  }

  async function reconnect() {
    const authData = await Auth.signIn();
    if (!authData || !authData.accessToken) {
      throw makeError('firebase/not-google', 'Google sign-in did not return a token.');
    }
    await Firebase.signInWithGoogleToken(authData.accessToken);
    try { localStorage.setItem('shepu_social_linked', '1'); } catch { /* ignore */ }
    await Firebase.ensureProfile(authData.user || {});
    return init({ force: true });
  }

  // ── Profile / friends refresh ──────────────────────────────────
  async function loadProfile() {
    if (!fsMod || !db || !uid) throw makeError('friends/not-ready', 'Friends are not ready.');
    const snap = await fsMod.getDoc(fsMod.doc(db, 'users', uid));
    if (!snap.exists()) {
      throw makeError('friends/profile-missing', 'Your social profile is missing.');
    }
    profile = normalizeProfile(snap.data());
    lastProfileAt = Date.now();
    return profile;
  }

  async function loadFriends() {
    if (!profile) { friends = []; return; }
    const uids = ownFriendUids().slice(0, friendLimit);
    const previous = new Map(friends.map((f) => [f.uid, f]));
    failedFriendReads = 0;

    const results = await Promise.all(uids.map(async (friendUid) => {
      try {
        const snap = await fsMod.getDoc(fsMod.doc(db, 'users', friendUid));
        if (!snap.exists()) {
          return {
            uid: friendUid,
            name: 'Deleted user',
            handle: '',
            avatar: '',
            pubKey: null,
            lastActiveAt: null,
            showPresence: false,
            missing: true,
          };
        }
        const d = snap.data() || {};
        return {
          uid: friendUid,
          name: d.name || 'Pchat user',
          handle: d.handle || '',
          avatar: d.avatar || '',
          pubKey: d.pubKey || null,
          lastActiveAt: d.lastActiveAt || null,
          showPresence: !(d.flags && d.flags.showPresence === false),
          missing: false,
        };
      } catch (err) {
        failedFriendReads++;
        // Keep the last known row for transient network failures. For a
        // permission denial (the other side unfriended us), show a safe
        // placeholder so the list does not silently invent data.
        if (previous.has(friendUid)) return previous.get(friendUid);
        return {
          uid: friendUid,
          name: 'Unavailable friend',
          handle: '',
          avatar: '',
          pubKey: null,
          lastActiveAt: null,
          showPresence: false,
          missing: true,
        };
      }
    }));

    friends = results
      .filter(Boolean)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    friendsLoaded = true;
    writeFriendsCache();
  }

  async function refresh(opts = {}) {
    const force = !!opts.force;
    if (status === 'idle') return init();
    if (status !== 'ready' || !uid) return getState();

    const now = Date.now();
    if (!force && friendsLoaded && now - lastRefreshAt < REFRESH_CACHE_MS) return getState();

    // Reopening the panel or reloading the page within five minutes must not
    // re-read 20 friend documents. Show the persisted rows instantly; the
    // manual Refresh button still forces a server read.
    if (!force && !friendsLoaded) {
      const cache = readFriendsCache();
      if (cache) {
        restoreFriendsCache(cache);
        emit();
        return getState();
      }
    }

    friendsLoading = true;
    friendsError = null;
    emit();
    try {
      // The profile was just read by ensureProfile or loadProfile. Only
      // re-read it when it is stale; the friend docs still need a read.
      if (force || !profile || now - lastProfileAt > REFRESH_CACHE_MS) {
        await loadProfile();
      }
      await loadFriends();
      friendsError = null;
    } catch (err) {
      friendsError = friendly(err);
      console.warn('[Friends] refresh failed:', err);
    } finally {
      friendsLoading = false;
      lastRefreshAt = Date.now();
      emit();
    }
    return getState();
  }

  async function loadMoreFriends() {
    if (!profile) return getState();
    if (friendLimit >= ownFriendUids().length) return getState();
    friendLimit += FRIEND_PAGE_SIZE;
    return refresh({ force: true });
  }

  async function hydrateFriend(friendUid, fallback) {
    if (!fsMod || !db) return fallback || null;
    try {
      const snap = await fsMod.getDoc(fsMod.doc(db, 'users', friendUid));
      if (!snap.exists()) return fallback || null;
      const d = snap.data() || {};
      const row = {
        uid: friendUid,
        name: d.name || (fallback && fallback.name) || 'Pchat user',
        handle: d.handle || (fallback && fallback.handle) || '',
        avatar: d.avatar || '',
        pubKey: d.pubKey || (fallback && fallback.pubKey) || null,
        lastActiveAt: d.lastActiveAt || null,
        showPresence: !(d.flags && d.flags.showPresence === false),
        missing: false,
      };
      friends = [...friends.filter((f) => f.uid !== friendUid), row]
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      writeFriendsCache();
      emit();
      return row;
    } catch {
      return fallback || null;
    }
  }

  function setPanelVisible(visible) {
    panelVisible = !!visible;
    if (panelVisible) {
      if (status === 'ready') refresh();
      else if (status === 'idle') init();
    }
    emit();
  }

  // ── Presence heartbeat ──────────────────────────────────────────
  // lastActiveAt lives on the user's own document. We never fan out writes
  // and never listen for presence. The 12-minute throttle is shared across
  // tabs through localStorage so five tabs cannot produce five writes.
  function presenceVisible() {
    try { return document.visibilityState !== 'hidden'; } catch { return true; }
  }

  function presenceLockKey() {
    return 'shepu_presence_lock_' + uid;
  }

  function presenceStamp() {
    try {
      return typeof Firebase.readPresenceAt === 'function' ? Firebase.readPresenceAt(uid) : 0;
    } catch {
      return 0;
    }
  }

  function markPresenceStamp(at) {
    try {
      if (typeof Firebase.markPresenceAt === 'function') Firebase.markPresenceAt(uid, at);
    } catch { /* ignore */ }
  }

  function canTouchPresence() {
    return status === 'ready'
      && !presenceDisabled
      && !!uid
      && !!fsMod
      && !!db
      && !!profile
      && profile.showPresence !== false
      && presenceVisible();
  }

  async function touchPresence() {
    if (!canTouchPresence() || presenceWriteInFlight) return false;
    const now = Date.now();
    if (now - presenceLastWriteAt < PRESENCE_THROTTLE_MS) return false;

    const lockKey = presenceLockKey();
    try {
      const sharedAt = presenceStamp();
      if (now - sharedAt < PRESENCE_THROTTLE_MS) {
        presenceLastWriteAt = sharedAt;
        return false;
      }
      const lockAt = Number(localStorage.getItem(lockKey) || 0);
      if (now - lockAt < PRESENCE_LOCK_MS) return false;
      localStorage.setItem(lockKey, String(now));
    } catch { /* localStorage unavailable: fall back to this tab's throttle */ }

    presenceWriteInFlight = true;
    presenceLastWriteAt = now;
    try {
      await fsMod.updateDoc(fsMod.doc(db, 'users', uid), {
        lastActiveAt: fsMod.serverTimestamp(),
      });
      markPresenceStamp(now);
      if (profile) profile.lastActiveAt = new Date(now);
      return true;
    } catch (err) {
      if (err && ['resource-exhausted', 'permission-denied', 'unauthenticated'].includes(err.code)) {
        presenceDisabled = true;
      }
      console.warn('[Friends] presence update failed:', err);
      return false;
    } finally {
      presenceWriteInFlight = false;
      try { localStorage.removeItem(lockKey); } catch { /* ignore */ }
    }
  }

  function maybeTouchPresence() {
    if (!canTouchPresence()) return;
    const now = Date.now();
    if (now - presenceLastInteractionAt > PRESENCE_IDLE_MS) return;
    if (now - presenceLastWriteAt < PRESENCE_THROTTLE_MS) return;
    touchPresence().catch(() => {});
  }

  function noteInteraction() {
    presenceLastInteractionAt = Date.now();
    if (presenceDisabled) return;
    if (presenceLastWriteAt && Date.now() - presenceLastWriteAt < PRESENCE_THROTTLE_MS) return;
    if (!canTouchPresence()) return;
    touchPresence().catch(() => {});
  }

  function onVisibilityChange() {
    if (presenceVisible()) noteInteraction();
  }

  function startPresence(initialWriteAt) {
    stopPresence();
    if (window.CONFIG && window.CONFIG.PRESENCE_ENABLED === false) return;
    if (status !== 'ready' || !uid || !profile || profile.showPresence === false) return;

    presenceLastWriteAt = Math.max(Number(initialWriteAt) || 0, presenceStamp());
    presenceLastInteractionAt = Date.now();

    if (!presenceBound) {
      const opts = { passive: true, capture: true };
      document.addEventListener('pointerdown', noteInteraction, opts);
      document.addEventListener('keydown', noteInteraction, opts);
      document.addEventListener('touchstart', noteInteraction, opts);
      document.addEventListener('scroll', noteInteraction, opts);
      document.addEventListener('visibilitychange', onVisibilityChange);
      window.addEventListener('focus', noteInteraction);
      presenceBound = true;
    }

    presenceTimer = setInterval(maybeTouchPresence, PRESENCE_CHECK_MS);
    // App open is itself a presence event; this writes only if the shared
    // 12-minute marker is stale.
    maybeTouchPresence();
  }

  function stopPresence() {
    if (presenceTimer) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }
    if (presenceBound) {
      const opts = { capture: true };
      document.removeEventListener('pointerdown', noteInteraction, opts);
      document.removeEventListener('keydown', noteInteraction, opts);
      document.removeEventListener('touchstart', noteInteraction, opts);
      document.removeEventListener('scroll', noteInteraction, opts);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', noteInteraction);
      presenceBound = false;
    }
    presenceLastInteractionAt = 0;
  }

  // ── Requests listeners ─────────────────────────────────────────
  function attachListeners() {
    if (!fsMod || !db || !uid || listenersAttached) return;
    detachListeners();
    listenersAttached = true;
    firstIncoming = true;
    firstOutgoing = true;

    const incomingQuery = fsMod.query(
      fsMod.collection(db, 'friendRequests'),
      fsMod.where('to', '==', uid)
    );
    unsubIncoming = fsMod.onSnapshot(incomingQuery, (snap) => {
      const docs = snap.docs.map((d) => normalizeRequest(d.id, d.data()));
      const blocked = new Set(ownBlockedUids());
      const pending = docs.filter((r) => r.status === 'pending' && !blocked.has(r.from));
      if (firstIncoming) {
        firstIncoming = false;
      } else {
        const prev = new Set(incoming.map((r) => r.id));
        const next = new Set(pending.map((r) => r.id));
        pending.forEach((r) => {
          if (!prev.has(r.id)) {
            emitEvent('request', r);
            announceRequest(r);
          }
        });
        const removed = incoming.filter((r) => !next.has(r.id));
        if (removed.length && !removed.every((r) => selfHandling.has(r.id))) {
          scheduleProfileRefresh();
        }
      }
      incoming = pending;
      listenerError = null;
      emit();
    }, (err) => {
      listenerError = friendly(err);
      console.warn('[Friends] incoming request listener failed:', err);
      emit();
    });

    const outgoingQuery = fsMod.query(
      fsMod.collection(db, 'friendRequests'),
      fsMod.where('from', '==', uid)
    );
    unsubOutgoing = fsMod.onSnapshot(outgoingQuery, (snap) => {
      const docs = snap.docs.map((d) => normalizeRequest(d.id, d.data()));
      const blockedOut = new Set(ownBlockedUids());
      const pending = docs.filter((r) => r.status === 'pending' && !blockedOut.has(r.to));
      if (firstOutgoing) {
        firstOutgoing = false;
      } else {
        const next = new Set(pending.map((r) => r.id));
        const removed = outgoing.filter((r) => !next.has(r.id));
        const external = removed.filter((r) => !selfHandling.has(r.id));
        if (external.length) {
          profileRefreshQueue.push(...external);
          scheduleProfileRefresh();
        }
      }
      outgoing = pending;
      listenerError = null;
      emit();
    }, (err) => {
      listenerError = friendly(err);
      console.warn('[Friends] outgoing request listener failed:', err);
      emit();
    });
  }

  // A request must be noticeable from every screen, not only the dashboard.
  // The in-app toast is the reliable path; a system notification is raised
  // only when the tab is hidden AND the user already granted permission for
  // chat notifications. We never ask for permission from here.
  function announceRequest(req) {
    if (!req) return;
    const who = req.fromName || 'Someone';
    const handle = req.fromHandle ? ` (@${req.fromHandle})` : '';
    try {
      if (window.UI && typeof UI.toast === 'function') {
        UI.toast('info', 'New friend request', `${who}${handle} wants to be friends.`, 7000);
      }
    } catch { /* non-fatal */ }
    try {
      if (typeof document !== 'undefined'
        && document.visibilityState === 'hidden'
        && typeof Notification !== 'undefined'
        && Notification.permission === 'granted') {
        const n = new Notification('New friend request', {
          body: `${who}${handle} wants to be friends.`,
          icon: 'assets/icons/icon.png',
          tag: 'friend-request-' + (req.id || ''),
        });
        n.onclick = () => { try { window.focus(); } catch { /* ignore */ } };
      }
    } catch { /* notifications are optional */ }
  }

  function detachListeners() {
    try { if (unsubIncoming) unsubIncoming(); } catch { /* ignore */ }
    try { if (unsubOutgoing) unsubOutgoing(); } catch { /* ignore */ }
    unsubIncoming = null;
    unsubOutgoing = null;
    listenersAttached = false;
    if (profileRefreshTimer) {
      clearTimeout(profileRefreshTimer);
      profileRefreshTimer = null;
    }
    profileRefreshQueue = [];
    stopPresence();
  }

  function scheduleProfileRefresh() {
    if (profileRefreshTimer) return;
    profileRefreshTimer = setTimeout(async () => {
      profileRefreshTimer = null;
      const before = new Set(ownFriendUids());
      const queued = profileRefreshQueue.splice(0);
      try {
        await loadProfile();
      } catch (err) {
        console.warn('[Friends] profile refresh after request change failed:', err);
      }
      const after = new Set(ownFriendUids());
      queued.forEach((req) => {
        if (req && req.to && after.has(req.to) && !before.has(req.to)) {
          emitEvent('friend-accepted', { uid: req.to, handle: req.toHandle || '' });
        }
      });
      if (panelVisible) {
        try { await loadFriends(); } catch { /* ignore */ }
      }
      emit();
    }, 800);
  }

  // ── Handle claim / search ──────────────────────────────────────
  async function claimHandle(raw) {
    if (status !== 'ready' || !profile) {
      throw makeError('friends/not-ready', 'Friends are still connecting.');
    }
    const handle = normalizeHandle(raw);
    if (!HANDLE_RE.test(handle)) {
      throw makeError('friends/handle-invalid', 'Invalid handle.');
    }
    if (profile.handle) {
      throw makeError('friends/handle-set', 'Handle already set.');
    }

    const handleRef = fsMod.doc(db, 'usernames', handle);
    const snap = await fsMod.getDoc(handleRef);
    let created = false;

    if (snap.exists()) {
      const data = snap.data() || {};
      if (data.uid !== uid) throw makeError('friends/handle-taken', 'Handle taken.');
    } else {
      try {
        await fsMod.setDoc(handleRef, {
          uid,
          createdAt: fsMod.serverTimestamp(),
        });
        created = true;
      } catch (err) {
        if (err && (err.code === 'permission-denied' || err.code === 'already-exists')) {
          throw makeError('friends/handle-taken', 'Handle taken.');
        }
        throw err;
      }
    }

    try {
      await fsMod.updateDoc(fsMod.doc(db, 'users', uid), { handle });
    } catch (err) {
      if (created) {
        try { await fsMod.deleteDoc(handleRef); } catch { /* best effort */ }
      }
      throw err;
    }

    profile.handle = handle;
    emit();
    return handle;
  }

  async function checkHandle(raw) {
    if (status !== 'ready' || !profile) {
      throw makeError('friends/not-ready', 'Friends are still connecting.');
    }
    const handle = normalizeHandle(raw);
    if (!HANDLE_RE.test(handle)) {
      throw makeError('friends/handle-invalid', 'Invalid handle.');
    }

    const snap = await fsMod.getDoc(fsMod.doc(db, 'usernames', handle));
    if (!snap.exists()) return { handle, available: true, isSelf: false };
    const data = snap.data() || {};
    return { handle, available: false, isSelf: data.uid === uid };
  }

  async function search(raw) {
    if (status !== 'ready' || !profile) {
      throw makeError('friends/not-ready', 'Friends are still connecting.');
    }
    const handle = normalizeHandle(raw);
    if (!HANDLE_RE.test(handle)) {
      throw makeError('friends/handle-invalid', 'Invalid handle.');
    }

    const snap = await fsMod.getDoc(fsMod.doc(db, 'usernames', handle));
    if (!snap.exists()) return { found: false, handle };

    const data = snap.data() || {};
    const targetUid = data.uid;
    if (!targetUid) return { found: false, handle };

    const outgoingRequest = outgoing.find((r) => r.to === targetUid);
    const incomingRequest = incoming.find((r) => r.from === targetUid);

    return {
      found: true,
      handle,
      uid: targetUid,
      isSelf: targetUid === uid,
      isFriend: ownFriendUids().includes(targetUid),
      blocked: isBlocked(targetUid),
      outgoing: !!outgoingRequest,
      incoming: !!incomingRequest,
      incomingRequest: incomingRequest || null,
    };
  }

  // ── Request actions ────────────────────────────────────────────
  async function sendRequest(target) {
    if (status !== 'ready' || !profile) {
      throw makeError('friends/not-ready', 'Friends are still connecting.');
    }
    if (!target || !target.uid) {
      throw makeError('friends/not-found', 'No user selected.');
    }
    if (target.uid === uid) throw makeError('friends/self', 'That is you.');
    if (isBlocked(target.uid)) throw makeError('friends/blocked', 'Unblock this user first.');
    if (ownFriendUids().includes(target.uid)) {
      throw makeError('friends/already-friends', 'Already friends.');
    }
    if (!profile.handle) throw makeError('friends/no-handle', 'Choose a handle first.');

    const requestId = uid + '_' + target.uid;
    const reqRef = fsMod.doc(db, 'friendRequests', requestId);
    const existing = await fsMod.getDoc(reqRef);
    if (existing.exists()) {
      const st = (existing.data() || {}).status;
      if (st === 'pending') {
        throw makeError('friends/already-pending', 'Request already pending.');
      }
      // Accepted/declined leftovers must be removed before a new create;
      // the rules do not allow updating a request back to pending.
      await fsMod.deleteDoc(reqRef);
    }

    const data = {
      from: uid,
      to: target.uid,
      fromName: (profile.name || '').slice(0, 80),
      fromHandle: profile.handle,
      toHandle: target.handle || '',
      status: 'pending',
      createdAt: fsMod.serverTimestamp(),
    };

    try {
      await fsMod.setDoc(reqRef, data);
    } catch (err) {
      if (err && (err.code === 'permission-denied' || err.code === 'already-exists')) {
        throw makeError('friends/already-pending', 'Request already pending.');
      }
      throw err;
    }

    const optimistic = {
      id: requestId,
      ...data,
      createdAt: new Date(),
    };
    outgoing = [optimistic, ...outgoing.filter((r) => r.id !== requestId)];
    emit();
    return optimistic;
  }

  async function acceptRequest(req) {
    if (!req || !req.id) throw makeError('friends/not-recipient', 'Invalid request.');
    if (req.to !== uid) throw makeError('friends/not-recipient', 'Not your request.');
    markSelfHandling(req.id);

    const senderRef = fsMod.doc(db, 'users', req.from);
    const myRef = fsMod.doc(db, 'users', uid);
    const reqRef = fsMod.doc(db, 'friendRequests', req.id);

    // If both sides sent requests, accepting one hides the other forever.
    // Cancel our reverse request in the same batch (we are its sender).
    const reverse = outgoing.find((r) => r.to === req.from);

    const batch = fsMod.writeBatch(db);
    batch.update(senderRef, { friendUids: fsMod.arrayUnion(uid) });
    batch.update(myRef, { friendUids: fsMod.arrayUnion(req.from) });
    batch.delete(reqRef);
    if (reverse) batch.delete(fsMod.doc(db, 'friendRequests', reverse.id));

    try {
      await batch.commit();
    } catch (err) {
      // Retry case: the sender already has us (for example, a previous
      // attempt added their side before failing). Finish our side only.
      const senderSnap = await fsMod.getDoc(senderRef).catch(() => null);
      const senderAlreadyHasMe = !!(senderSnap
        && senderSnap.exists()
        && Array.isArray((senderSnap.data() || {}).friendUids)
        && senderSnap.data().friendUids.includes(uid));
      if (!senderAlreadyHasMe) throw err;

      const fallback = fsMod.writeBatch(db);
      fallback.update(myRef, { friendUids: fsMod.arrayUnion(req.from) });
      fallback.delete(reqRef);
      if (reverse) fallback.delete(fsMod.doc(db, 'friendRequests', reverse.id));
      await fallback.commit();
    }

    incoming = incoming.filter((r) => r.id !== req.id);
    if (reverse) outgoing = outgoing.filter((r) => r.id !== reverse.id);
    if (profile && !profile.friendUids.includes(req.from)) {
      profile.friendUids.push(req.from);
    }
    const entry = {
      uid: req.from,
      name: req.fromName || 'Pchat user',
      handle: req.fromHandle || '',
      avatar: '',
      pubKey: null,
      lastActiveAt: null,
      showPresence: true,
      missing: false,
    };
    friends = [entry, ...friends.filter((f) => f.uid !== req.from)];
    writeFriendsCache();
    emit();

    // One read fills in the real name/handle/presence; no full list reload.
    if (panelVisible) hydrateFriend(req.from, entry).catch(() => {});
    return true;
  }

  async function declineRequest(req) {
    if (!req || !req.id) throw makeError('friends/not-recipient', 'Invalid request.');
    if (req.to !== uid) throw makeError('friends/not-recipient', 'Not your request.');
    markSelfHandling(req.id);
    await fsMod.deleteDoc(fsMod.doc(db, 'friendRequests', req.id));
    incoming = incoming.filter((r) => r.id !== req.id);
    emit();
    return true;
  }

  async function cancelRequest(req) {
    if (!req || !req.id) throw makeError('friends/not-sender', 'Invalid request.');
    if (req.from !== uid) throw makeError('friends/not-sender', 'Not your request.');
    markSelfHandling(req.id);
    await fsMod.deleteDoc(fsMod.doc(db, 'friendRequests', req.id));
    outgoing = outgoing.filter((r) => r.id !== req.id);
    emit();
    return true;
  }

  async function unfriend(friendUid) {
    if (!friendUid || friendUid === uid) {
      throw makeError('friends/not-friends', 'Invalid friend.');
    }
    if (!ownFriendUids().includes(friendUid)) {
      throw makeError('friends/not-friends', 'Not in your friend list.');
    }

    const myRef = fsMod.doc(db, 'users', uid);
    const friendRef = fsMod.doc(db, 'users', friendUid);
    const batch = fsMod.writeBatch(db);
    batch.update(myRef, { friendUids: fsMod.arrayRemove(friendUid) });
    batch.update(friendRef, { friendUids: fsMod.arrayRemove(uid) });

    try {
      await batch.commit();
    } catch (err) {
      // If the other side is already clean (or their profile is gone), only
      // remove our side. This keeps the user from being stuck with a ghost.
      const friendSnap = await fsMod.getDoc(friendRef).catch(() => null);
      const otherHasMe = !!(friendSnap
        && friendSnap.exists()
        && Array.isArray((friendSnap.data() || {}).friendUids)
        && friendSnap.data().friendUids.includes(uid));
      if (otherHasMe) throw err;
      await fsMod.updateDoc(myRef, { friendUids: fsMod.arrayRemove(friendUid) });
    }

    profile.friendUids = profile.friendUids.filter((id) => id !== friendUid);
    friends = friends.filter((f) => f.uid !== friendUid);
    writeFriendsCache();
    emit();
    return true;
  }

  // ── Block / unblock ───────────────────────────────────────────
  // Blocking is local-first: the uid goes on our own profile, so the other
  // side cannot keep a connection we no longer want. Rules also refuse new
  // friend requests and invites from a blocked account.
  async function block(friendUid, meta = {}) {
    if (status !== 'ready' || !profile || !fsMod || !db) {
      throw makeError('friends/not-ready', 'Friends are still connecting.');
    }
    if (!friendUid || friendUid === uid) throw makeError('friends/not-friends', 'Invalid user.');
    if (isBlocked(friendUid)) return true;

    const wasFriend = ownFriendUids().includes(friendUid);
    if (wasFriend) await unfriend(friendUid);

    const info = {
      name: String(meta.name || (wasFriend && friends.find((f) => f.uid === friendUid)?.name) || '').slice(0, 80),
      handle: String(meta.handle || (wasFriend && friends.find((f) => f.uid === friendUid)?.handle) || '').slice(0, 20),
      at: Date.now(),
    };
    await fsMod.updateDoc(fsMod.doc(db, 'users', uid), {
      blockedUids: fsMod.arrayUnion(friendUid),
      ['blockedInfo.' + friendUid]: info,
    });

    if (!profile.blockedUids) profile.blockedUids = [];
    if (!profile.blockedUids.includes(friendUid)) profile.blockedUids.push(friendUid);
    if (!profile.blockedInfo) profile.blockedInfo = {};
    profile.blockedInfo[friendUid] = info;

    // Pending requests between us are now noise; remove what this account is
    // allowed to delete (sender side or recipient side).
    const stale = [
      ...incoming.filter((r) => r.from === friendUid),
      ...outgoing.filter((r) => r.to === friendUid),
    ];
    for (const req of stale) {
      try { await fsMod.deleteDoc(fsMod.doc(db, 'friendRequests', req.id)); } catch { /* best effort */ }
    }
    incoming = incoming.filter((r) => r.from !== friendUid);
    outgoing = outgoing.filter((r) => r.to !== friendUid);
    friends = friends.filter((f) => f.uid !== friendUid);
    writeFriendsCache();
    emit();
    return true;
  }

  async function unblock(friendUid) {
    if (status !== 'ready' || !profile || !fsMod || !db) {
      throw makeError('friends/not-ready', 'Friends are still connecting.');
    }
    if (!friendUid) return false;
    await fsMod.updateDoc(fsMod.doc(db, 'users', uid), {
      blockedUids: fsMod.arrayRemove(friendUid),
      ['blockedInfo.' + friendUid]: fsMod.deleteField(),
    });
    profile.blockedUids = (profile.blockedUids || []).filter((id) => id !== friendUid);
    if (profile.blockedInfo) delete profile.blockedInfo[friendUid];
    emit();
    return true;
  }

  // ── Reset / debug ──────────────────────────────────────────────
  function reset() {
    detachListeners();
    if (uid) clearFriendsCache(uid);
    uid = null;
    fsMod = null;
    db = null;
    auth = null;
    profile = null;
    friends = [];
    incoming = [];
    outgoing = [];
    friendLimit = FRIEND_PAGE_SIZE;
    status = 'idle';
    gate = null;
    error = null;
    listenerError = null;
    friendsError = null;
    failedFriendReads = 0;
    friendsLoading = false;
    friendsLoaded = false;
    lastRefreshAt = 0;
    lastProfileAt = 0;
    panelVisible = false;
    initPromise = null;
    selfHandling.clear();
    presenceDisabled = false;
    presenceLastWriteAt = 0;
    presenceWriteInFlight = false;
    emit();
  }

  function debug() {
    return {
      status,
      uid,
      handle: (profile && profile.handle) || '',
      friends: friends.length,
      totalFriends: ownFriendUids().length,
      blocked: ownBlockedUids().length,
      incoming: incoming.length,
      outgoing: outgoing.length,
      gate: gate ? gate.kind : null,
      error,
      listenerError,
      firebaseUid: (typeof Firebase !== 'undefined' && Firebase.getUid) ? Firebase.getUid() : null,
      presence: {
        bound: presenceBound,
        disabled: presenceDisabled,
        lastWriteAt: presenceLastWriteAt || null,
        lastInteractionAt: presenceLastInteractionAt || null,
      },
    };
  }

  // ── setShowPresence ─────────────────────────────────────────────
  // Saves the "show active status" preference to Firestore and starts/stops
  // the heartbeat immediately. Called from Settings → Friends.
  async function setShowPresence(show) {
    if (status !== 'ready' || !uid || !fsMod || !db) {
      throw Object.assign(new Error('Not signed in to Friends.'), { code: 'friends/not-ready' });
    }
    const val = !!show;
    await fsMod.updateDoc(fsMod.doc(db, 'users', uid), { 'flags.showPresence': val });
    if (profile) {
      profile.showPresence = val;
      if (profile.flags) profile.flags.showPresence = val;
    }
    if (val) {
      startPresence(0);
    } else {
      stopPresence();
    }
    emit();
  }

  // ── deleteSocialData ────────────────────────────────────────────
  // Removes the user's Firestore social footprint: profile, handle entry,
  // pending friend requests, and received invites. Rooms/messages untouched.
  async function deleteSocialData() {
    if (!fsMod || !db || !uid) {
      throw Object.assign(new Error('Not signed in.'), { code: 'friends/not-ready' });
    }
    const batch = fsMod.writeBatch(db);

    // Remove own profile
    batch.delete(fsMod.doc(db, 'users', uid));

    // Remove handle index entry if handle is known
    if (profile && profile.handle) {
      batch.delete(fsMod.doc(db, 'usernames', profile.handle));
    }

    await batch.commit();

    // Delete received invites and friend requests (both sides) — run after
    // the profile batch to avoid rule conflicts.
    try {
      const invitesSnap = await fsMod.getDocs(fsMod.collection(db, 'users', uid, 'invites'));
      if (invitesSnap.size) {
        const inviteBatch = fsMod.writeBatch(db);
        invitesSnap.forEach((d) => inviteBatch.delete(d.ref));
        await inviteBatch.commit();
      }
    } catch { /* non-critical */ }
    try {
      const [sentSnap, recvSnap] = await Promise.all([
        fsMod.getDocs(fsMod.query(
          fsMod.collection(db, 'friendRequests'),
          fsMod.where('from', '==', uid)
        )),
        fsMod.getDocs(fsMod.query(
          fsMod.collection(db, 'friendRequests'),
          fsMod.where('to', '==', uid)
        )),
      ]);
      const reqBatch = fsMod.writeBatch(db);
      sentSnap.forEach(d => reqBatch.delete(d.ref));
      recvSnap.forEach(d => reqBatch.delete(d.ref));
      if (sentSnap.size + recvSnap.size > 0) await reqBatch.commit();
    } catch { /* non-critical */ }

    // Reset local state
    detachListeners();
    profile = null;
    uid = null;
    status = 'idle';
    error = null;
    initPromise = null;
    emit();
  }

  return {
    init,
    reconnect,
    refresh,
    loadMoreFriends,
    setPanelVisible,
    getState,
    subscribe,
    onEvent,
    claimHandle,
    checkHandle,
    search,
    sendRequest,
    acceptRequest,
    declineRequest,
    cancelRequest,
    unfriend,
    block,
    unblock,
    reset,
    debug,
    normalizeHandle,
    friendly,
    setShowPresence,
    deleteSocialData,
    ACTIVE_WINDOW_MS,
    FRIEND_PAGE_SIZE,
    HANDLE_RE,
  };
})();

window.Friends = Friends;
