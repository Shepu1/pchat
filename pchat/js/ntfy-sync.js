/**
 * SHEPU ROOMS — ntfy-sync.js
 * Cloud relay for Quick (P2P) rooms: realtime delivery + history, with
 * MULTI-SERVER FAILOVER.
 *
 * Why multi-server? The previous version talked to a single hardcoded host
 * (`https://ntfy.sh`). When that one host is down, rate-limited, or blocked
 * by an ISP/country, the whole relay dies *silently* (every call ends in
 * `.catch(() => {})`). Chat then only works while two devices can reach each
 * other directly over WebRTC — which fails across many NATs/mobile networks.
 * Result: "it works on my device but nobody can chat in rooms made by a
 * friend". We now publish to, and stream from, several independent public
 * ntfy servers, so one blocked server can never take the room down.
 *
 * Security (unchanged, zero-cost, zero-friction):
 *  - topics are derived from the room SECRET hash, not the roomId, so they
 *    cannot be guessed without the invite link;
 *  - payloads are E2EE ciphertext (enc:...) when a key exists — the relay
 *    only ever sees ciphertext;
 *  - the legacy roomId topic is still used for backward compatibility.
 *
 * Transport: ntfy JSON stream (Server-Sent-Events style, one long-lived
 * request per server/topic — far friendlier to rate limits than polling).
 * No auth, no API key: the secret-derived topic name is the channel.
 */

// ── Relay core: server list + resilient publish ──────────────────────
// Exposed globally so pages that never start a subscription (index.html,
// create.html) can still announce rooms to every relay.
const ShepuRelay = (() => {
  // Independent public ntfy servers. Order = preference; ALL are used.
  // ntfy.sh stays first (canonical) but is no longer a single point of
  // failure. Users can override the list from the browser console:
  //   ShepuRelay.setServers(['https://my.ntfy.host'])
  const DEFAULT_SERVERS = [
    'https://ntfy.sh',
    'https://ntfy.envs.net',
    'https://ntfy.adminforge.de',
    'https://ntfy.mzte.de',
  ];

  const LS_KEY = 'shepu_relay_servers';
  const _health = new Map();   // base -> { ok, fails, lastOk, lastError }
  let _onHealth = null;

  function normalize(base) {
    let s = String(base || '').trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s.replace(/\/+$/, '');
  }

  function servers() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          const clean = arr.map(normalize).filter(Boolean);
          if (clean.length) return [...new Set(clean)];
        }
      }
    } catch { /* ignore */ }
    return DEFAULT_SERVERS.slice();
  }

  function setServers(list) {
    const clean = [...new Set((Array.isArray(list) ? list : []).map(normalize).filter(Boolean))];
    if (!clean.length) return false;
    try { localStorage.setItem(LS_KEY, JSON.stringify(clean)); } catch {}
    return true;
  }

  function resetServers() {
    try { localStorage.removeItem(LS_KEY); } catch {}
  }

  function _health0(base) {
    if (!_health.has(base)) _health.set(base, { ok: false, fails: 0, lastOk: 0, lastError: '' });
    return _health.get(base);
  }

  function markOk(base) {
    const h = _health0(base);
    const wasOk = h.ok;
    h.ok = true; h.fails = 0; h.lastOk = Date.now(); h.lastError = '';
    if (!wasOk && _onHealth) { try { _onHealth(health()); } catch {} }
  }

  function markFail(base, err) {
    const h = _health0(base);
    const wasOk = h.ok;
    h.ok = false; h.fails += 1; h.lastError = (err && err.message) || String(err || 'error');
    if (wasOk && _onHealth) { try { _onHealth(health()); } catch {} }
  }

  function health() {
    const bases = servers();
    const list = bases.map(base => {
      const h = _health0(base);
      return { server: base, ok: h.ok, fails: h.fails, lastError: h.lastError };
    });
    return { total: list.length, reachable: list.filter(x => x.ok).length, servers: list };
  }

  function onHealthChange(cb) { _onHealth = (typeof cb === 'function') ? cb : null; }

  // Publish one payload to every server × every topic. Best-effort: a dead
  // server must never block the others or the caller. Each request is
  // aborted after PUBLISH_TIMEOUT_MS so an unreachable host cannot linger
  // for minutes holding sockets.
  const PUBLISH_TIMEOUT_MS = 10000;
  function _post(base, topic, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, PUBLISH_TIMEOUT_MS);
    return fetch(`${base}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body,
      signal: ctrl.signal,
    }).then(res => {
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      markOk(base);
      return true;
    }).catch(err => { clearTimeout(timer); markFail(base, err); return false; });
  }

  async function publish(payload, topics) {
    const list = Array.isArray(topics) ? topics.filter(Boolean) : [];
    if (!list.length) return;
    const body = (typeof payload === 'string') ? payload : JSON.stringify(payload);
    const bases = servers();
    const jobs = [];
    for (const base of bases) {
      for (const t of list) jobs.push(_post(base, t, body));
    }
    const results = await Promise.allSettled(jobs);
    return results.some(r => r.status === 'fulfilled' && r.value === true);
  }

  // Quick reachability report (also handy from the console):
  //   await ShepuRelay.diagnose()
  async function diagnose() {
    const bases = servers();
    const rows = await Promise.all(bases.map(async base => {
      const t0 = Date.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(`${base}/v1/health`, { signal: ctrl.signal });
        clearTimeout(timer);
        const ok = res.ok;
        if (ok) markOk(base); else markFail(base, new Error('HTTP ' + res.status));
        return { server: base, ok, ms: Date.now() - t0 };
      } catch (err) {
        markFail(base, err);
        return { server: base, ok: false, ms: Date.now() - t0, error: (err && err.message) || String(err) };
      }
    }));
    const reachable = rows.filter(r => r.ok).length;
    const report = { reachable, total: rows.length, servers: rows };
    try {
      console.log(
        `%c[relay] ${reachable}/${rows.length} servers reachable`,
        reachable ? 'color:#34d399;font-weight:bold' : 'color:#f87171;font-weight:bold'
      );
      console.table(rows);
    } catch {}
    return report;
  }

  return {
    servers, setServers, resetServers, normalize,
    health, onHealthChange, publish, diagnose,
    // internal health hooks (used by the realtime streamer)
    _markOk: markOk, _markFail: markFail, _failCount: (base) => _health0(base).fails,
  };
})();

window.ShepuRelay = ShepuRelay;

// ── Realtime subscription (multi-server streams) ─────────────────────
const NtfySync = (() => {
  let _topics = [];
  let _running = false;
  let _onEvent = null;      // (event) => void
  let _abortCtrls = [];
  let _restartTimers = new Set();
  let _streams = [];        // { base, topic }
  let _roomId = null;
  let _privateOnly = false;
  const _seenIds = new Set();      // message ids (logical dedupe)
  const _payloadSeen = new Map();  // raw payload -> first-seen ts (short-window)
  const PAYLOAD_SEEN_MAX = 800;
  const PAYLOAD_DEDUPE_MS = 5000;  // same text from another server/topic copy

  function topicFor(roomId) {
    return `shepu_pchat_${roomId}`;
  }

  function init({ roomId, roomSecret, onEvent, privateOnly }) {
    _roomId = roomId || _roomId;
    _privateOnly = privateOnly === true;
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
    _payloadSeen.clear();
  }

  function start() {
    if (!_topics.length || _running) return;
    _running = true;
    _streams = [];
    ShepuRelay.onHealthChange(health => {
      // Surface a one-shot warning when *no* relay is reachable, so the
      // failure is never silent again.
      try {
        if (health && health.total && health.reachable === 0) {
          console.warn('[relay] no relay server reachable — cross-device delivery is down');
        }
      } catch {}
    });
    const bases = ShepuRelay.servers();
    for (const base of bases) {
      for (const topic of _topics) {
        _streams.push({ base, topic });
        _startStream(base, topic);
      }
    }
    // One-shot guard: if NOTHING is reachable shortly after start, say so
    // loudly instead of failing silently (the old bug's root cause).
    setTimeout(() => {
      try {
        if (!_running) return;
        const h = ShepuRelay.health();
        if (h.total && h.reachable === 0) {
          console.error('[relay] 0/' + h.total + ' relay servers reachable. Cross-device chat will not work. Run `await ShepuRelay.diagnose()` for details.');
          if (typeof UI !== 'undefined' && UI.toast) {
            UI.toast('warning', 'Relay unreachable',
              'No message relay is reachable. Chat may only work on this device. Check your internet / VPN.');
          }
        } else {
          console.log('[relay] ' + h.reachable + '/' + h.total + ' relay servers reachable');
        }
      } catch {}
    }, 12000);
  }

  function stop() {
    _running = false;
    _restartTimers.forEach(t => clearTimeout(t));
    _restartTimers.clear();
    _abortCtrls.forEach(c => { try { c.abort(); } catch {} });
    _abortCtrls = [];
    _streams = [];
  }

  // Link rotation: drop the old topics and subscribe to the new secret's
  // private topic. Without this the current tab kept listening/publishing on
  // the revoked topic, so freshly-invited guests and existing members split.
  function setSecret(roomSecret) {
    if (!_roomId) return;
    const wasRunning = _running;
    stop();
    init({ roomId: _roomId, roomSecret: roomSecret || null, onEvent: _onEvent, privateOnly: _privateOnly });
    if (wasRunning) start();
  }

  function getTopics() { return _topics.slice(); }

  // ── One long-lived stream per (server, topic) ───────────────────
  async function _startStream(base, topic) {
    if (!_running) return;
    const ctrl = new AbortController();
    _abortCtrls.push(ctrl);
    const url = `${base}/${encodeURIComponent(topic)}/json?since=all`;

    let res;
    try {
      res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'Accept': 'application/x-ndjson' },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (!res.body || typeof res.body.getReader !== 'function') throw new Error('no stream body');
      ShepuRelay._markOk(base);
    } catch (err) {
      _dropCtrl(ctrl);
      ShepuRelay._markFail(base, err);
      if (_running) _scheduleRestart(base, topic, false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (_running) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) _handleLine(line, topic);
        }
      }
    } catch { /* aborted or network drop */ }

    _dropCtrl(ctrl);
    if (_running) _scheduleRestart(base, topic, true);
  }

  function _dropCtrl(ctrl) {
    _abortCtrls = _abortCtrls.filter(c => c !== ctrl);
  }

  function _scheduleRestart(base, topic, wasLive) {
    if (!_running) return;
    // A stream that was working and then dropped → reconnect fast.
    // A server that never connected → exponential-ish backoff, max 60s.
    const delay = wasLive ? 1500 : Math.min(60000, 2000 * Math.pow(2, Math.min(5, _failCount(base))));
    const t = setTimeout(() => {
      _restartTimers.delete(t);
      if (_running) _startStream(base, topic);
    }, delay);
    _restartTimers.add(t);
  }

  function _failCount(base) {
    try { return ShepuRelay._failCount(base) || 0; } catch { return 0; }
  }

  // Short-window payload dedupe: identical text arriving within a few seconds
  // is the same event echoed by another relay server/topic. Identical text
  // arriving later is a new, intentional event and must be delivered.
  function _isDuplicatePayload(fp) {
    const now = Date.now();
    if (_payloadSeen.size >= PAYLOAD_SEEN_MAX) {
      for (const [k, t] of _payloadSeen) {
        if (now - t > PAYLOAD_DEDUPE_MS) _payloadSeen.delete(k);
      }
      // Still full of active entries: drop the oldest quarter.
      if (_payloadSeen.size >= PAYLOAD_SEEN_MAX) {
        let n = Math.floor(PAYLOAD_SEEN_MAX / 4);
        for (const k of _payloadSeen.keys()) { _payloadSeen.delete(k); if (--n <= 0) break; }
      }
    }
    const seenAt = _payloadSeen.get(fp);
    if (seenAt != null && now - seenAt < PAYLOAD_DEDUPE_MS) return true;
    _payloadSeen.set(fp, now);
    return false;
  }

  // ── Parse one ndjson line from ntfy ─────────────────────────────
  function _handleLine(line, forTopic) {
    let evt;
    try { evt = JSON.parse(line); } catch { return; }

    // ntfy keep-alives and non-message events carry no payload we need.
    if (evt.event && evt.event !== 'message') return;
    if (evt.message == null) return;

    // Cross-server / cross-topic duplicate suppression, but only for a short
    // window. The previous forever-dedupe dropped legitimate repeats (the
    // same presence heartbeat, the same theme re-applied, an identical
    // reaction action) because their payload text was byte-identical.
    if (_isDuplicatePayload(evt.message)) return;

    let payload;
    try { payload = JSON.parse(evt.message); } catch { return; }
    if (!payload || typeof payload !== 'object') return;

    if (payload.type === 'message' && payload.msg) {
      const msg = payload.msg;
      if (msg.id && _seenIds.has(msg.id)) return;
      if (msg.id) _seenIds.add(msg.id);
      if (_onEvent) _onEvent({ kind: 'message', msg });
    } else if (payload.type === 'seen') {
      if (_onEvent) _onEvent({ kind: 'seen', seenBy: payload.seenBy, messageIds: payload.messageIds, payload });
    } else if (payload.type === 'reaction' && payload.reaction) {
      if (_onEvent) _onEvent({ kind: 'reaction', reaction: payload.reaction, payload });
    } else if (payload.type === 'theme' && payload.theme) {
      if (_onEvent) _onEvent({ kind: 'theme', theme: payload.theme });
    } else if (payload.type === 'presence' && payload.member) {
      if (_onEvent) _onEvent({ kind: 'presence', member: payload.member });
    } else if (payload.type === 'join' && payload.memberId) {
      if (_onEvent) _onEvent({ kind: 'join', member: payload });
    } else if (payload.type === 'call_signal' && payload.payload) {
      if (_onEvent) _onEvent({ kind: 'call_signal', payload: payload.payload, payload });
    } else if (payload.type === 'room_status' && payload.status) {
      if (_onEvent) _onEvent({ kind: 'room_status', status: payload.status, payload });
    }
  }

  // ── Publish a message/event to every server × room topic ────────
  async function publish(payload) {
    if (!_topics.length) return;
    return ShepuRelay.publish(payload, _topics);
  }

  return {
    init, start, stop, publish, setSecret, getTopics,
    health: () => ShepuRelay.health(),
    diagnose: () => ShepuRelay.diagnose(),
  };
})();

window.NtfySync = NtfySync;
