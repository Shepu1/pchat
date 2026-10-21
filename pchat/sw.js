/**
 * SHEPU ROOMS — service worker
 * Required for notifications on Android Chrome, which forbids
 * `new Notification(...)` and only supports
 * `ServiceWorkerRegistration.showNotification(...)`.
 *
 * Deliberately has NO fetch handler: it must never cache or intercept app
 * requests, so updates always come straight from the network.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    try {
      // Focus the tab the notification came from. Focusing "the first
      // window" opened the dashboard (or another room) instead of the room
      // the user was notified about.
      const data = (event.notification && event.notification.data) || {};
      const target = data.url || './';
      let wanted = null;
      try { wanted = new URL(target, self.location.origin).href; } catch { wanted = target; }

      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const hit = all.find(c => c.url === wanted)
        || all.find(c => c.url && wanted && c.url.split('#')[0] === wanted.split('#')[0]);
      if (hit) return hit.focus();

      if (self.clients.openWindow) return self.clients.openWindow(target);
    } catch { /* best effort */ }
  })());
});
