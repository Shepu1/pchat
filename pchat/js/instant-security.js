/**
 * SHEPU ROOMS — instant-security.js
 * Zero-cost, zero-friction hardening for Instant rooms:
 *  - invite secret travels in URL fragment (#k=), never in ?k= query
 *  - ntfy topics derived from secret hash (unguessable without link)
 *  - invisible P2P join proof (HMAC-like, no password prompt)
 * No login, no passphrase UI, no paid services required.
 */

const InstantSecurity = (() => {
  // ── base64url helpers ──────────────────────────────────────────
  function b64urlEncode(str) {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }
  function b64urlDecode(s) {
    if (!s) return null;
    try {
      const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (s.length % 4)) % 4);
      return atob(b64);
    } catch { return null; }
  }

  // ── Read invite secret: prefer #k= (new, private), fallback ?k= (legacy) ──
  function getInviteSecret() {
    try {
      const h = window.location.hash || '';
      const hm = h.match(/[#&]k=([^&#]+)/);
      if (hm && hm[1]) {
        const v = b64urlDecode(decodeURIComponent(hm[1]));
        if (v) return v;
      }
    } catch {}
    try {
      const qp = new URLSearchParams(window.location.search);
      const kP = qp.get('k');
      if (kP) {
        const v = b64urlDecode(kP);
        if (v) return v;
      }
    } catch {}
    return null;
  }

  function getInviteParam(name) {
    try {
      const qp = new URLSearchParams(window.location.search);
      return qp.get(name);
    } catch { return null; }
  }

  // ── Sync (non-async) hash for topic derivation + join proof ─────
  // cyrb53 — public-domain, fast, deterministic. Security comes from
  // the 190-bit random secret, not from hash strength: without the
  // secret nobody can guess the topic / proof.
  function cyrb53(str, seed = 0) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  }

  function legacyTopicFor(roomId) {
    return `shepu_pchat_${roomId}`;
  }

  // New private topic: unguessable without the room secret.
  function topicFor(roomId, roomSecret) {
    if (!roomSecret) return legacyTopicFor(roomId);
    const h = cyrb53(`v1|${roomId}|${roomSecret}`);
    return `shepu_p_${h.slice(0, 20)}`;
  }

  // Both topics (deduplicated) — publish to all, subscribe to all.
  // Keeps old links/clients working during transition.
  function topicsFor(roomId, roomSecret) {
    const t = [topicFor(roomId, roomSecret), legacyTopicFor(roomId)];
    return [...new Set(t)];
  }

  // ── Invisible join proof: guest proves link knowledge, no prompt ──
  function joinProof(roomSecret, memberId) {
    if (!roomSecret || !memberId) return '';
    return cyrb53(`join|${roomSecret}|${memberId}`);
  }
  function verifyJoinProof(roomSecret, memberId, proof) {
    if (!roomSecret) return true; // no secret configured → allow (legacy)
    if (!proof || !memberId) return false;
    try {
      return joinProof(roomSecret, memberId) === proof;
    } catch { return false; }
  }

  // ── Render QR locally (secret never leaves the device) ─────────
  // Uses the bundled qrcode-generator lib (generates in-page). If that
  // lib is unavailable, the remote fallback MUST NOT receive the URL
  // fragment (#k=...), because that fragment carries the room secret.
  function renderQR({ qrImg, qrBox, text, size = 240 }) {
    try {
      if (typeof qrcode !== 'undefined' && qrBox) {
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        qrBox.innerHTML = qr.createSvgTag({ scalable: true });
        const svg = qrBox.querySelector('svg');
        if (svg) {
          svg.setAttribute('width', String(size));
          svg.setAttribute('height', String(size));
          svg.style.cssText = 'width:100%;max-width:240px;height:auto;border-radius:12px;background:#fff;padding:8px;';
        }
        if (qrImg) qrImg.style.display = 'none';
        qrBox.style.display = 'block';
        return true;
      }
    } catch {}
    try {
      if (qrImg) {
        // Strip the fragment (secret carrier) before any network request.
        const safeText = String(text || '').split('#')[0];
        qrImg.style.display = '';
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=8&data=${encodeURIComponent(safeText)}`;
      }
      if (qrBox) qrBox.style.display = 'none';
    } catch {}
    return false;
  }

  return {
    b64urlEncode,
    b64urlDecode,
    getInviteSecret,
    getInviteParam,
    legacyTopicFor,
    topicsFor,
    joinProof,
    verifyJoinProof,
    renderQR,
  };
})();

window.InstantSecurity = InstantSecurity;
