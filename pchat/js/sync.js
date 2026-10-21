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
  let _inFlight      = false;    // a poll is currently running
  let _onMessages    = null;   // Callback: (messages) => void
  let _consecutiveFails = 0;
  let _offlineMode   = false;

  // ── Start sync loop ───────────────────────────────────────────
  function start({ roomId, endpointUrl, lastRow = 0, onMessages }) {
    // Never leave a previous loop running: start() left its timer pending,
    // so a second start() produced two concurrent poll loops (double the
    // quota burn, the same rows delivered twice).
    stop();
    _roomId      = roomId;
    _endpointUrl = endpointUrl;
    // The cursor is a row number — normalise so a legacy {lastRow:N} object
    // can never reach the API as "afterRow=[object Object]".
    _lastRow     = (lastRow && typeof lastRow === 'object') ? (Number(lastRow.lastRow) || 0) : (Number(lastRow) || 0);
    _onMessages  = onMessages;
    _isRunning   = true;
    _consecutiveFails = 0;
    _offlineMode = false;

    scheduleNext(0); // First poll immediately
  }

  // ── Stop the sync loop ────────────────────────────────────────
  function stop() {
    _isRunning = false;
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
  }


  // ── Schedule next poll ────────────────────────────────────────
  function scheduleNext(delayMs) {
    if (!_isRunning) return;
    _syncTimer = setTimeout(poll, delayMs);
  }

  // ── Poll (completely silent — no UI changes unless offline/error) ──
  async function poll() {
    if (!_isRunning || !_endpointUrl) return;
    // Never run two polls at once — forceSync() (visibility change) used to
    // overlap the scheduled poll, so the same rows were fetched and
    // rendered twice.
    if (_inFlight) return;
    _inFlight = true;
    try {
      // Fetch silently — no sync bar shown during normal polling
      const res = await RoomAPI.getMessages(_endpointUrl, { afterRow: _lastRow, limit: 50 });

      if (!res.success) {
        throw new Error(res.error || 'Sync failed');
      }

      const messages = res.messages || [];
      // Normalise the cursor: a non-numeric value would poison every
      // comparison below ("afterRow=[object Object]").
      const rawLastRow = Number(res.lastRow);
      const lastRow  = Number.isFinite(rawLastRow) ? rawLastRow : _lastRow;

      if (messages.length > 0) {
        // Cache in IndexedDB. A cache is a CACHE — it must never gate
        // delivery. The old order only called _onMessages() after a
        // successful write, so a single rejected put() (quota, DataError)
        // made the chat stay empty AND re-fetched the same rows every
        // 2 seconds forever, with no error shown to the user.
        try {
          await IDBStorage.putMessages(messages.map(m => ({ ...m, roomId: _roomId })));
        } catch (err) {
          try { console.warn('[sync] message cache write failed — showing the messages anyway:', err); } catch {}
        }

        // Advance the cursor and deliver. The messages reached the user,
        // so the cursor must move on — otherwise the same rows would be
        // fetched and re-delivered on every poll.
        _lastRow = lastRow;
        Storage.setSyncCursor(_roomId, _lastRow);
        if (_onMessages) await _onMessages(messages);
      } else if (typeof lastRow === 'number' && lastRow < _lastRow) {
        // The backend's row counter went BACKWARDS — the owner cleared the
        // chat and the sheet lost its rows. Holding on to the old cursor
        // would ask for row 43 of a 1-row sheet forever, and the room would
        // never sync another message. Accept the server's counter.
        _lastRow = lastRow;
        Storage.setSyncCursor(_roomId, _lastRow);
        try { console.warn('[sync] chat was cleared on the server — cursor reset to row ' + lastRow); } catch {}
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
    } finally {
      _inFlight = false;
    }
  }

  // ── Force immediate sync ──────────────────────────────────────
  async function forceSync() {
    if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
    await poll();
    // Make sure the regular loop keeps running afterwards.
    if (_isRunning && !_syncTimer) scheduleNext(CONFIG.SYNC_INTERVAL_MS);
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
    _lastRow = (n && typeof n === 'object') ? (Number(n.lastRow) || 0) : (Number(n) || 0);
    Storage.setSyncCursor(_roomId, _lastRow);
  }

  return { start, stop, forceSync, getLastRow, setLastRow };
})();

window.Sync = Sync;
