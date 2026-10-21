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
      // The backend answers {success:false} with HTTP 200, so this branch is
      // reached without an exception — returning [] wiped the roster even
      // though a cached copy existed. Fall through to the cache instead.
      if (!res || !res.success) {
        throw new Error((res && res.error) || 'Could not load members');
      }

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

  return { fetchAndCache };
})();

window.Members = Members;
