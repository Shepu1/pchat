/**
 * SHEPU ROOMS — auth.js
 * Google OAuth 2.0 using the Token Model (implicit flow via GIS popup).
 *
 * We use google.accounts.oauth2.initTokenClient() which:
 * - Opens a Google popup for user consent
 * - Returns an access_token (no server required)
 * - Does NOT return a refresh token (safe for client-side)
 *
 * Scopes requested: drive.file, spreadsheets, script.projects, script.deployments
 */

const Auth = (() => {
  let tokenClient = null;
  let tokenClientClientId = null;
  let tokenResolve = null;
  let tokenReject  = null;

  function resetTokenClient() {
    tokenClient = null;
    tokenClientClientId = null;
  }

  // ── Init GIS ─────────────────────────────────────────────────
  function initGIS(customScope) {
    return new Promise((resolve, reject) => {
      if (typeof google === 'undefined' || !google.accounts) {
        reject(new Error('Google Identity Services library not loaded. Ensure the GIS script tag is present.'));
        return;
      }

      const scopeToUse = customScope || CONFIG.OAUTH_SCOPES || CONFIG.DRIVE_SCOPES || CONFIG.AUTH_SCOPES || 'openid email profile';

      try {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: CONFIG.GOOGLE_CLIENT_ID,
          scope: scopeToUse,
          callback: (response) => {
            if (response.error) {
              const errMsg = response.error_description || response.error;
              if (tokenReject) tokenReject(new Error(`Google Sign-In error: ${errMsg}`));
              tokenReject = null; tokenResolve = null;
              return;
            }

            // Persist token with expiry
            const expiresInSec = parseInt(response.expires_in, 10) || 3600;
            const expiresAt = Date.now() + (expiresInSec - 60) * 1000;
            const authData = {
              accessToken: response.access_token,
              expiresAt,
              tokenType: response.token_type || 'Bearer',
              isDemo: false,
              // A real Google sign-in must clear the "email login" flag —
              // otherwise hasGoogleToken() kept returning false and the room
              // history was never loaded from the Sheet.
              isEmailAuth: false,
            };

            Storage.setAuth({ ...Storage.getAuth(), ...authData });
            if (tokenResolve) tokenResolve(authData);
            tokenReject = null; tokenResolve = null;
          },
          error_callback: (err) => {
            let msg = 'Google Sign-In popup closed or cancelled.';
            if (err && err.message) msg = err.message;
            else if (err && err.type) msg = `Google Auth: ${err.type}`;
            if (tokenReject) tokenReject(new Error(msg));
            tokenReject = null; tokenResolve = null;
          },
        });

        tokenClientClientId = CONFIG.GOOGLE_CLIENT_ID;
        resolve(tokenClient);
      } catch (err) {
        reject(err);
      }
    });
  }

  // ── Load GIS script dynamically ───────────────────────────────
  function loadGISScript() {
    return new Promise((resolve, reject) => {
      if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
        resolve();
        return;
      }
      if (document.getElementById('gis-script')) {
        // Script tag exists, wait until google object is ready
        let checks = 0;
        const interval = setInterval(() => {
          if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
            clearInterval(interval);
            resolve();
          } else if (++checks > 50) {
            clearInterval(interval);
            reject(new Error('Google Identity Services library not loaded (timeout waiting for GIS).'));
          }
        }, 100);
        return;
      }
      const script = document.createElement('script');
      script.id = 'gis-script';
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload  = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Google Identity Services library. Check internet connection.'));
      document.head.appendChild(script);
    });
  }

  // ── Get valid access token (refresh if needed) ────────────────
  // forceRefresh=true bypasses the cached token. A 401 means the cached
  // token is dead even if expiresAt says otherwise, so callers must force.
  async function getAccessToken(forceRefresh = false) {
    const auth = Storage.getAuth();

    // A real, unexpired Google token is the only thing that may be sent to a
    // Google API. Email/demo logins carry a local placeholder token
    // (`email_token_…` / `demo_token_…`); sending it produced a 401 and then
    // an unsolicited OAuth popup. Fail clearly instead, so the caller can ask
    // the user to continue with Google.
    if (!forceRefresh && hasGoogleToken()) {
      return auth.accessToken;
    }

    if (auth && (auth.isDemo || auth.isEmailAuth ||
        String(auth.accessToken || '').startsWith('email_token_') ||
        String(auth.accessToken || '').startsWith('demo_token_'))) {
      throw new Error('Google sign-in is required for this action. Please continue with Google first.');
    }

    // Token expired or missing — request a new one.
    return requestToken();
  }

  // ── Request a new token (opens Google popup) ──────────────────
  async function requestToken() {
    await loadGISScript();
    if (!tokenClient || tokenClientClientId !== CONFIG.GOOGLE_CLIENT_ID) {
      await initGIS();
    }

    return new Promise((resolve, reject) => {
      tokenResolve = resolve;
      tokenReject  = reject;
      tokenClient.requestAccessToken({ prompt: '' });
    });
  }

  // ── Sign In (force consent + fetch user profile) ──────────────
  async function signIn() {
    if (!CONFIG.isGoogleConfigured()) {
      throw new Error('Google OAuth Client ID is not configured. Please enter your Client ID below.');
    }
    await loadGISScript();
    if (!tokenClient || tokenClientClientId !== CONFIG.GOOGLE_CLIENT_ID) {
      await initGIS();
    }

    return new Promise((resolve, reject) => {
      tokenResolve = async (authData) => {
        try {
          // Fetch user profile from Google
          const profile = await fetchUserProfile(authData.accessToken);
          const fullAuth = { ...authData, user: profile };
          Storage.setAuth(fullAuth);
          if (profile.name) {
            localStorage.setItem('shepu_display_name', profile.name);
          }
          // A manually-set Settings photo wins over the Google photo —
          // login must NEVER wipe a photo the user chose before logging in.
          try {
            const custom = localStorage.getItem('shepu_pic_custom') === '1';
            if (!custom) {
              if (profile.picture) localStorage.setItem('shepu_profile_pic', profile.picture);
              else localStorage.removeItem('shepu_profile_pic');
            }
          } catch {}
          resolve(fullAuth);
        } catch (e) {
          // Even if userinfo fails, auth is still valid
          const fallbackProfile = {
            sub: 'user_' + Date.now(),
            email: 'user@google.account',
            name: 'Google User',
            picture: '',
          };
          const fullAuth = { ...authData, user: fallbackProfile };
          Storage.setAuth(fullAuth);
          localStorage.setItem('shepu_display_name', fallbackProfile.name);
          // No photo from fallback: clear a previous Google photo, but keep
          // a manually-chosen one (same custom-photo rule as above).
          try {
            if (localStorage.getItem('shepu_pic_custom') !== '1') localStorage.removeItem('shepu_profile_pic');
          } catch {}
          resolve(fullAuth);
        }
      };
      tokenReject = reject;
      tokenClient.requestAccessToken({ prompt: 'select_account' });
    });
  }

  // ── Sign In with Guest / Local Account ────────────────────────
  function signInAsDemo(name = 'Guest', email = 'guest@pchat.local') {
    const demoAuth = {
      accessToken: 'demo_token_' + Date.now(),
      expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
      tokenType: 'Bearer',
      isDemo: true,
      user: {
        sub: 'demo_dev_' + Date.now(),
        email: email,
        name: name,
        picture: '',
      },
    };
    Storage.setAuth(demoAuth);
    localStorage.setItem('shepu_display_name', name);
    // Email/demo logins carry no photo: drop a previous Google photo unless
    // the user manually chose one (custom photos survive every login).
    try {
      if (localStorage.getItem('shepu_pic_custom') !== '1') localStorage.removeItem('shepu_profile_pic');
    } catch {}
    return demoAuth;
  }

  // ── Fetch user profile ────────────────────────────────────────
  async function fetchUserProfile(accessToken) {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error('Failed to fetch user profile');
    const data = await res.json();
    return {
      sub:    data.sub,
      email:  data.email,
      name:   data.name,
      picture:data.picture,
    };
  }

  // ── Sign Out ──────────────────────────────────────────────────
  function signOut() {
    const auth = Storage.getAuth();
    const token = auth && auth.accessToken ? String(auth.accessToken) : '';
    const realGoogleToken = token && !auth.isDemo && !auth.isEmailAuth &&
      !token.startsWith('email_token_') && !token.startsWith('demo_token_');
    if (realGoogleToken && typeof google !== 'undefined' && google.accounts?.oauth2) {
      try { google.accounts.oauth2.revoke(token, () => {}); } catch { /* ignore */ }
    }
    // Also end the Firebase social session, if the SDK was loaded.
    // Fire-and-forget: signing out of the app must never block.
    try {
      if (window.Friends && typeof window.Friends.reset === 'function') {
        window.Friends.reset();
      }
      if (window.Firebase && window.Firebase.isInitialized()) {
        window.Firebase.signOut();
      }
    } catch { /* non-fatal */ }
    Storage.clearAuth();
    Storage.clearSession();
  }

  // ── Is authenticated ──────────────────────────────────────────
  function isAuthenticated() {
    const auth = Storage.getAuth();
    if (!auth) return false;
    // User is logged into the app if they have an active user profile
    if (auth.user && (auth.user.name || auth.user.email)) return true;
    return !!(auth.accessToken && Date.now() < (auth.expiresAt || 0));
  }

  // ── Has active Google OAuth access token (no background popups) ──
  function hasGoogleToken() {
    const auth = Storage.getAuth();
    if (!auth || !auth.accessToken || auth.isDemo || auth.isEmailAuth) return false;
    // Email/demo logins use fake local tokens, never valid for Google APIs
    if (String(auth.accessToken).startsWith('email_token_') || String(auth.accessToken).startsWith('demo_token_')) return false;
    return Date.now() < (auth.expiresAt || 0);
  }

  // ── Get user info ─────────────────────────────────────────────
  function getUser() {
    const auth = Storage.getAuth();
    return auth ? auth.user : null;
  }

  // ── Sign In with Gmail / Email directly ───────────────────────
  function signInWithEmail(email, name) {
    if (!email || !email.includes('@')) {
      throw new Error('Please enter a valid Gmail / Email address.');
    }
    const cleanEmail = email.trim().toLowerCase();
    const cleanName = (name && name.trim()) || cleanEmail.split('@')[0];
    const authData = {
      accessToken: 'email_token_' + Date.now(),
      expiresAt: Date.now() + 365 * 24 * 3600 * 1000,
      tokenType: 'Bearer',
      isEmailAuth: true,
      user: {
        sub: 'email_user_' + btoa(cleanEmail).replace(/=/g, ''),
        email: cleanEmail,
        name: cleanName,
        picture: '',
      },
    };
    Storage.setAuth(authData);
    localStorage.setItem('shepu_display_name', cleanName);
    try {
      if (localStorage.getItem('shepu_pic_custom') !== '1') localStorage.removeItem('shepu_profile_pic');
    } catch {}
    return authData;
  }

  return {
    signIn,
    signInAsDemo,
    signInWithEmail,
    signOut,
    getAccessToken,
    isAuthenticated,
    hasGoogleToken,
    getUser,
    loadGISScript,
    initGIS,
    resetTokenClient,
  };
})();

window.Auth = Auth;
