/**
 * SHEPU ROOMS — presence.js
 * Throttled presence heartbeat + periodic member list refresh.
 * Does NOT write a Sheet row every second — only on join, interval, visibility, and unload.
 */

const Presence = (() => {
  let _endpointUrl   = null;
  let _memberId      = null;
  let _sessionToken  = null;
  let _heartbeatTimer= null;
  let _membersTimer  = null;
  let _onMembersUpdate = null;
  let _roomId        = null;
  let _announce      = null;
  let _running       = false;

  // ── Start presence system ─────────────────────────────────────
  function start({ endpointUrl, memberId, sessionToken, onMembersUpdate, roomId, announce }) {
    // Never leave a previous pair of timers running: start() used to be
    // callable more than once and each call added another heartbeat.
    stop();

    _endpointUrl     = endpointUrl;
    _memberId        = memberId;
    _sessionToken    = sessionToken;
    _onMembersUpdate = onMembersUpdate;
    _roomId          = roomId;
    _announce        = (typeof announce === 'function') ? announce : null;
    _running         = true;

    // Immediate presence + member refresh
    heartbeat();
    refreshMembers();

    // Schedule heartbeats every 20s
    _heartbeatTimer = setInterval(() => {
      if (_running) heartbeat();
    }, CONFIG.PRESENCE_INTERVAL_MS);

    // Refresh member list every 30s
    _membersTimer = setInterval(() => {
      if (_running) refreshMembers();
    }, 30000);
  }

  // ── Stop the presence timers ───────────────────────────────────
  // (This was exported but never defined, so `Presence.stop` resolved to the
  //  built-in window.stop — which stops PAGE LOADING, not the heartbeat.)
  function stop() {
    _running = false;
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
    if (_membersTimer) { clearInterval(_membersTimer); _membersTimer = null; }
  }


  // ── Send heartbeat ────────────────────────────────────────────
  async function heartbeat(status = 'online') {
    if (!_endpointUrl || !_memberId || !_sessionToken) return;
    try {
      await RoomAPI.updatePresence(_endpointUrl, {
        memberId:     _memberId,
        sessionToken: _sessionToken,
        status,
      });
    } catch { /* silent fail */ }
    // Cross-device announce (ntfy beacon) — best-effort, never throws.
    try { if (_announce) _announce(status); } catch {}
  }

  // ── Refresh member list ───────────────────────────────────────
  async function refreshMembers() {
    if (!_endpointUrl) return;
    try {
      // Use the room this Presence instance was started for. The session is
      // a single global localStorage key shared by every tab, so a second
      // tab on another room would otherwise make this one fetch — and
      // render — the wrong room's member list.
      const roomId = _roomId || (Storage.getSession() || {}).roomId;
      if (!roomId) return;

      const members = await Members.fetchAndCache(_endpointUrl, roomId);
      if (_onMembersUpdate) _onMembersUpdate(members);
    } catch { /* silent fail */ }
  }

  return { start, stop, heartbeat, refreshMembers };
})();

window.Presence = Presence;
