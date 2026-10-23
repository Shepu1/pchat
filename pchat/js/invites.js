/**
 * SHEPU ROOMS — invites.js
 *
 * Friend-to-friend room invites over Firestore, encrypted end-to-end.
 *
 * Privacy model:
 *  - The room link (including the #k= secret) is encrypted on the sender's
 *    device with ECDH P-256 + HKDF-SHA256 + AES-GCM.
 *  - Firestore only sees the sender uid, recipient path, roomId, a seen flag
 *    and an opaque ciphertext. It never sees the room link, room name or key.
 *  - The recipient's private key is a non-extractable CryptoKey in IndexedDB.
 *  - Invites are deleted by the recipient after Join/Dismiss; 7-day expiry.
 *  - Chat does not depend on this module. If Firebase is down, room links can
 *    still be copied and shared through the normal share modal.
 *
 * The module is intentionally separate from friends.js: friend requests are
 * useful on the home page, while invites are needed inside a room.
 */

const Invites = (() => {
  'use strict';

  const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_CIPHERTEXT = 3900;
  const KEY_DB = 'shepu_social_keys';
  const KEY_STORE = 'identity';
  const HKDF_INFO = 'shepu-invite-v1';
  const MAGIC = [0x53, 0x48, 0x49, 0x31]; // "SHI1"

  let fsMod = null;
  let db = null;
  let currentUid = null;
  let listenerUid = null;
  let listenerUnsub = null;
  let listenerStarting = false;
  let listenerGeneration = 0;
  let retryTimer = null;
  let socialStarted = false;
  let booted = false;

  let keyInfo = null;
  let keysReadyUid = null;
  let memoryKeyRecord = null;
  let lastError = null;

  let host = null;
  let picker = null;
  let pickerContext = null;
  let pickerFriends = [];
  let pickerBusy = false;
  let sendBusy = false;

  let currentBanner = null;
  const queue = [];
  const seenIds = new Set();
  const hiddenBadIds = new Set();

  // ── Error / utility helpers ────────────────────────────────────
  function makeError(code, message, cause) {
    const e = new Error(message || code);
    e.code = code;
    if (cause) e.cause = cause;
    return e;
  }

  function friendly(err) {
    if (!err) return 'Something went wrong.';
    const map = {
      'invites/no-crypto': 'This browser needs Web Crypto (HTTPS or localhost) for encrypted invites.',
      'invites/no-key': 'This invite was encrypted for another device. Ask your friend for the room link.',
      'invites/decrypt': 'This invite could not be decrypted on this device.',
      'invites/invalid-link': 'The room link in this invite was not valid.',
      'invites/not-ready': 'Friends are still connecting. Try again in a moment.',
      'invites/no-friends': 'Add a friend first, then invite them to the room.',
      'permission-denied': 'Firestore refused this invite. The friend may have removed you, or the latest rules are not deployed.',
      'resource-exhausted': 'Firebase free-tier quota reached. Copy the room link instead.',
      'unavailable': 'Friends are offline right now. Copy the room link instead.',
    };
    if (map[err.code]) return map[err.code];
    return err.message || String(err);
  }

  function toast(type, title, message, duration) {
    try {
      if (window.UI && typeof UI.toast === 'function') {
        UI.toast(type, title, message, duration);
      }
    } catch { /* non-fatal */ }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function toMillis(ts) {
    if (!ts) return 0;
    try {
      if (typeof ts.toMillis === 'function') return ts.toMillis();
      if (typeof ts.seconds === 'number') return ts.seconds * 1000;
      if (ts instanceof Date) return ts.getTime();
      if (typeof ts === 'number') return ts;
    } catch { /* ignore */ }
    return 0;
  }

  function bytesToB64(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function b64ToBytes(value) {
    const bin = atob(String(value || ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function utf8(value) {
    return new TextEncoder().encode(String(value));
  }

  function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  function subtleAvailable() {
    try { return typeof window !== 'undefined' && !!window.crypto && !!crypto.subtle; }
    catch { return false; }
  }

  // ── IndexedDB key storage ──────────────────────────────────────
  function openKeyDb() {
    return new Promise((resolve, reject) => {
      try {
        if (!window.indexedDB) { reject(new Error('IndexedDB is unavailable.')); return; }
        const req = indexedDB.open(KEY_DB, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(KEY_STORE)) d.createObjectStore(KEY_STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB open failed.'));
      } catch (err) { reject(err); }
    });
  }

  async function idbGet(key) {
    const idb = await openKeyDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = idb.transaction(KEY_STORE, 'readonly');
        const req = tx.objectStore(KEY_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error('IndexedDB read failed.'));
        tx.oncomplete = () => { try { idb.close(); } catch {} };
        tx.onerror = () => { try { idb.close(); } catch {}; reject(tx.error); };
      } catch (err) { try { idb.close(); } catch {}; reject(err); }
    });
  }

  async function idbSet(key, value) {
    const idb = await openKeyDb();
    return new Promise((resolve, reject) => {
      try {
        const tx = idb.transaction(KEY_STORE, 'readwrite');
        tx.objectStore(KEY_STORE).put(value, key);
        tx.oncomplete = () => { try { idb.close(); } catch {}; resolve(true); };
        tx.onerror = () => { try { idb.close(); } catch {}; reject(tx.error || new Error('IndexedDB write failed.')); };
      } catch (err) { try { idb.close(); } catch {}; reject(err); }
    });
  }

  // ── Key setup ──────────────────────────────────────────────────
  // Generate an extractable pair, export the public key, then re-import the
  // private key as non-extractable. The extractable copy is discarded at the
  // end of this function, so later XSS cannot export the stored private key.
  async function generateIdentity() {
    if (!subtleAvailable()) throw makeError('invites/no-crypto', 'Web Crypto is unavailable.');
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveKey', 'deriveBits']
    );
    const publicKeySpki = bytesToB64(await crypto.subtle.exportKey('spki', pair.publicKey));
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveKey', 'deriveBits']
    );
    return {
      deviceId: bytesToB64(randomBytes(12)),
      publicKeySpki,
      privateKey,
      createdAt: Date.now(),
    };
  }

  async function ensureFirebase() {
    if (fsMod && db) return;
    if (typeof Firebase === 'undefined') throw makeError('invites/not-ready', 'Firebase is not loaded.');
    const sdk = await Firebase.sdk();
    fsMod = sdk.fsMod;
    db = sdk.db;
  }

  async function ensureKeys() {
    const state = (typeof Friends !== 'undefined') ? Friends.getState() : null;
    const uid = (state && state.uid) || currentUid || (typeof Firebase !== 'undefined' ? Firebase.getUid() : null);
    if (!uid) throw makeError('invites/not-ready', 'Sign in first.');
    if (keyInfo && keysReadyUid === uid) return keyInfo;

    if (!subtleAvailable()) {
      keyInfo = { supported: false, hasKey: false, reason: 'no-crypto' };
      keysReadyUid = uid;
      return keyInfo;
    }

    const profilePub = (state && state.profile && state.profile.pubKey) || '';
    let record = memoryKeyRecord;

    if (!record) {
      try { record = await idbGet('identity_' + uid); } catch { record = null; }
    }

    if (!record && profilePub) {
      // Another device already published a key. Do not overwrite it: doing so
      // would silently lock that device out of every invite ever sent to it.
      keyInfo = {
        supported: true,
        hasKey: false,
        reason: 'other-device',
        profilePubKey: profilePub,
      };
      keysReadyUid = uid;
      return keyInfo;
    }

    if (!record) {
      try {
        record = await generateIdentity();
        memoryKeyRecord = record;
        try { await idbSet('identity_' + uid, record); } catch { /* memory-only this session */ }
      } catch (err) {
        keyInfo = { supported: false, hasKey: false, reason: 'keygen', error: friendly(err) };
        keysReadyUid = uid;
        return keyInfo;
      }
    }

    let published = profilePub;
    if (!published && record.publicKeySpki) {
      try {
        await fsMod.updateDoc(fsMod.doc(db, 'users', uid), { pubKey: record.publicKeySpki });
        published = record.publicKeySpki;
        if (state && state.profile) state.profile.pubKey = record.publicKeySpki;
      } catch (err) {
        lastError = friendly(err);
        console.warn('[Invites] could not publish invite public key:', err);
      }
    }

    keyInfo = {
      supported: true,
      hasKey: true,
      publicKeySpki: record.publicKeySpki,
      profilePubKey: published || '',
      mismatch: !!(published && published !== record.publicKeySpki),
      privateKey: record.privateKey,
    };
    keysReadyUid = uid;
    return keyInfo;
  }

  // ── Encryption ─────────────────────────────────────────────────
  async function importFriendKey(publicKeySpki) {
    if (!publicKeySpki || typeof publicKeySpki !== 'string') {
      throw makeError('invites/no-key', 'This friend has not enabled encrypted invites yet.');
    }
    try {
      return await crypto.subtle.importKey(
        'spki',
        b64ToBytes(publicKeySpki),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );
    } catch (err) {
      throw makeError('invites/no-key', 'This friend has an invalid invite key.', err);
    }
  }

  async function deriveAesKey(privateKey, publicKey, salt) {
    const shared = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: publicKey },
      privateKey,
      256
    );
    const hkdf = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt,
        info: utf8(HKDF_INFO),
      },
      hkdf,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptPayload(friendPub, payload, fromUid, toUid, inviteId) {
    if (!subtleAvailable()) throw makeError('invites/no-crypto', 'Web Crypto is unavailable.');
    const friendKey = await importFriendKey(friendPub);
    const ephemeral = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const aesKey = await deriveAesKey(ephemeral.privateKey, friendKey, salt);
    const aad = utf8(`${fromUid}:${toUid}:${inviteId}`);
    const plaintext = utf8(JSON.stringify(payload));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      aesKey,
      plaintext
    );
    const ephemeralSpki = new Uint8Array(await crypto.subtle.exportKey('spki', ephemeral.publicKey));
    if (ephemeralSpki.length > 255) throw makeError('invites/no-crypto', 'Unexpected key length.');

    const out = new Uint8Array(4 + 12 + 16 + 1 + ephemeralSpki.length + ciphertext.byteLength);
    out.set(MAGIC, 0);
    out.set(iv, 4);
    out.set(salt, 16);
    out[32] = ephemeralSpki.length;
    out.set(ephemeralSpki, 33);
    out.set(new Uint8Array(ciphertext), 33 + ephemeralSpki.length);

    const encoded = bytesToB64(out);
    if (encoded.length >= MAX_CIPHERTEXT) {
      throw makeError('invites/invalid-link', 'This room link is too long to encrypt.');
    }
    return encoded;
  }

  async function decryptPayload(encoded, fromUid, toUid, inviteId, privateKey) {
    if (!subtleAvailable()) throw makeError('invites/no-crypto', 'Web Crypto is unavailable.');
    if (!privateKey) throw makeError('invites/no-key', 'This device has no invite key.');
    let bytes;
    try { bytes = b64ToBytes(encoded); } catch (err) {
      throw makeError('invites/decrypt', 'The invite payload is malformed.', err);
    }
    if (bytes.length < 4 + 12 + 16 + 1 + 1) {
      throw makeError('invites/decrypt', 'The invite payload is too short.');
    }
    for (let i = 0; i < 4; i++) {
      if (bytes[i] !== MAGIC[i]) throw makeError('invites/decrypt', 'Unknown invite version.');
    }
    const iv = bytes.slice(4, 16);
    const salt = bytes.slice(16, 32);
    const ephemeralLen = bytes[32];
    if (bytes.length < 33 + ephemeralLen + 1) {
      throw makeError('invites/decrypt', 'The invite payload is incomplete.');
    }
    const ephemeralSpki = bytes.slice(33, 33 + ephemeralLen);
    const ciphertext = bytes.slice(33 + ephemeralLen);

    let ephemeralKey;
    try {
      ephemeralKey = await crypto.subtle.importKey(
        'spki',
        ephemeralSpki,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );
    } catch (err) {
      throw makeError('invites/decrypt', 'The invite sender key is invalid.', err);
    }

    let aesKey;
    try {
      aesKey = await deriveAesKey(privateKey, ephemeralKey, salt);
    } catch (err) {
      throw makeError('invites/decrypt', 'Could not derive the invite key.', err);
    }

    let plaintext;
    try {
      plaintext = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: utf8(`${fromUid}:${toUid}:${inviteId}`),
        },
        aesKey,
        ciphertext
      );
    } catch (err) {
      throw makeError('invites/decrypt', 'The invite could not be decrypted on this device.', err);
    }

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(plaintext));
    } catch (err) {
      throw makeError('invites/decrypt', 'The invite contents are malformed.', err);
    }
    if (!payload || payload.v !== 1
      || typeof payload.link !== 'string'
      || typeof payload.roomId !== 'string') {
      throw makeError('invites/decrypt', 'The invite contents are invalid.');
    }
    return payload;
  }

  // ── Listener ───────────────────────────────────────────────────
  function onFriendsState(state) {
    if (!state) return;
    if (state.status === 'ready' && state.uid) {
      currentUid = state.uid;
      startListener().catch((err) => {
        lastError = friendly(err);
        console.warn('[Invites] listener start failed:', err);
      });
    } else {
      stopListener();
    }
  }

  async function startListener() {
    const state = (typeof Friends !== 'undefined') ? Friends.getState() : null;
    if (!state || state.status !== 'ready' || !state.uid) return;
    const uid = state.uid;
    if (listenerUid === uid && listenerUnsub) return;
    if (listenerStarting) return;

    listenerStarting = true;
    const gen = ++listenerGeneration;
    currentUid = uid;
    try {
      await ensureFirebase();
      if (gen !== listenerGeneration) return;
      await ensureKeys();
      if (gen !== listenerGeneration) return;

      const invitesRef = fsMod.collection(db, 'users', uid, 'invites');
      const invitesQuery = fsMod.query(invitesRef, fsMod.where('seen', '==', false));
      const unsub = fsMod.onSnapshot(
        invitesQuery,
        (snap) => {
          if (gen !== listenerGeneration) return;
          handleSnapshot(snap);
        },
        (err) => {
          if (gen !== listenerGeneration) return;
          lastError = friendly(err);
          console.warn('[Invites] listener failed:', err);
        }
      );
      listenerUnsub = unsub;
      listenerUid = uid;
    } catch (err) {
      lastError = friendly(err);
      console.warn('[Invites] listener start failed:', err);
      if (gen === listenerGeneration) {
        clearRetry();
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (typeof Friends !== 'undefined' && Friends.getState().status === 'ready') {
            startListener().catch(() => {});
          }
        }, 120000);
      }
    } finally {
      listenerStarting = false;
    }
  }

  function stopListener() {
    listenerGeneration++;
    clearRetry();
    if (listenerUnsub) {
      try { listenerUnsub(); } catch { /* ignore */ }
      listenerUnsub = null;
    }
    listenerUid = null;
    listenerStarting = false;
    queue.length = 0;
    seenIds.clear();
    hiddenBadIds.clear();
    removeBanner();
  }

  function clearRetry() {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function handleSnapshot(snap) {
    try {
      snap.docChanges().forEach((change) => {
        const id = change.doc.id;
        if (change.type === 'removed') {
          handleRemoved(id);
        } else if (change.type === 'added') {
          handleInviteDoc(change.doc).catch((err) => {
            console.warn('[Invites] invite handling failed:', err);
          });
        }
      });
    } catch (err) {
      console.warn('[Invites] snapshot handling failed:', err);
    }
  }

  async function handleInviteDoc(docSnap) {
    const id = docSnap.id;
    if (seenIds.has(id) || hiddenBadIds.has(id)) return;
    const data = docSnap.data() || {};
    if (typeof data.from !== 'string' || !data.from
      || typeof data.ciphertext !== 'string' || !data.ciphertext) {
      return;
    }
    if (data.seen !== false) return;

    const created = toMillis(data.createdAt);
    if (created && Date.now() - created > INVITE_TTL_MS) {
      seenIds.add(id);
      deleteInvite(id).catch(() => {});
      return;
    }

    seenIds.add(id);
    let payload = null;
    let error = null;
    try {
      payload = await decryptDoc(id, data);
    } catch (err) {
      error = err;
    }

    if (!payload) {
      enqueue({
        docId: id,
        data,
        payload: null,
        error,
        fromName: senderName(data.from),
      });
      return;
    }

    const safeLink = safeRoomLink(payload.link, payload.roomId);
    if (!safeLink || payload.roomId !== data.roomId) {
      toast('error', 'Invite ignored', 'The room link in this invite was not valid.');
      deleteInvite(id).catch(() => {});
      return;
    }

    enqueue({
      docId: id,
      data,
      payload,
      link: safeLink,
      fromName: senderName(data.from) || payload.fromName || 'A friend',
    });
  }

  async function decryptDoc(docId, data) {
    if (!keyInfo || !keyInfo.supported) {
      throw makeError('invites/no-crypto', 'Web Crypto is unavailable on this device.');
    }
    if (!keyInfo.hasKey || !keyInfo.privateKey) {
      throw makeError('invites/no-key', 'This invite was sent to another device.');
    }
    const payload = await decryptPayload(
      data.ciphertext,
      data.from,
      currentUid,
      docId,
      keyInfo.privateKey
    );
    return payload;
  }

  function senderName(uid) {
    try {
      const state = Friends.getState();
      const row = (state.friends || []).find((f) => f.uid === uid);
      return (row && row.name) || 'A friend';
    } catch {
      return 'A friend';
    }
  }

  async function deleteInvite(docId) {
    if (!fsMod || !db || !currentUid) return;
    await fsMod.deleteDoc(fsMod.doc(db, 'users', currentUid, 'invites', docId));
  }

  // Only same-origin room.html/join.html links are allowed. A compromised
  // account must not be able to turn an invite banner into an open redirect.
  function safeRoomLink(raw, expectedRoomId) {
    try {
      const url = new URL(String(raw || ''), location.origin);
      if (url.origin !== location.origin) return null;
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      const file = url.pathname.split('/').pop();
      if (file !== 'room.html' && file !== 'join.html') return null;
      const roomId = url.searchParams.get('r');
      if (!roomId) return null;
      if (expectedRoomId && roomId !== expectedRoomId) return null;
      return url.href;
    } catch {
      return null;
    }
  }

  // ── Incoming banner ────────────────────────────────────────────
  function ensureHost() {
    if (host && document.body.contains(host)) return host;
    host = document.getElementById('shepu-invite-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'shepu-invite-host';
      host.className = 'shepu-invite-host';
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }

  function enqueue(item) {
    if (!item || !item.docId) return;
    if (currentBanner && currentBanner.docId === item.docId) return;
    if (queue.some((x) => x.docId === item.docId)) return;
    queue.push(item);
    showNext();
  }

  function showNext() {
    if (currentBanner || !queue.length) return;
    const item = queue.shift();
    if (!item) return;
    currentBanner = item;
    ensureHost();

    const card = document.createElement('div');
    card.className = 'shepu-invite-card';
    card.setAttribute('role', 'status');

    const icon = document.createElement('div');
    icon.className = 'shepu-invite-icon';
    icon.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" ry="2"></rect><polyline points="3 7 12 13 21 7"></polyline></svg>';

    const body = document.createElement('div');
    body.className = 'shepu-invite-body';

    const title = document.createElement('div');
    title.className = 'shepu-invite-title';
    title.textContent = item.payload ? 'Room invite' : 'Invite unavailable';

    const text = document.createElement('div');
    text.className = 'shepu-invite-text';
    if (item.payload) {
      const room = String((item.payload && item.payload.roomName) || 'a room').slice(0, 80);
      text.textContent = `${item.fromName} invited you to “${room}”.`;
    } else {
      text.textContent = `${item.fromName} sent a room invite, but this device can't open it. Open it on the device where you enabled invites, or ask them for the link.`;
    }

    const actions = document.createElement('div');
    actions.className = 'shepu-invite-actions';

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'shepu-invite-close';
    close.setAttribute('aria-label', 'Dismiss invite');
    close.textContent = '×';
    close.addEventListener('click', () => {
      finishBanner(item, item.payload ? 'dismiss' : 'hide');
    });

    if (item.payload) {
      const join = document.createElement('button');
      join.type = 'button';
      join.className = 'btn btn-primary';
      join.textContent = 'Join room';
      join.addEventListener('click', () => finishBanner(item, 'join'));

      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'btn btn-ghost';
      dismiss.textContent = 'Dismiss';
      dismiss.addEventListener('click', () => finishBanner(item, 'dismiss'));

      actions.appendChild(join);
      actions.appendChild(dismiss);
    } else {
      const hide = document.createElement('button');
      hide.type = 'button';
      hide.className = 'btn btn-ghost';
      hide.textContent = 'Hide';
      hide.addEventListener('click', () => finishBanner(item, 'hide'));
      actions.appendChild(hide);
    }

    body.appendChild(title);
    body.appendChild(text);
    body.appendChild(actions);
    card.appendChild(icon);
    card.appendChild(body);
    card.appendChild(close);
    ensureHost().appendChild(card);
    item.el = card;
  }

  async function finishBanner(item, mode) {
    if (!item || currentBanner !== item) return;
    if (item.el) {
      try { item.el.remove(); } catch { /* ignore */ }
    }
    currentBanner = null;

    if (mode === 'join') {
      if (item.link) {
        try { await deleteInvite(item.docId); } catch { /* still join */ }
        try { location.href = item.link; } catch { /* ignore */ }
        return;
      }
      toast('error', 'Invite unavailable', 'No usable room link was found.');
    } else if (mode === 'dismiss') {
      try { await deleteInvite(item.docId); } catch { /* ignore */ }
    } else {
      // Do not delete an invite this device cannot decrypt: another device
      // may still be able to open it. Hide it only for this page session.
      hiddenBadIds.add(item.docId);
    }

    setTimeout(showNext, 160);
  }

  function handleRemoved(docId) {
    seenIds.delete(docId);
    const index = queue.findIndex((x) => x.docId === docId);
    if (index >= 0) queue.splice(index, 1);
    if (currentBanner && currentBanner.docId === docId) {
      if (currentBanner.el) {
        try { currentBanner.el.remove(); } catch { /* ignore */ }
      }
      currentBanner = null;
      setTimeout(showNext, 160);
    } else {
      showNext();
    }
  }

  function removeBanner() {
    if (currentBanner && currentBanner.el) {
      try { currentBanner.el.remove(); } catch { /* ignore */ }
    }
    currentBanner = null;
  }

  // ── Picker ─────────────────────────────────────────────────────
  function ensurePicker() {
    if (picker && document.body.contains(picker)) return picker;
    picker = document.createElement('div');
    picker.id = 'invite-picker-overlay';
    picker.className = 'invite-overlay';
    picker.hidden = true;
    picker.innerHTML = `
      <div class="invite-card" role="dialog" aria-modal="true" aria-labelledby="invite-picker-title">
        <div class="invite-head">
          <div class="invite-head-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
          </div>
          <div class="invite-head-copy">
            <h3 class="invite-title" id="invite-picker-title">Invite friends</h3>
            <p class="invite-subtitle" id="invite-picker-subtitle">End-to-end encrypted, delivered inside Pchat.</p>
          </div>
          <button type="button" class="invite-close" id="invite-picker-close" aria-label="Close invites">×</button>
        </div>
        <div class="invite-toolbar">
          <button type="button" class="invite-link-btn" id="invite-select-all">Select all</button>
          <span id="invite-selected-count">0 selected</span>
        </div>
        <div class="invite-note hidden" id="invite-picker-note"></div>
        <div class="invite-list" id="invite-picker-list"></div>
        <div class="invite-status" id="invite-picker-status"></div>
        <div class="invite-foot">
          <button type="button" class="btn btn-ghost" id="invite-copy-link">Copy link</button>
          <button type="button" class="btn btn-primary" id="invite-send" disabled>Send invite</button>
        </div>
      </div>`;
    document.body.appendChild(picker);

    const close = picker.querySelector('#invite-picker-close');
    const selectAll = picker.querySelector('#invite-select-all');
    const send = picker.querySelector('#invite-send');
    const copy = picker.querySelector('#invite-copy-link');
    const list = picker.querySelector('#invite-picker-list');

    if (close) close.addEventListener('click', closePicker);
    if (picker) {
      picker.addEventListener('click', (e) => { if (e.target === picker) closePicker(); });
    }
    if (selectAll) selectAll.addEventListener('click', toggleSelectAll);
    if (send) send.addEventListener('click', sendSelected);
    if (copy) copy.addEventListener('click', copyRoomLink);
    if (list) {
      list.addEventListener('change', (e) => {
        if (e.target && e.target.matches('input[type="checkbox"]')) updatePickerSelection();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && picker && !picker.hidden) {
        e.stopPropagation();
        closePicker();
      }
    });
    return picker;
  }

  function setPickerSubtitle(text) {
    const el = picker && picker.querySelector('#invite-picker-subtitle');
    if (el) el.textContent = text || '';
  }

  function setPickerStatus(text, type) {
    const el = picker && picker.querySelector('#invite-picker-status');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'invite-status' + (type ? ' is-' + type : '');
  }

  function setPickerNote(text) {
    const el = picker && picker.querySelector('#invite-picker-note');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
  }

  function showPickerLoading() {
    const list = picker && picker.querySelector('#invite-picker-list');
    if (!list) return;
    list.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'invite-empty';
    empty.innerHTML = '<span class="invite-spinner" aria-hidden="true"></span>Loading your friends…';
    list.appendChild(empty);
    const send = picker.querySelector('#invite-send');
    if (send) send.disabled = true;
    const count = picker.querySelector('#invite-selected-count');
    if (count) count.textContent = '0 selected';
  }

  function showPickerError(message) {
    const list = picker && picker.querySelector('#invite-picker-list');
    if (!list) return;
    list.textContent = '';
    const box = document.createElement('div');
    box.className = 'invite-empty';
    const strong = document.createElement('strong');
    strong.textContent = 'Friends unavailable';
    const p = document.createElement('div');
    p.textContent = message || 'Could not load your friends.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn btn-secondary';
    retry.style.marginTop = '0.7rem';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => {
      showPickerLoading();
      loadPickerFriends().catch((err) => showPickerError(friendly(err)));
    });
    box.appendChild(strong);
    box.appendChild(p);
    box.appendChild(retry);
    list.appendChild(box);
    const send = picker.querySelector('#invite-send');
    if (send) send.disabled = true;
  }

  async function openPicker(options) {
    ensurePicker();
    const ctx = options || (typeof window.getRoomInviteContext === 'function'
      ? window.getRoomInviteContext()
      : null);
    if (!ctx || !ctx.roomId || !ctx.link) {
      toast('error', 'Room not ready', 'Wait for the room to load, then try again.');
      return;
    }

    pickerContext = { ...ctx };
    pickerBusy = false;
    sendBusy = false;
    setPickerSubtitle(`Invite friends to “${String(ctx.roomName || 'this room').slice(0, 80)}”.`);
    setPickerStatus('');
    setPickerNote(ctx.passwordLocked
      ? 'This room is password-locked. Send the password separately — it is never included in the invite.'
      : '');
    picker.hidden = false;
    document.body.classList.add('invite-picker-open');
    showPickerLoading();
    const close = picker.querySelector('#invite-picker-close');
    if (close) setTimeout(() => { try { close.focus({ preventScroll: true }); } catch {} }, 50);

    try {
      await loadPickerFriends();
    } catch (err) {
      showPickerError(friendly(err));
    }
  }

  async function loadPickerFriends() {
    let state = Friends.getState();
    if (state.status !== 'ready') {
      state = await Friends.init();
    }
    if (state.status === 'gate') {
      closePicker();
      await showGate(state);
      return;
    }
    if (state.status === 'error') {
      showPickerError((state.error && state.error.message) || 'Friends are not available.');
      return;
    }

    setPickerStatus('Loading your friends…');
    try {
      await Friends.refresh({ force: true });
    } catch { /* keep cached rows */ }
    state = Friends.getState();
    if (state.status !== 'ready') {
      showPickerError((state.error && state.error.message) || 'Friends are not available.');
      return;
    }

    try {
      await ensureFirebase();
      await ensureKeys();
    } catch (err) {
      lastError = friendly(err);
    }

    const noteParts = [];
    if (ctxPasswordLocked()) {
      noteParts.push('Password-locked room: send the password separately.');
    }
    if (keyInfo && keyInfo.supported && !keyInfo.hasKey && keyInfo.profilePubKey) {
      noteParts.push('This device can receive only copy-link invites sent to your other device.');
    } else if (keyInfo && keyInfo.supported && keyInfo.mismatch) {
      noteParts.push('This device has an old invite key. Ask friends for a copy link.');
    } else if (keyInfo && !keyInfo.supported) {
      noteParts.push('Encrypted invites are unavailable in this browser. Use Copy link instead.');
    }
    setPickerNote(noteParts.join(' '));

    if (state.friendsError) {
      setPickerStatus(state.friendsError, 'error');
    } else {
      setPickerStatus('');
    }
    renderPickerList(state);
  }

  function ctxPasswordLocked() {
    return !!(pickerContext && pickerContext.passwordLocked);
  }

  function avatarColor(seed) {
    const colors = [
      'linear-gradient(135deg,#2563eb,#1d4ed8)',
      'linear-gradient(135deg,#7c3aed,#6d28d9)',
      'linear-gradient(135deg,#0891b2,#0e7490)',
      'linear-gradient(135deg,#059669,#047857)',
      'linear-gradient(135deg,#d97706,#b45309)',
      'linear-gradient(135deg,#db2777,#be185d)',
    ];
    const s = String(seed || '');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return colors[h % colors.length];
  }

  function initials(name, handle) {
    const clean = String(name || '').trim();
    if (clean) return clean.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    return (String(handle || '').replace(/^@/, '').slice(0, 2) || '?').toUpperCase();
  }

  function renderPickerList(state) {
    const list = picker && picker.querySelector('#invite-picker-list');
    if (!list) return;
    pickerFriends = (state.friends || []).slice();
    list.textContent = '';

    if (!pickerFriends.length) {
      const empty = document.createElement('div');
      empty.className = 'invite-empty';
      const strong = document.createElement('strong');
      strong.textContent = 'No friends yet';
      const p = document.createElement('div');
      p.textContent = 'Add a friend on the home page first. Then come back here to invite them.';
      empty.appendChild(strong);
      empty.appendChild(p);
      list.appendChild(empty);
      updatePickerSelection();
      return;
    }

    pickerFriends.forEach((friend) => {
      const ready = typeof friend.pubKey === 'string' && friend.pubKey.length > 20;
      const row = document.createElement('label');
      row.className = 'invite-friend-row' + (!ready ? ' is-disabled' : '');
      row.dataset.uid = friend.uid;

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = friend.uid;
      cb.disabled = !ready;
      cb.setAttribute('aria-label', `Invite ${friend.name || friend.handle || 'friend'}`);
      row.appendChild(cb);

      const avatar = document.createElement('div');
      avatar.className = 'invite-avatar';
      avatar.style.background = avatarColor(friend.uid);
      avatar.textContent = initials(friend.name, friend.handle);
      row.appendChild(avatar);

      const info = document.createElement('div');
      info.className = 'invite-friend-info';
      const name = document.createElement('div');
      name.className = 'invite-friend-name';
      name.textContent = friend.name || 'Pchat user';
      const sub = document.createElement('div');
      sub.className = 'invite-friend-sub' + (ready ? ' is-ready' : '');
      sub.textContent = friend.handle ? `@${friend.handle}` : (friend.missing ? 'Profile unavailable' : 'No handle');
      if (ready) sub.textContent += ' · Ready for encrypted invites';
      else if (!friend.missing) sub.textContent += ' · Hasn’t enabled invites yet';
      info.appendChild(name);
      info.appendChild(sub);
      row.appendChild(info);
      list.appendChild(row);
    });

    updatePickerSelection();
  }

  function updatePickerSelection() {
    if (!picker) return;
    const list = picker.querySelector('#invite-picker-list');
    const send = picker.querySelector('#invite-send');
    const count = picker.querySelector('#invite-selected-count');
    const selectAll = picker.querySelector('#invite-select-all');
    if (!list) return;
    const boxes = [...list.querySelectorAll('input[type="checkbox"]')];
    const enabled = boxes.filter((b) => !b.disabled);
    const checked = boxes.filter((b) => b.checked && !b.disabled);
    if (count) count.textContent = `${checked.length} selected`;
    if (send) {
      send.disabled = pickerBusy || checked.length === 0;
      send.textContent = pickerBusy ? 'Sending…' : 'Send invite';
    }
    if (selectAll) {
      selectAll.disabled = enabled.length === 0 || pickerBusy;
      selectAll.textContent = enabled.length > 0 && checked.length === enabled.length
        ? 'Clear all'
        : 'Select all';
    }
  }

  function toggleSelectAll() {
    if (!picker || pickerBusy) return;
    const boxes = [...picker.querySelectorAll('#invite-picker-list input[type="checkbox"]')]
      .filter((b) => !b.disabled);
    if (!boxes.length) return;
    const allChecked = boxes.every((b) => b.checked);
    boxes.forEach((b) => { b.checked = !allChecked; });
    updatePickerSelection();
  }

  async function sendSelected() {
    if (!picker || pickerBusy || sendBusy) return;
    const boxes = [...picker.querySelectorAll('#invite-picker-list input[type="checkbox"]')]
      .filter((b) => b.checked && !b.disabled);
    if (!boxes.length) return;
    if (!pickerContext || !pickerContext.link) {
      setPickerStatus('The room link is not ready yet.', 'error');
      return;
    }

    if (!fsMod || !db || !currentUid) {
      setPickerStatus('Friends are still connecting. Try again in a moment.', 'error');
      return;
    }

    const selected = boxes.map((b) => b.value);
    const targets = pickerFriends.filter((f) => selected.includes(f.uid));
    if (!targets.length) return;

    pickerBusy = true;
    sendBusy = true;
    setPickerStatus(`Encrypting and sending 0 of ${targets.length}…`);
    updatePickerSelection();

    let sent = 0;
    const failures = [];
    for (let i = 0; i < targets.length; i++) {
      const friend = targets[i];
      setPickerStatus(`Encrypting and sending ${i + 1} of ${targets.length}…`);
      try {
        await sendOne(friend);
        sent++;
        markSent(friend.uid);
      } catch (err) {
        failures.push({ friend, err });
        console.warn('[Invites] send failed:', err);
      }
    }

    pickerBusy = false;
    sendBusy = false;
    updatePickerSelection();

    if (!failures.length) {
      setPickerStatus('');
      toast('success', 'Invite sent', `Sent to ${sent} friend${sent === 1 ? '' : 's'}.`);
      closePicker();
      return;
    }

    const names = failures.map((x) => x.friend.name || x.friend.handle || 'friend').join(', ');
    setPickerStatus(`Sent to ${sent}. Failed: ${names}. You can retry the failed ones.`, 'error');
    toast('error', 'Some invites failed', `Sent ${sent}; ${failures.length} failed.`, 6000);
  }

  async function sendOne(friend) {
    if (!friend || !friend.uid) throw makeError('invites/no-friends', 'No friend selected.');
    if (!currentUid) throw makeError('invites/not-ready', 'Sign in first.');
    if (!friend.pubKey) throw makeError('invites/no-key', 'This friend has not enabled encrypted invites yet.');
    if (!pickerContext || !pickerContext.roomId || !pickerContext.link) {
      throw makeError('invites/invalid-link', 'The room link is not ready.');
    }

    const inviteId = currentUid + '_' + pickerContext.roomId;
    const payload = {
      v: 1,
      roomId: String(pickerContext.roomId),
      roomName: String(pickerContext.roomName || 'Private room').slice(0, 80),
      link: String(pickerContext.link),
      fromName: ((Friends.getState().profile && Friends.getState().profile.name) || 'A friend').slice(0, 80),
      createdAt: Date.now(),
    };
    const ciphertext = await encryptPayload(
      friend.pubKey,
      payload,
      currentUid,
      friend.uid,
      inviteId
    );
    const ref = fsMod.doc(db, 'users', friend.uid, 'invites', inviteId);
    try {
      await fsMod.setDoc(ref, {
        from: currentUid,
        roomId: String(pickerContext.roomId),
        ciphertext,
        seen: false,
        createdAt: fsMod.serverTimestamp(),
      });
    } catch (err) {
      if (err && err.code === 'permission-denied') {
        throw makeError('permission-denied', 'The invite was refused. The friend may have removed you, or the latest rules are not deployed.', err);
      }
      throw err;
    }
  }

  function markSent(uid) {
    if (!picker) return;
    const row = picker.querySelector(`.invite-friend-row[data-uid="${cssEscape(uid)}"]`);
    if (!row) return;
    row.classList.add('is-disabled');
    const cb = row.querySelector('input[type="checkbox"]');
    if (cb) { cb.checked = false; cb.disabled = true; }
    const sub = row.querySelector('.invite-friend-sub');
    if (sub) {
      sub.textContent = 'Invite sent · waiting for them to open it';
      sub.classList.add('is-ready');
    }
  }

  function cssEscape(value) {
    try { if (window.CSS && CSS.escape) return CSS.escape(String(value)); } catch { /* ignore */ }
    return String(value).replace(/["\\]/g, '\\$&');
  }

  async function copyRoomLink() {
    if (!pickerContext || !pickerContext.link) {
      toast('error', 'Room not ready', 'The room link is not ready yet.');
      return;
    }
    let ok = false;
    try {
      ok = window.UI && typeof UI.copyText === 'function'
        ? await UI.copyText(pickerContext.link)
        : false;
    } catch { ok = false; }
    if (ok) {
      toast('success', 'Link copied', ctxPasswordLocked()
        ? 'Send the room password separately.'
        : 'Share this link with anyone you trust.');
    } else {
      toast('error', 'Copy failed', 'Your browser blocked clipboard access.');
    }
  }

  async function showGate(state) {
    const kind = state && state.gate && state.gate.kind;
    const title = kind === 'google' ? 'Google sign-in needed' : (kind === 'reconnect' ? 'Reconnect Google' : 'Sign in to invite friends');
    const message = kind === 'google'
      ? 'You are signed in with email or demo mode. Invites need a real Google account; chat is not affected.'
      : (kind === 'reconnect'
        ? 'Your Google session expired. Sign in again to see friends and encrypted invites. Chat is not affected.'
        : 'Friends and encrypted invites work across devices with a Google sign-in. Chat and rooms keep working without it.');
    let ok = false;
    try {
      if (window.UI && typeof UI.confirmDialog === 'function') {
        ok = await UI.confirmDialog({
          title,
          message,
          confirmText: 'Sign in',
          cancelText: 'Not now',
        });
      }
    } catch { ok = false; }
    if (ok) {
      const redirect = location.pathname + location.search;
      location.href = 'login.html?redirect=' + encodeURIComponent(redirect);
    }
  }

  function closePicker() {
    if (!picker || picker.hidden) return;
    if (pickerBusy) return;
    picker.hidden = true;
    document.body.classList.remove('invite-picker-open');
    pickerContext = null;
    pickerFriends = [];
    pickerBusy = false;
    sendBusy = false;
  }

  // ── Public surface ─────────────────────────────────────────────
  function init() {
    if (socialStarted) return;
    socialStarted = true;
    if (typeof Friends === 'undefined' || typeof Firebase === 'undefined') {
      socialStarted = false;
      return;
    }
    Friends.subscribe(onFriendsState);
    Friends.init().catch((err) => {
      lastError = friendly(err);
      console.warn('[Invites] Friends init failed:', err);
    });
  }

  function reset() {
    stopListener();
    if (picker && !picker.hidden) {
      picker.hidden = true;
      document.body.classList.remove('invite-picker-open');
    }
    pickerContext = null;
    pickerFriends = [];
    pickerBusy = false;
    sendBusy = false;
    currentUid = null;
    keysReadyUid = null;
    keyInfo = null;
    lastError = null;
    // fsMod/db are left intact: the Firebase SDK instance is shared with
    // Friends, and a later sign-in can reuse it.
  }

  function debug() {
    return {
      uid: currentUid,
      listenerAttached: !!listenerUnsub,
      listenerUid,
      key: keyInfo ? {
        supported: keyInfo.supported,
        hasKey: keyInfo.hasKey,
        reason: keyInfo.reason || '',
        mismatch: !!keyInfo.mismatch,
        profilePubKey: !!keyInfo.profilePubKey,
      } : null,
      queue: queue.length,
      showing: currentBanner ? currentBanner.docId : null,
      error: lastError,
    };
  }

  function boot() {
    if (booted) return;
    booted = true;
    ensureHost();
    ensurePicker();
    const button = document.getElementById('room-invite-friends-btn');
    if (button) {
      button.addEventListener('click', () => {
        openPicker().catch((err) => {
          toast('error', 'Invite friends', friendly(err));
        });
      });
    }
    init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  return {
    init,
    reset,
    openPicker,
    closePicker,
    debug,
    friendly,
    _test: {
      generateIdentity,
      encryptPayload,
      decryptPayload,
      bytesToB64,
      b64ToBytes,
    },
  };
})();

window.Invites = Invites;
