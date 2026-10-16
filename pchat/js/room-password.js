/**
 * SHEPU ROOMS — room-password.js
 * Optional per-room password ("link = address, password = key").
 *
 * - Owner enables it from inside the room; the invite link then carries NO
 *   key material, only `&pw=1`. A leaked link alone opens nothing.
 * - The password derives (PBKDF2, room-scoped salt) the AES-GCM message key,
 *   so every message is ciphertext on the Sheet / ntfy relay / P2P / disk.
 *   P2P join-proofs and relay topics also derive from the password, and the
 *   host REJECTS connections without a valid proof (no legacy fallback).
 * - The password itself is never stored or sent. Only the derived key (JWK)
 *   and a topic secret live in sessionStorage — reload survives, tab-close
 *   wipes. The server only ever sees a SHA-256 verifier hash.
 * - Forgetting the password = history unreadable (no backdoor). Enabling a
 *   password rotates the link secret and kills old sessions server-side.
 */

const RoomPassword = (() => {
  const K_KEY = (roomId) => `shepu_pwk_${roomId}`;
  const K_TPC = (roomId) => `shepu_pwt_${roomId}`;
  const K_BAD = (roomId) => `shepu_pwbad_${roomId}`; // set when host rejected us

  function isSupported() {
    try {
      return typeof window !== 'undefined' && !!window.crypto && !!crypto.subtle
        && typeof Encryption !== 'undefined';
    } catch { return false; }
  }

  function isLockedRoom(room) {
    try { return !!(room && room.passwordLocked === true); }
    catch { return false; }
  }

  function hasStored(roomId) {
    try {
      return !!(sessionStorage.getItem(K_KEY(roomId)) && sessionStorage.getItem(K_TPC(roomId)));
    } catch { return false; }
  }

  function markRejected(roomId, on) {
    try {
      if (on) sessionStorage.setItem(K_BAD(roomId), '1');
      else sessionStorage.removeItem(K_BAD(roomId));
    } catch {}
  }
  function wasRejected(roomId) {
    try { return sessionStorage.getItem(K_BAD(roomId)) === '1'; }
    catch { return false; }
  }

  function clearStored(roomId) {
    try {
      sessionStorage.removeItem(K_KEY(roomId));
      sessionStorage.removeItem(K_TPC(roomId));
      sessionStorage.removeItem(K_BAD(roomId));
    } catch {}
  }

  // Verifier hash sent to the server on join (Sheet rooms). The password
  // itself never leaves the device.
  async function hashForServer(roomId, password) {
    return Encryption.sha256Hex(`pw-join|${roomId}|${password}`);
  }

  // Derive key + topic secret from the password and store both (session).
  // Throws with a human message on failure.
  async function deriveAndStore(roomId, password) {
    if (!roomId) throw new Error('Missing room.');
    if (!password || String(password).length < 4) throw new Error('Password must be at least 4 characters.');
    if (!isSupported()) throw new Error('This browser cannot do encryption here (needs HTTPS or localhost).');
    const pw = String(password);
    await Encryption.deriveKeyFromPassword(pw, `shepu_pw_${roomId}`);
    const jwk = await Encryption.exportKey();
    if (!jwk) throw new Error('Could not prepare the key.');
    const topicSecret = await Encryption.sha256Hex(`pw-topic|${roomId}|${pw}`);
    try {
      sessionStorage.setItem(K_KEY(roomId), JSON.stringify(jwk));
      sessionStorage.setItem(K_TPC(roomId), topicSecret);
    } catch {
      throw new Error('Browser storage is blocked — password cannot be kept for this session.');
    }
    markRejected(roomId, false);
    return { topicSecret };
  }

  // Load a stored key into the live Encryption module. Returns topicSecret
  // or null when nothing usable is stored.
  async function loadStored(roomId) {
    let jwk = null, topicSecret = null;
    try {
      const raw = sessionStorage.getItem(K_KEY(roomId));
      topicSecret = sessionStorage.getItem(K_TPC(roomId)) || null;
      jwk = raw ? JSON.parse(raw) : null;
    } catch { return null; }
    if (!jwk || !topicSecret) return null;
    try {
      await Encryption.importKey(jwk, true); // manual → new messages encrypt
      return { topicSecret };
    } catch {
      clearStored(roomId);
      return null;
    }
  }

  function storedTopicSecret(roomId) {
    try { return sessionStorage.getItem(K_TPC(roomId)) || null; }
    catch { return null; }
  }

  return {
    isSupported, isLockedRoom, hasStored, clearStored,
    deriveAndStore, loadStored, storedTopicSecret, hashForServer,
    markRejected, wasRejected,
  };
})();

window.RoomPassword = RoomPassword;
