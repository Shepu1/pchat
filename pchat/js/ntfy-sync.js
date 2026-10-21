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
      if (!res.ok) {
        // A 4xx is OUR fault (payload too large, bad request, rate limited) —
        // the server is fine. Marking it as failed made every relay look
        // dead and inflated the reconnect backoff.
        const err = new Error('HTTP ' + res.status);
        err.clientError = res.status >= 400 && res.status < 500;
        throw err;
      }
      markOk(base);
      return true;
    }).catch(err => {
      clearTimeout(timer);
      if (!err || !err.clientError) markFail(base, err);
      return false;
    });
  }

  // ntfy's default message-size-limit is 4096 bytes. A larger body is not
  // delivered as a message (the server treats it as an attachment), so long
  // messages never reached the other devices.
  const RELAY_MAX_BYTES = 4096;

  function _byteLen(str) {
    try { return new TextEncoder().encode(String(str)).length; }
    catch { return String(str).length; }
  }

  // Split an oversized chat message into relay-safe parts. Each part gets its
  // own id so receivers do not dedupe them away; the full message is still
  // stored in the Sheet / local history.
  function _splitForRelay(payload) {
    if (!payload || typeof payload !== 'object') return [payload];
    if (payload.type !== 'message' || !payload.msg) return [payload];
    const msg = payload.msg;
    const text = typeof msg.message === 'string' ? msg.message : '';
    if (!text) return [payload];

    // The unchunked payload is measured exactly.
    if (_byteLen(JSON.stringify(payload)) <= RELAY_MAX_BYTES) return [payload];

    // The overhead of a CHUNK is bigger than the plain envelope: every part
    // carries its own id plus the _part/_parts/_origId markers. Measure a
    // worst-case part (3-digit index, 3-digit count) so the real body can
    // never exceed the relay limit.
    const samplePart = {
      ...msg,
      id: msg.id + '_p999',
      message: '',
      _part: 999,
      _parts: 999,
      _origId: msg.id,
    };
    const overhead = _byteLen(JSON.stringify({ ...payload, msg: samplePart }));
    const budget = RELAY_MAX_BYTES - overhead - 8;   // small safety margin
    if (budget < 32) return [payload];                // cannot split safely

    const parts = [];
    let rest = text;
    // First pass: cut the text into relay-safe chunks.
    while (rest.length) {
      // Largest prefix that still fits into the byte budget.
      let lo = 1, hi = rest.length, take = 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (_byteLen(rest.slice(0, mid)) <= budget) { take = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      const part = rest.slice(0, take);
      rest = rest.slice(take);
      parts.push(part);
    }

    // Second pass: tag every chunk with its index, the total count and the
    // ORIGINAL message id. Without _parts/_origId the receiver has no way to
    // know that a message was cut up — it used to arrive as several
    // separate chat bubbles.
    return parts.map((part, idx) => ({
      ...payload,
      msg: {
        ...msg,
        id: msg.id + '_p' + idx,
        message: part,
        _part: idx,
        _parts: parts.length,
        _origId: msg.id,
      },
    }));
  }

  async function publish(payload, topics) {
    const list = Array.isArray(topics) ? topics.filter(Boolean) : [];
    if (!list.length) return;
    const payloads = _splitForRelay(payload);
    const bodies = payloads.map(p => (typeof p === 'string' ? p : JSON.stringify(p)));
    const bases = servers();
    const jobs = [];
    for (const base of bases) {
      for (const t of list) for (const body of bodies) jobs.push(_post(base, t, body));
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
  let _stopping = false;     // true while stop() is aborting the streams
  let _onEvent = null;      // (event) => void
  let _abortCtrls = [];
  let _restartTimers = new Set();
  let _streams = [];        // { base, topic }
  let _roomId = null;
  let _privateOnly = false;
  // Bumped whenever the topics change (link rotation). Streams opened
  // before the bump are stale and must not keep running or reconnect.
  let _generation = 0;
  const _seenIds = new Set();      // message ids (logical dedupe)
  const SEEN_IDS_MAX = 3000;       // keep the set bounded — it never shrank
  const _lastStreamIds = new Map(); // topic -> last ntfy message id (resume point)
  const _payloadSeen = new Map();  // raw payload -> first-seen ts (short-window)
  const PAYLOAD_SEEN_MAX = 800;
  const PAYLOAD_DEDUPE_MS = 5000;  // same text from another server/topic copy

  // ── Fragment reassembly ─────────────────────────────────────────
  // A message longer than the relay's 4096-byte limit is published as
  // several chunks. Each chunk carries _part/_parts/_origId, so the
  // receiver can stitch them back together — otherwise a 4000-character
  // message (a 4000-character Bengali message is 12000 bytes!) arrived as
  // 3-4 separate chat bubbles, cut mid-word.
  const _fragments = new Map();   // origId -> { parts: Map, total, base, timer }
  const FRAGMENT_TIMEOUT_MS = 30000;

  function _clearFragment(origId) {
    const entry = _fragments.get(origId);
    if (!entry) return null;
    try { if (entry.timer) clearTimeout(entry.timer); } catch {}
    _fragments.delete(origId);
    return entry;
  }

  // Returns the complete message, or null while parts are still missing.
  function _collectFragment(msg) {
    const origId = msg._origId || msg.id;
    const total  = Number(msg._parts) || 0;
    const idx    = Number(msg._part) || 0;
    if (!total || total < 2) return null;

    let entry = _fragments.get(origId);
    if (!entry) {
      entry = { parts: new Map(), total, base: msg, timer: null };
      _fragments.set(origId, entry);
      // Give up on an incomplete message instead of leaking the buffer.
      entry.timer = setTimeout(() => { _fragments.delete(origId); }, FRAGMENT_TIMEOUT_MS);
    }
    entry.total = Math.max(entry.total, total);
    entry.parts.set(idx, msg);
    if (entry.parts.size < entry.total) return null;

    _clearFragment(origId);

    // Rebuild the original message from the collected chunks.
    const ordered = [];
    for (let i = 0; i < entry.total; i++) ordered.push(entry.parts.get(i));
    const rebuilt = { ...entry.base };
    rebuilt.id = origId;
    rebuilt.message = ordered.map(p => (p && typeof p.message === 'string') ? p.message : '').join('');
    delete rebuilt._part;
    delete rebuilt._parts;
    delete rebuilt._origId;
    return rebuilt;
  }

  function topicFor(roomId) {
    return `shepu_pchat_${roomId}`;
  }

  function init({ roomId, roomSecret, onEvent, privateOnly }) {
    _roomId = roomId || _roomId;
    _privateOnly = privateOnly === true;
    // Any stream still running belongs to the previous topic set.
    _generation++;
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
    // Drop half-collected chunks from a previous room/session.
    for (const [, entry] of _fragments) {
      try { if (entry.timer) clearTimeout(entry.timer); } catch {}
    }
    _fragments.clear();
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
    // An intentional abort must not look like a server outage: the aborted
    // fetch rejects, and markFail() would report every relay as dead (and
    // inflate the reconnect backoff) right after a secret rotation.
    _stopping = true;
    _restartTimers.forEach(t => clearTimeout(t));
    _restartTimers.clear();
    _abortCtrls.forEach(c => { try { c.abort(); } catch {} });
    _abortCtrls = [];
    _streams = [];
    setTimeout(() => { _stopping = false; }, 0);
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
    // Never open a stream for a topic we no longer use (link rotation).
    if (Array.isArray(_topics) && _topics.length && !_topics.includes(topic)) return;
    // A generation counter invalidates every stream that was already in
    // flight when the topics changed.
    const gen = _generation;
    const ctrl = new AbortController();
    _abortCtrls.push(ctrl);
    // The FIRST connect needs the backlog (a late joiner must see the room
    // history). Every reconnect used "?since=all" too, so the whole topic
    // was re-downloaded and re-parsed on every sleep/wake or network blip.
    const since = _lastStreamIds.get(topic) || 'all';
    const url = `${base}/${encodeURIComponent(topic)}/json?since=${encodeURIComponent(since)}`;

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
      // An intentional stop() abort is not a server failure.
      if (!_stopping) ShepuRelay._markFail(base, err);
      if (_running && gen === _generation) _scheduleRestart(base, topic, false);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (_running && gen === _generation) {
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
    if (_running && gen === _generation) _scheduleRestart(base, topic, true);
  }

  function _dropCtrl(ctrl) {
    _abortCtrls = _abortCtrls.filter(c => c !== ctrl);
  }

  function _scheduleRestart(base, topic, wasLive) {
    if (!_running) return;
    // The topic may have been replaced while this stream was in flight
    // (link rotation calls setSecret → stop + init + start). Resubscribing
    // to a topic we no longer use kept the OLD, revoked topic alive: the
    // owner kept receiving from it and the revoked participants kept
    // reaching the owner.
    if (Array.isArray(_topics) && _topics.length && !_topics.includes(topic)) return;
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

    // Remember the ntfy message id so a reconnect can resume from here
    // instead of replaying the whole topic history.
    if (evt.id && forTopic) {
      try { _lastStreamIds.set(forTopic, evt.id); } catch {}
    }

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
      // An edit or a delete is broadcast under the ORIGINAL message id, so
      // the id dedupe below would swallow it and members would keep seeing
      // the old text (or a message that should be gone). Updates bypass the
      // dedupe; they are idempotent on the receiving side.
      const isUpdate = (msg.edited === true) || (msg.deleted === true);
      if (!isUpdate && msg.id && _seenIds.has(msg.id)) return;
      if (msg.id) {
        _seenIds.add(msg.id);
        // Keep the dedupe set bounded — a long-lived tab received one id per
        // message (plus relay replays) and the set never shrank.
        if (_seenIds.size > SEEN_IDS_MAX) {
          const drop = _seenIds.size - SEEN_IDS_MAX;
          let i = 0;
          for (const id of _seenIds) {
            _seenIds.delete(id);
            if (++i >= drop) break;
          }
        }
      }
      // A chunk of a longer message: collect it and stay quiet until every
      // chunk has arrived, then deliver the reconstructed message once.
      if (msg._parts && Number(msg._parts) > 1) {
        const rebuilt = _collectFragment(msg);
        if (!rebuilt) return;
        if (rebuilt.id && !_seenIds.has(rebuilt.id)) _seenIds.add(rebuilt.id);
        if (_onEvent) _onEvent({ kind: 'message', msg: rebuilt });
        return;
      }
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
      // The inner signal must be the value of `payload` — app.js forwards it
      // straight to CallManager.handleIncomingSignal(), which needs `.action`.
      // (A second `payload` key here silently overwrote it with the whole
      // envelope, so every relayed call invite was dropped.)
      if (_onEvent) _onEvent({ kind: 'call_signal', payload: payload.payload });
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
