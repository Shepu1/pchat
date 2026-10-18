/**
 * SHEPU ROOMS — ntfy-sync.js
 * Cloud history + realtime relay for Quick (P2P) rooms via the public
 * ntfy.sh pub/sub topic. This is what makes Quick rooms survive when the
 * host goes offline: every message published to the room topic can be pulled
 * by any device, so new joiners still get history and live messages arrive
 * even if the host's browser is closed.
 *
 * Security (zero-cost, zero-friction):
 *  - topics are derived from the room SECRET hash, not the roomId, so they
 *    cannot be guessed without the invite link;
 *  - payloads are E2EE ciphertext (enc:...) — relay only sees ciphertext;
 *  - legacy roomId topic is still polled/published for backward compat.
 *
 * Transport: ntfy JSON stream (Server-Sent Events style long-poll).
 * No auth, no API key — the secret-derived topic name is the channel.
 */

const NtfySync = (() => {
  let _topics = [];
  let _cursors = {};    // topic -> ntfy cursor
  let _pollTimer = null;
  let _abortCtrls = [];
  let _running = false;
  let _onEvent = null;    // (parsedData) => void
  const _seenIds = new Set();
  const NTFY_HOST = 'https://ntfy.sh';
  const POLL_INTERVAL_MS = 3000;

  function topicFor(roomId) {
    return `shepu_pchat_${roomId}`;
  }

  function init({ roomId, roomSecret, onEvent, privateOnly }) {
    try {
      if (typeof InstantSecurity !== 'undefined') {
        const all = InstantSecurity.topicsFor(roomId, roomSecret || null);
        // Password-locked rooms: NEVER touch the guessable legacy topic —
        // not even presence beacons. One private topic only.
        _topics = (privateOnly === true && all.length) ? [all[0]] : all;
      } else {
        _topics = [topicFor(roomId)];
      }
    } catch {
      _topics = [topicFor(roomId)];
    }
    _onEvent = onEvent;
    _seenIds.clear();
    _cursors = {};
    _topics.forEach(t => { _cursors[t] = 'all'; });
  }

  function start() {
    if (!_topics.length || _running) return;
    _running = true;
    _poll(0); // first poll immediately (backfill history)
  }

  function stop() {
    _running = false;
    if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
    _abortCtrls.forEach(c => { try { c.abort(); } catch {} });
    _abortCtrls = [];
  }

  // ── Poll all room topics for new events ─────────────────────────
  async function _poll(delayMs = 0) {
    if (!_running || !_topics.length) return;
    if (delayMs) {
      _pollTimer = setTimeout(() => _poll(0), delayMs);
      return;
    }

    // Poll topics sequentially in one round (keeps quota low, stays free).
    for (const topic of _topics) {
      if (!_running) return;
      const ctrl = new AbortController();
      _abortCtrls.push(ctrl);
      const timeout = setTimeout(() => { try { ctrl.abort(); } catch {} }, 25000);
      try {
        const since = _cursors[topic] || 'all';
        const url = `${NTFY_HOST}/${topic}/json?poll=1&since=${encodeURIComponent(since)}`;
        const res = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/x-ndjson' } });
        clearTimeout(timeout);
        if (!res.ok || !res.body) continue;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
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
        // per-topic hiccup → continue with next topic
      } finally {
        _abortCtrls = _abortCtrls.filter(c => c !== ctrl);
      }
    }

    // Round complete — poll again shortly.
    if (_running) _poll(POLL_INTERVAL_MS);
  }

  // ── Parse one ndjson line from ntfy ─────────────────────────────
  function _handleLine(line) {
    let evt;
    try { evt = JSON.parse(line); } catch { return; }

    // Advance the cursor of the matching topic so the next poll only
    // fetches newer events. ntfy doesn't echo the topic; advance all
    // cursors with this timestamp (monotonic, safe for both topics).
    if (evt.time) {
      _topics.forEach(t => { _cursors[t] = evt.time; });
    }

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
    } else if (payload.type === 'theme' && payload.theme) {
      if (_onEvent) _onEvent({ kind: 'theme', theme: payload.theme });
    } else if (payload.type === 'presence' && payload.member) {
      if (_onEvent) _onEvent({ kind: 'presence', member: payload.member });
    } else if (payload.type === 'join' && payload.memberId) {
      if (_onEvent) _onEvent({ kind: 'join', member: payload });
    } else if (payload.type === 'call_signal' && payload.payload) {
      if (_onEvent) _onEvent({ kind: 'call_signal', payload: payload.payload });
    }
  }

  // ── Publish a message/event to ALL room topics (cloud fallback) ──
  async function publish(payload) {
    if (!_topics.length) return;
    try {
      const body = (typeof payload === 'string') ? payload : JSON.stringify(payload);
      await Promise.all(_topics.map(t =>
        fetch(`${NTFY_HOST}/${t}`, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: body,
        }).catch(() => {})
      ));
    } catch { /* best-effort */ }
  }

  return { init, start, stop, publish };
})();

window.NtfySync = NtfySync;
