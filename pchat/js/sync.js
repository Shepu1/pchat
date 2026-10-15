/**
 * SHEPU ROOMS — sync.js
 * Incremental message synchronization with exponential backoff.
 * Uses a "lastRow" cursor to only fetch new rows, avoiding full-sheet reads.
 * All syncing is completely silent — no UI flicker, no scroll jump on background polls.
 */

const Sync = (() => {
  let _roomId        = null;
  let _endpointUrl   = null;
  let _lastRow       = 0;      // Incremental cursor: 0 fetches all recent messages
  let _syncTimer     = null;
  let _isRunning     = false;
  let _onMessages    = null;   // Callback: (messages) => void
  let _consecutiveFails = 0;
  let _offlineMode   = false;

  // ── Start sync loop ───────────────────────────────────────────
  function start({ roomId, endpointUrl, lastRow = 0, onMessages }) {
    _roomId      = roomId;
    _endpointUrl = endpointUrl;
    _lastRow     = lastRow;
    _onMessages  = onMessages;
    _isRunning   = true;
    _consecutiveFails = 0;
    _offlineMode = false;

    scheduleNext(0); // First poll immediately
  }

  // ── Stop sync loop ────────────────────────────────────────────
  function stop() {
    _isRunning = false;
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
    _clearOfflineIndicator();
  }

  // ── Schedule next poll ────────────────────────────────────────
  function scheduleNext(delayMs) {
    if (!_isRunning) return;
    _syncTimer = setTimeout(poll, delayMs);
  }

  // ── Poll (completely silent — no UI changes unless offline/error) ──
  async function poll() {
    if (!_isRunning || !_endpointUrl) return;

    try {
      // Fetch silently — no sync bar shown during normal polling
      const res = await RoomAPI.getMessages(_endpointUrl, { afterRow: _lastRow, limit: 50 });

      if (!res.success) {
        throw new Error(res.error || 'Sync failed');
      }

      const messages = res.messages || [];
      const lastRow  = res.lastRow != null ? res.lastRow : _lastRow;

      if (messages.length > 0) {
        // Cache in IndexedDB silently
        try {
          await IDBStorage.putMessages(messages.map(m => ({ ...m, roomId: _roomId })));
        } catch { /* non-critical */ }

        // Update cursor
        _lastRow = lastRow;
        Storage.setSyncCursor(_roomId, { lastRow: _lastRow });

        // Fire callback — only when there are genuinely NEW messages
        if (_onMessages) _onMessages(messages);
      }

      // Back online after being offline — clear indicator silently
      if (_offlineMode) {
        _offlineMode = false;
        _clearOfflineIndicator();
      }

      _consecutiveFails = 0;
      scheduleNext(CONFIG.SYNC_INTERVAL_MS);

    } catch (err) {
      _consecutiveFails++;
      const backoff = Math.min(
        CONFIG.BASE_BACKOFF_MS * Math.pow(2, _consecutiveFails),
        60000 // Max 60s
      );

      // Only show offline indicator after sustained failures and browser is truly offline
      if (_consecutiveFails >= 5 && !navigator.onLine) {
        _offlineMode = true;
        _showOfflineIndicator();
      }

      scheduleNext(backoff);
    }
  }

  // ── Force immediate sync ──────────────────────────────────────
  async function forceSync() {
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
    await poll();
  }

  // ── Offline indicator (subtle dot + banner, no layout disruption) ──
  function _showOfflineIndicator() {
    const dot = document.getElementById('status-dot');
    if (dot) { dot.classList.remove('online'); dot.classList.add('offline'); }
    const bar = document.getElementById('sync-bar');
    if (bar) bar.classList.remove('hidden');
    const toast = document.getElementById('offline-toast');
    if (toast) toast.classList.remove('hidden');
  }

  function _showErrorIndicator() {
    const dot = document.getElementById('status-dot');
    if (dot) { dot.classList.remove('online'); dot.classList.add('offline'); }
  }

  function _clearOfflineIndicator() {
    const dot = document.getElementById('status-dot');
    if (dot) { dot.classList.add('online'); dot.classList.remove('offline'); }
    const bar = document.getElementById('sync-bar');
    if (bar) bar.classList.add('hidden');
    const toast = document.getElementById('offline-toast');
    if (toast) toast.classList.add('hidden');
  }

  // ── Current cursor ────────────────────────────────────────────
  function getLastRow() { return _lastRow; }
  function setLastRow(n) {
    _lastRow = n;
    Storage.setSyncCursor(_roomId, { lastRow: n });
  }

  return { start, stop, forceSync, getLastRow, setLastRow };
})();

window.Sync = Sync;
