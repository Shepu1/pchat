/**
 * SHEPU ROOMS — ntfy-sync.js
 * Cloud history + realtime relay for Instant (P2P) rooms via the public
 * ntfy.sh pub/sub topic. This is what makes Instant rooms survive when the
 * host goes offline: every message published to the room topic can be pulled
 * by any device, so new joiners still get history and live messages arrive
 * even if the host's browser is closed.
 *
 * Transport: ntfy JSON stream (Server-Sent Events style long-poll).
 * No auth, no API key — the topic name is the shared "room channel".
 */

const NtfySync = (() => {
  let _topic = null;
  let _since = 'all';     // ntfy cursor: 'all' to backfill, then a timestamp/id
  let _pollTimer = null;
  let _abortCtrl = null;
  let _running = false;
  let _onEvent = null;    // (parsedData) => void
  const _seenIds = new Set();
  const NTFY_HOST = 'https://ntfy.sh';
  const POLL_INTERVAL_MS = 3000;

  function topicFor(roomId) {
    return `shepu_pchat_${roomId}`;
  }

  function init({ roomId, onEvent }) {
    _topic = topicFor(roomId);
    _onEvent = onEvent;
    _seenIds.clear();
    _since = 'all';
  }

  function start() {
    if (!_topic || _running) return;
    _running = true;
    _poll(0); // first poll immediately (backfill history)
  }

  function stop() {
    _running = false;
    if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
    if (_abortCtrl) { try { _abortCtrl.abort(); } catch {} _abortCtrl = null; }
  }

  // ── Poll the ntfy JSON endpoint for new events ──────────────────
  async function _poll(delayMs = 0) {
    if (!_running || !_topic) return;
    if (delayMs) {
      _pollTimer = setTimeout(() => _poll(0), delayMs);
      return;
    }

    _abortCtrl = new AbortController();
    // Give up on a single poll after a while so we can retry cleanly.
    const timeout = setTimeout(() => { try { _abortCtrl.abort(); } catch {} }, 45000);

    try {
      const url = `${NTFY_HOST}/${_topic}/json?poll=1&since=${encodeURIComponent(_since)}`;
      const res = await fetch(url, { signal: _abortCtrl.signal, headers: { 'Accept': 'application/x-ndjson' } });
      clearTimeout(timeout);

      if (!res.ok || !res.body) {
        throw new Error('ntfy HTTP ' + res.status);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Long-poll: read the stream until it closes or we abort.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          _handleLine(line);
        }
      }
    } catch (err) {
      clearTimeout(timeout);
      if (_running) {
        // Backoff then retry (network hiccup / topic quiet)
        _pollTimer = setTimeout(() => _poll(0), POLL_INTERVAL_MS);
      }
      return;
    }

    // Stream closed normally — poll again shortly.
    if (_running) _poll(POLL_INTERVAL_MS);
  }

  // ── Parse one ndjson line from ntfy ─────────────────────────────
  function _handleLine(line) {
    let evt;
    try { evt = JSON.parse(line); } catch { return; }

    // Advance the cursor so the next poll only fetches newer events.
    if (evt.time) _since = evt.time;

    // ntfy keep-alives and non-message events carry no payload we need.
    if (evt.event && evt.event !== 'message') return;
    if (evt.message == null) return;

    let payload;
    try { payload = JSON.parse(evt.message); } catch { return; }
    if (!payload || typeof payload !== 'object') return;

    if (payload.type === 'message' && payload.msg) {
      const msg = payload.msg;
      if (msg.id && _seenIds.has(msg.id)) return;
      if (msg.id) _seenIds.add(msg.id);
      if (_onEvent) _onEvent({ kind: 'message', msg });
    } else if (payload.type === 'join' && payload.memberId) {
      if (_onEvent) _onEvent({ kind: 'join', member: payload });
    }
  }

  // ── Publish a message/event to the room topic (cloud fallback) ──
  async function publish(payload) {
    if (!_topic) return;
    try {
      await fetch(`${NTFY_HOST}/${_topic}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch { /* best-effort */ }
  }

  return { init, start, stop, publish, topicFor };
})();

window.NtfySync = NtfySync;
