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
    // No key → refuse. Returning the plaintext here would silently downgrade
    // an "encrypted" room to plaintext; the caller must never be able to
    // ship an unencrypted message by accident.
    if (!_key) throw new Error('No encryption key — refusing to send plaintext.');
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
      // Never fall back to the plaintext here: a caller that cannot tell the
      // difference would ship an unencrypted message into an "encrypted" room.
      throw new Error('Encryption failed — the message was not encrypted.');
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
  // Encrypt new messages ONLY with an explicit manual passphrase.
  // The automatic invite-link key is decrypt-only (reads old enc: history)
  // so guests are never blocked and normal chat stays readable.
  function shouldEncrypt() { return _manual === true && _key !== null; }
  function isManual() { return _manual === true; }
  function clearKey() { _key = null; _manual = false; }

  // Export the active key (JWK) so a room-password key can survive reloads
  // via sessionStorage (tab-close clears it). Returns null when no key.
  async function exportKey() {
    if (!_key) return null;
    try { return await crypto.subtle.exportKey('jwk', _key); }
    catch { return null; }
  }

  // Import a previously exported JWK as the active key.
  // manual=true → new messages encrypt (room-password rooms).
  async function importKey(jwk, manual) {
    if (!jwk) throw new Error('No key to import');
    _key = await crypto.subtle.importKey(
      'jwk', jwk, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
    );
    _manual = manual === true;
    return _key;
  }

  // SHA-256 hex (for password verifiers / topic secrets — never the key).
  async function sha256Hex(text) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(String(text || '')));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

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
    exportKey,
    importKey,
    sha256Hex,
  };
})();

window.Encryption = Encryption;
