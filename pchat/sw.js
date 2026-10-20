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
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./');
    } catch { /* best effort */ }
  })());
});
