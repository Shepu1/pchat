/**
 * PCHAT — Google Analytics for Firebase
 *
 * Firebase automatically records the initial page_view once Analytics is
 * initialized. Do not send message text, room links, names, email addresses,
 * or any other personally identifying data with Analytics events.
 */
(() => {
  const SDK_VERSION = '13.1.0';
  const CDN = 'https://www.gstatic.com/firebasejs/' + SDK_VERSION;
  const config = window.FIREBASE_CONFIG;

  if (!config || !config.apiKey || !config.projectId || !config.measurementId) return;

  const queuedEvents = [];
  let analyticsInstance = null;
  let logEventFn = null;
  let ready = false;

  function track(name, params = {}) {
    // Events fired before the SDK finishes loading are queued, not dropped.
    if (!ready) {
      queuedEvents.push([name, params]);
      return;
    }
    try {
      logEventFn(analyticsInstance, name, params);
    } catch (e) {
      console.warn('[Analytics] logEvent error:', e);
    }
  }

  // Expose the API immediately so early interactions (for example login) are
  // still measured. isReady flips to true once Firebase Analytics is active.
  window.PchatAnalytics = { isReady: false, logEvent: track };

  async function startAnalytics() {
    const [appMod, analyticsMod] = await Promise.all([
      import(CDN + '/firebase-app.js'),
      import(CDN + '/firebase-analytics.js'),
    ]);

    // Analytics is not supported in every browser/context (for example some
    // privacy-restricted environments), so leave the chat fully functional.
    if (!(await analyticsMod.isSupported())) return;

    const app = appMod.getApps().length
      ? appMod.getApp()
      : appMod.initializeApp(config);
    const analytics = analyticsMod.getAnalytics(app);

    analyticsInstance = analytics;
    logEventFn = analyticsMod.logEvent;
    ready = true;
    window.PchatAnalytics.instance = analytics;
    window.PchatAnalytics.isReady = true;

    // Flush events captured while the SDK was loading.
    queuedEvents.splice(0).forEach(([name, params]) => track(name, params));

    try {
      console.log('[Pchat Analytics] Google Analytics active (Measurement ID: ' + config.measurementId + ')');
    } catch {}
  }

  startAnalytics().catch((error) => {
    // Analytics must never prevent the app from loading. Keep a diagnostic for
    // developers without exposing it to visitors in the UI.
    window.__PCHAT_ANALYTICS_ERROR__ = error;
    console.warn('[Pchat Analytics] Initialization info:', (error && error.message) || error);
  });
})();
