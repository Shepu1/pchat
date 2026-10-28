/**
 * SHEPU ROOMS — Firebase public config
 *
 * This object is PUBLIC. The API key identifies the project; it does not
 * grant access. Firestore Security Rules remain essential; App Check adds an
 * app-attestation signal and must be enabled for Firestore in Firebase Console.
 *
 * Never put a service-account key or any private secret in this file.
 *
 * Setup:
 *   Firebase Console → Project settings → General → Your apps → Web
 *   Copy the entire firebaseConfig object, including measurementId, from
 *   Firebase Console → Project settings → Your apps → Web app.
 */

window.FIREBASE_CONFIG = {
  apiKey: 'AIzaSyD3nPWcBxSe1H7-NRazh9ck64G_ljzk7yI',
  authDomain: 'pchat-shepu.firebaseapp.com',
  projectId: 'pchat-shepu',
  storageBucket: 'pchat-shepu.firebasestorage.app',
  messagingSenderId: '1019767137930',
  appId: '1:1019767137930:web:c13334f7d79ba6e789ef73',
  measurementId: 'G-HJWKRVSGM6',
};

// Public reCAPTCHA v3 site key only. Set this to the key registered for this
// Firebase web app; never put the matching reCAPTCHA secret in this file.
window.FIREBASE_APPCHECK_SITE_KEY = '';

// Shared bootstrap ensures App Check starts once and before Analytics/Auth/
// Firestore touch the Firebase app, even when their lazy loaders race.
window.ensurePchatAppCheck = function (app, appCheckMod) {
  const siteKey = String(window.FIREBASE_APPCHECK_SITE_KEY || '').trim();
  if (!siteKey || !appCheckMod) return Promise.resolve(null);
  if (window.__PCHAT_APPCHECK_PROMISE__) return window.__PCHAT_APPCHECK_PROMISE__;
  window.__PCHAT_APPCHECK_PROMISE__ = Promise.resolve().then(() =>
    appCheckMod.initializeAppCheck(app, {
      provider: new appCheckMod.ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true,
    })
  ).catch(error => {
    window.__PCHAT_APPCHECK_PROMISE__ = null;
    throw error;
  });
  return window.__PCHAT_APPCHECK_PROMISE__;
};
