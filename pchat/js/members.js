/**
 * SHEPU ROOMS — members.js
 * Member list fetching and caching.
 * The actual rendering is done by Chat.renderMembers().
 */

const Members = (() => {
  // ── Fetch and cache members ───────────────────────────────────
  async function fetchAndCache(endpointUrl, roomId) {
    try {
      const res = await RoomAPI.getMembers(endpointUrl);
      if (!res.success) return [];

      const members = res.members || [];

      // Cache in IDB
      try {
        await IDBStorage.putMembers(roomId, members.map(m => ({
          ...m,
          id: m.memberId, // IDB key
        })));
      } catch { /* non-critical */ }

      return members;
    } catch (err) {
      // Return cached
      try {
        const cached = await IDBStorage.getMembers(roomId);
        return cached.map(m => ({ ...m, memberId: m.memberId || m.id }));
      } catch {
        return [];
      }
    }
  }

  // ── Get online count ──────────────────────────────────────────
  function onlineCount(members) {
    return members.filter(m => {
      if (m.status === 'online') return true;
      if (m.lastSeen) return Date.now() - new Date(m.lastSeen).getTime() < 120000;
      return false;
    }).length;
  }

  return { fetchAndCache, onlineCount };
})();

window.Members = Members;
