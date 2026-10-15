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
  async function getAccessToken() {
    const auth = Storage.getAuth();

    // If token still valid
    if (auth && auth.accessToken && Date.now() < auth.expiresAt) {
      return auth.accessToken;
    }

    if (auth && auth.isDemo) {
      return auth.accessToken;
    }

    // Token expired or missing — request new one
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

  // ── Sign In with Demo / Developer Account ─────────────────────
  function signInAsDemo(name = 'Developer (Shepu)', email = 'shepu@rooms.local') {
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
    if (auth && auth.accessToken && !auth.isDemo && typeof google !== 'undefined' && google.accounts?.oauth2) {
      try { google.accounts.oauth2.revoke(auth.accessToken, () => {}); } catch { /* ignore */ }
    }
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
