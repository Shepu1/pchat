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
  let _running       = false;

  // ── Start presence system ─────────────────────────────────────
  function start({ endpointUrl, memberId, sessionToken, onMembersUpdate, roomId }) {
    _endpointUrl     = endpointUrl;
    _memberId        = memberId;
    _sessionToken    = sessionToken;
    _onMembersUpdate = onMembersUpdate;
    _roomId          = roomId;
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

  // ── Stop presence ─────────────────────────────────────────────
  function stop() {
    _running = false;
    clearInterval(_heartbeatTimer);
    clearInterval(_membersTimer);
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
  }

  // ── Refresh member list ───────────────────────────────────────
  async function refreshMembers() {
    if (!_endpointUrl) return;
    try {
      const session = Storage.getSession();
      if (!session) return;
      const roomId = session.roomId;

      const members = await Members.fetchAndCache(_endpointUrl, roomId);
      if (_onMembersUpdate) _onMembersUpdate(members);
    } catch { /* silent fail */ }
  }

  return { start, stop, heartbeat, refreshMembers };
})();

window.Presence = Presence;

// ── Helper used by app.js ─────────────────────────────────────────
function loadMembers(room, session) {
  Members.fetchAndCache(room.deploymentUrl, room.id)
    .then(members => Chat.renderMembers(members))
    .catch(() => {});
}

window.loadMembers = loadMembers;
