/**
 * SHEPU ROOMS — firebase.js
 * Lazy social layer: Firebase Auth + Firestore.
 *
 * The SDK is loaded on demand from gstatic — no bundler, no build step.
 * Nothing here runs until a social feature calls ready(), signIn…(), or sdk().
 *
 * Public surface:
 *   Firebase.ready()
 *   Firebase.isConfigured()
 *   Firebase.isInitialized()
 *   Firebase.signInWithGoogleToken(accessToken)
 *   Firebase.ensureProfile(profile)
 *   Firebase.onAuthStateChanged(cb)
 *   Firebase.currentUser()
 *   Firebase.getUid()
 *   Firebase.signOut()
 *   Firebase.sdk()
 *   Firebase.debug()
 *   Firebase.PRESENCE_THROTTLE_MS
 *   Firebase.readPresenceAt(uid) / Firebase.markPresenceAt(uid, at)
 */

const Firebase = (() => {
  const SDK_VERSION = '13.1.0';
  const CDN = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION;
  // Presence is event-driven. Twelve minutes leaves a three-minute safety
  // margin inside the 15-minute "active now" window.
  const PRESENCE_THROTTLE_MS = 12 * 60 * 1000;

  let loadPromise = null;
  let app = null;
  let auth = null;
  let db = null;
  let mods = null;
  let lastError = null;
  let emulator = false;

  // ── Config / environment ───────────────────────────────────────
  function isConfigured() {
    const c = window.FIREBASE_CONFIG;
    return !!(c && c.apiKey && c.projectId && !String(c.apiKey).includes('YOUR_'));
  }

  function wantsEmulator() {
    try {
      const qs = new URLSearchParams(location.search);
      if (qs.get('emulator') === '1') return true;
      if (localStorage.getItem('shepu_firebase_emulator') === '1') return true;
      return !!(window.CONFIG && window.CONFIG.FIREBASE_EMULATOR === true);
    } catch {
      return false;
    }
  }

  function friendlyError(err) {
    const code = (err && (err.code || err.name)) || '';
    const map = {
      'firebase/not-configured': 'Friends are not available in this build yet.',
      'firebase/not-google': 'Friends need a Google sign-in. Chat keeps working without it.',
      'firebase/not-signed-in': 'Sign in to use Friends.',
      'auth/invalid-credential': 'Google sign-in could not be verified. Please sign in again.',
      'auth/invalid-api-key': 'Friends are unavailable right now. Chat still works.',
      'auth/operation-not-allowed': 'Google sign-in is not available. Chat still works.',
      'auth/unauthorized-domain': 'This site is not allowed to use Google sign-in yet.',
      'auth/popup-blocked': 'The browser blocked the Google popup. Allow popups for this site and try again.',
      'auth/popup-closed-by-user': 'The Google popup was closed before finishing.',
      'auth/cancelled-popup-request': 'Another Google popup is already open.',
      'auth/network-request-failed': 'Network error while reaching Google. Check your connection.',
      'auth/web-storage-unsupported': 'This browser blocks the storage sign-in needs (private mode?).',
      'auth/account-exists-with-different-credential': 'This email already has a different sign-in method.',
      'permission-denied': 'Friends could not complete that just now. Please try again.',
      'failed-precondition': 'Friends are temporarily unavailable. Please try again.',
      'resource-exhausted': 'Friends are paused for a little while. Chat still works.',
      'unavailable': 'Friends are offline right now.',
    };
    return map[code] || (err && err.message) || String(err);
  }

  // ── Lazy SDK load ──────────────────────────────────────────────
  async function load() {
    if (loadPromise) return loadPromise;
    if (!isConfigured()) {
      const e = new Error('Friends are not available in this build yet.');
      e.code = 'firebase/not-configured';
      throw e;
    }

    const LOAD_TIMEOUT_MS = 15000;
    const timeoutErr = () => {
      const e = new Error(
        'Firebase SDK failed to load within 15 s. ' +
        'Check that https://www.gstatic.com is reachable and not blocked by CSP or network.'
      );
      e.code = 'firebase/load-timeout';
      return e;
    };

    loadPromise = Promise.race([
      (async () => {
        const [appMod, authMod, fsMod] = await Promise.all([
          import(CDN + '/firebase-app.js'),
          import(CDN + '/firebase-auth.js'),
          import(CDN + '/firebase-firestore.js'),
        ]);
        mods = { appMod, authMod, fsMod };

        app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(window.FIREBASE_CONFIG);
        auth = authMod.getAuth(app);

        // Persistent cache: free cache reads, cheaper reconnects, instant UI.
        // Fall back to the default in-memory cache when the browser refuses.
        try {
          db = fsMod.initializeFirestore(app, {
            localCache: fsMod.persistentLocalCache({
              tabManager: fsMod.persistentMultipleTabManager(),
            }),
          });
        } catch (e) {
          db = fsMod.getFirestore(app);
        }

        emulator = wantsEmulator();
        if (emulator) {
          authMod.connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
          fsMod.connectFirestoreEmulator(db, 'localhost', 8081);
        }

        return { app, auth, db, ...mods };
      })(),
      new Promise((_, reject) =>
        setTimeout(() => reject(timeoutErr()), LOAD_TIMEOUT_MS)
      ),
    ]).catch((err) => {
      lastError = err;
      loadPromise = null; // allow a retry
      console.warn('[Firebase] SDK load failed:', err.code || err.message || err);
      throw err;
    });

    return loadPromise;
  }

  async function ready() {
    await load();
    return true;
  }

  function isInitialized() {
    return !!(app && auth && db);
  }

  // ── Auth bridge ────────────────────────────────────────────────
  // Reuses the GIS access token the app already obtains for Drive/Sheets.
  // One Google popup, two jobs: Google APIs + Firebase identity.
  async function signInWithGoogleToken(accessToken) {
    if (!accessToken
        || String(accessToken).startsWith('demo_token_')
        || String(accessToken).startsWith('email_token_')) {
      const e = new Error('Friends need a real Google sign-in. Demo/email sessions cannot use the social layer.');
      e.code = 'firebase/not-google';
      throw e;
    }

    const { authMod } = await load();
    try {
      const credential = authMod.GoogleAuthProvider.credential(null, accessToken);
      const result = await authMod.signInWithCredential(auth, credential);
      // Lets the next page bootstrap the (persisted) Firebase session even
      // if the GIS access token has expired. It is not a secret.
      try { localStorage.setItem('shepu_social_linked', '1'); } catch { /* ignore */ }
      return result.user;
    } catch (err) {
      console.warn('[Firebase] signInWithCredential failed:', err);
      const e = new Error(friendlyError(err));
      e.code = err && err.code;
      e.cause = err;
      throw e;
    }
  }

  // ── Presence throttle ─────────────────────────────────────────
  // The marker is per-uid and per-browser. It is shared by ensureProfile
  // and the Friends heartbeat so a reload or a second tab cannot double-write.
  function presenceKey(uid) {
    return 'shepu_presence_at_' + uid;
  }

  function readPresenceAt(uid) {
    try {
      const value = Number(localStorage.getItem(presenceKey(uid)) || 0);
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  function markPresenceAt(uid, at) {
    try { localStorage.setItem(presenceKey(uid), String(at)); } catch { /* ignore */ }
  }

  // ── Profile bootstrap ──────────────────────────────────────────
  // One read per sign-in. Writes only when the profile is new, the name is
  // missing, or the 12-minute presence throttle is due. Never stores email
  // in the profile: friends can read the document, and email is not theirs.
  async function ensureProfile(profile = {}, opts = {}) {
    const touchPresence = opts.touchPresence !== false;
    const { fsMod } = await load();
    const user = auth.currentUser;
    if (!user) {
      const e = new Error('Not signed in to Firebase.');
      e.code = 'firebase/not-signed-in';
      throw e;
    }

    const ref = fsMod.doc(db, 'users', user.uid);
    let snap;
    try {
      snap = await fsMod.getDoc(ref);
    } catch (err) {
      const e = new Error(friendlyError(err));
      e.code = err && err.code;
      throw e;
    }

    if (!snap.exists()) {
      const data = {
        name: (profile.name || user.displayName || '').slice(0, 80),
        handle: '',
        avatar: '',
        pubKey: null,
        friendUids: [],
        lastActiveAt: fsMod.serverTimestamp(),
        flags: { showPresence: true },
        createdAt: fsMod.serverTimestamp(),
      };
      try {
        await fsMod.setDoc(ref, data);
      } catch (err) {
        const e = new Error(friendlyError(err));
        e.code = err && err.code;
        throw e;
      }
      const now = Date.now();
      markPresenceAt(user.uid, now);
      return { uid: user.uid, created: true, presenceWritten: true, data };
    }

    const existing = snap.data() || {};
    const patch = {};
    const name = (profile.name || user.displayName || '').slice(0, 80);
    if (!existing.name && name) patch.name = name;

    const showPresence = !(existing.flags && existing.flags.showPresence === false);
    const now = Date.now();
    const presenceWritten = touchPresence
      && showPresence
      && now - readPresenceAt(user.uid) >= PRESENCE_THROTTLE_MS;
    if (presenceWritten) patch.lastActiveAt = fsMod.serverTimestamp();

    if (Object.keys(patch).length > 0) {
      try {
        await fsMod.updateDoc(ref, patch);
      } catch (err) {
        const e = new Error(friendlyError(err));
        e.code = err && err.code;
        throw e;
      }
    }
    if (presenceWritten) markPresenceAt(user.uid, now);
    return {
      uid: user.uid,
      created: false,
      presenceWritten,
      data: { ...existing, ...patch },
    };
  }

  // ── Session helpers ────────────────────────────────────────────
  async function onAuthStateChanged(cb) {
    const { authMod } = await load();
    return authMod.onAuthStateChanged(auth, cb);
  }

  function currentUser() {
    return auth ? auth.currentUser : null;
  }

  function getUid() {
    return auth && auth.currentUser ? auth.currentUser.uid : null;
  }

  async function signOut() {
    try { localStorage.removeItem('shepu_social_linked'); } catch { /* ignore */ }
    if (!auth || !mods) return;
    try {
      await mods.authMod.signOut(auth);
    } catch (err) {
      console.warn('[Firebase] signOut failed:', err);
    }
  }

  // Raw SDK access for the friends/invites/presence modules.
  async function sdk() {
    const m = await load();
    return { app, auth, db, ...m };
  }

  async function debug() {
    return {
      configured: isConfigured(),
      initialized: isInitialized(),
      emulator: emulator || wantsEmulator(),
      projectId: (window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.projectId) || null,
      uid: getUid(),
      email: currentUser() ? currentUser().email : null,
      error: lastError ? friendlyError(lastError) : null,
    };
  }

  return {
    ready,
    isConfigured,
    isInitialized,
    signInWithGoogleToken,
    ensureProfile,
    onAuthStateChanged,
    currentUser,
    getUid,
    signOut,
    sdk,
    debug,
    friendlyError,
    PRESENCE_THROTTLE_MS,
    readPresenceAt,
    markPresenceAt,
  };
})();

window.Firebase = Firebase;
