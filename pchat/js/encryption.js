/**
 * SHEPU ROOMS — encryption.js
 * Phase 3 module — AES-GCM client-side encryption via Web Crypto API.
 * Provides PBKDF2 passphrase derivation, raw key import/export,
 * and authenticated AES-GCM encryption/decryption.
 */

const Encryption = (() => {
  let _key = null; // CryptoKey
  // _manual=true only when the owner explicitly sets a passphrase.
  // The automatic invite-link room key is read-only (decrypt old history)
  // and NEVER encrypts new messages — guests must never need a passphrase.
  let _manual = false;

  // ── Derive AES-GCM key from user passphrase ───────────────────
  async function deriveKeyFromPassword(password, saltString = "SHEPU_ROOMS_SALT") {
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(password),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    _key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: enc.encode(saltString),
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    _manual = true; // explicit passphrase → new messages are encrypted
    return _key;
  }

  // ── Encrypt plaintext → base64 ciphertext with prefix ─────────
  async function encrypt(plaintext) {
    if (!_key) return plaintext; // If not encrypted, return as is
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const enc = new TextEncoder();
      const ct = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        _key,
        enc.encode(plaintext)
      );
      const combined = new Uint8Array(iv.byteLength + ct.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(ct), iv.byteLength);
      return "enc:" + _arrayBufferToBase64(combined.buffer);
    } catch (e) {
      console.warn("Encryption failed:", e);
      return plaintext;
    }
  }

  // ── Decrypt base64 ciphertext → plaintext ─────────────────────
  async function decrypt(text) {
    if (!text || typeof text !== "string" || !text.startsWith("enc:")) {
      return text; // Not encrypted
    }
    if (!_key) {
      // No room key yet (e.g. key still deriving) — neutral text so guests
      // don't think a manual passphrase is required for invite-link joins.
      return "[Encrypted message — waiting for room key…]";
    }
    try {
      const base64 = text.substring(4);
      const combined = new Uint8Array(_base64ToArrayBuffer(base64));
      const iv = combined.slice(0, 12);
      const ct = combined.slice(12);
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        _key,
        ct
      );
      return new TextDecoder().decode(pt);
    } catch (e) {
      // Wrong key (e.g. owner set a manual passphrase guests don't have).
      return "[Couldn't decrypt — ask the owner for the latest invite link or passphrase]";
    }
  }

  function isActive() { return _key !== null; }
  // Auto-E2EE: ANY derived key (invite-link secret OR manual passphrase)
  // encrypts new messages. Guests never see a prompt — the key comes
  // silently from the invite link fragment (#k=). Manual mode is kept
  // only for UI status (extra passphrase layer on top).
  function shouldEncrypt() { return _key !== null; }
  function isManual() { return _manual === true; }
  function clearKey() { _key = null; _manual = false; }

  // ── Derive AES-GCM key from a room secret (Quick rooms) ───────
  // Every member who has the room secret (embedded in the invite link)
  // derives the SAME key, so messages are encrypted at rest
  // (localStorage + ntfy cloud) without any server-side key exchange.
  async function deriveKeyFromRoomSecret(roomSecret, roomId) {
    if (!roomSecret) throw new Error('Room secret is required');
    const enc = new TextEncoder();
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      enc.encode(roomSecret),
      { name: "PBKDF2" },
      false,
      ["deriveKey"]
    );
    // Mix the roomId into the salt so each room gets a distinct key
    const salt = enc.encode("shepu_room_" + (roomId || ''));
    _key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt,
        iterations: 100000,
        hash: "SHA-256",
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"]
    );
    _manual = false; // auto room key = silent E2EE, no prompt for guests
    return _key;
  }

  function _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    bytes.forEach(b => binary += String.fromCharCode(b));
    return btoa(binary);
  }

  function _base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
  }

  return {
    deriveKeyFromPassword,
    deriveKeyFromRoomSecret,
    encrypt,
    decrypt,
    isActive,
    shouldEncrypt,
    isManual,
    clearKey,
  };
})();

window.Encryption = Encryption;
