/**
 * SHEPU ROOMS — app.js
 * Main entry point for room.html.
 * Orchestrates: session validation → room load → initial messages → sync loop → presence.
 */

// Small inline shield (replaces the 🔒 emoji everywhere in UI chrome)
const PW_SHIELD_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-2px;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><polyline points="9 11.5 11 13.5 15 9.5"></polyline></svg>';

// ── Room-password gate (locked rooms without a derived key stop here) ──
function showPwGate({ badKey, roomName }) {
  const params = new URLSearchParams(location.search);
  const roomId = params.get('r');
  document.title = 'Locked room — Pchat shepu';
  const gate = document.getElementById('pw-gate');
  if (!gate || !roomId) { window.location.href = 'index.html'; return; }
  gate.classList.remove('hidden');
  try {
    const t = document.getElementById('pw-gate-title');
    if (t) t.innerHTML = `${PW_SHIELD_SVG} <span>${escapeHtml(roomName || 'This room')} is locked</span>`;
  } catch {}
  const err = document.getElementById('pw-gate-error');
  const showErr = (msg) => {
    if (!err) return;
    if (!msg) { err.classList.add('hidden'); err.textContent = ''; }
    else { err.classList.remove('hidden'); err.textContent = msg; }
  };
  showErr(badKey ? 'That password was rejected by the room. Try again.' : '');
  const input = document.getElementById('pw-gate-input');
  const btn = document.getElementById('pw-gate-unlock');
  const busy = (on) => {
    try { btn.disabled = !!on; btn.textContent = on ? 'Unlocking…' : 'Unlock & Enter'; } catch {}
  };
  const doUnlock = async () => {
    const pw = (input && input.value) || '';
    if (!pw) { showErr('Enter the room password.'); return; }
    busy(true); showErr('');
    try {
      await RoomPassword.deriveAndStore(roomId, pw);
      try { if (input) input.value = ''; } catch {}
      window.location.reload();
    } catch (e) {
      showErr((e && e.message) || 'Unlock failed.');
      busy(false);
    }
  };
  try { btn.addEventListener('click', doUnlock); } catch {}
  try { input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doUnlock(); }); } catch {}
  try { document.getElementById('pw-gate-leave')?.addEventListener('click', () => { window.location.href = 'index.html'; }); } catch {}
  setTimeout(() => { try { input.focus(); } catch {} }, 120);
}

// ── Owner room-password controls (set / change / remove) ─────────────
async function bindRoomPasswordUI(room, session) {
  const item = document.getElementById('menu-room-password');
  if (!item || !room || !session || session.role !== 'owner') return;
  item.style.display = '';
  const label = document.getElementById('menu-room-password-text');
  const paint = () => {
    try { if (label) label.textContent = room.passwordLocked ? 'Room Password: ON' : 'Room Password: OFF'; } catch {}
    try {
      const st = document.getElementById('password-modal-status');
      if (st) {
        st.textContent = room.passwordLocked
          ? 'Status: locked — end-to-end encrypted. Links alone open nothing.'
          : 'Status: off — anyone with the link can join.';
        st.style.color = room.passwordLocked ? '#34d399' : 'var(--muted)';
      }
    } catch {}
  };
  paint();
  const modal = document.getElementById('password-modal');
  const pw1 = document.getElementById('room-password-new');
  const pw2 = document.getElementById('room-password-confirm');
  const perr = document.getElementById('password-modal-error');
  const showErr = (msg) => {
    if (!perr) return;
    if (!msg) { perr.classList.add('hidden'); perr.textContent = ''; }
    else { perr.classList.remove('hidden'); perr.textContent = msg; }
  };
  item.addEventListener('click', () => {
    showErr('');
    try { pw1.value = ''; pw2.value = ''; } catch {}
    paint();
    UI.openModal('password-modal');
    setTimeout(() => { try { pw1.focus(); } catch {} }, 80);
  });
  document.getElementById('close-password-btn')?.addEventListener('click', () => UI.closeModal('password-modal'));
  document.getElementById('cancel-password-btn')?.addEventListener('click', () => UI.closeModal('password-modal'));

  document.getElementById('save-password-btn')?.addEventListener('click', async () => {
    const a = (pw1 && pw1.value) || '';
    const b = (pw2 && pw2.value) || '';
    if (a.length < 4) { showErr('Password must be at least 4 characters. Use a strong one.'); return; }
    if (a !== b) { showErr('Passwords do not match.'); return; }
    showErr('');
    const btn = document.getElementById('save-password-btn');
    try { btn.disabled = true; btn.textContent = 'Locking…'; } catch {}
    try {
      // 1. Key this device first (so we never lock ourselves out).
      await RoomPassword.deriveAndStore(room.id, a);
      const hash = await RoomPassword.hashForServer(room.id, a);
      // 2. Server records the verifier + kills pre-lock sessions.
      const res = await RoomAPI.roomOp(room.deploymentUrl, {
        memberId: session.memberId, sessionToken: session.sessionToken,
        op: 'set_password', passwordHash: hash,
      });
      if (!res || !res.success) throw new Error((res && res.error) || 'Server refused.');
      // 3. Rotate the old link secret — pre-lock links lose key material.
      try { Rooms.rotateRoomSecret(room.id); } catch {}
      try { Rooms.updateRoom(room.id, { passwordLocked: true }); } catch {}
      try { pw1.value = ''; pw2.value = ''; } catch {}
      UI.toast('success', 'Room Locked', 'Only the password opens it now. Reloading to enforce…');
      setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      try { RoomPassword.clearStored(room.id); } catch {}
      // The key was already installed in the Encryption module when
      // deriveAndStore() ran — roll it back so a failed lock does not leave
      // the room encrypting messages it never secured.
      try { if (typeof Encryption !== 'undefined') Encryption.clearKey(); } catch {}
      showErr((e && e.message) || 'Could not lock the room.');
      try { btn.disabled = false; btn.textContent = 'Lock Room'; } catch {}
    }
  });

  document.getElementById('remove-password-btn')?.addEventListener('click', async () => {
    showErr('');
    const btn = document.getElementById('remove-password-btn');
    try { btn.disabled = true; } catch {}
    try {
      const res = await RoomAPI.roomOp(room.deploymentUrl, {
        memberId: session.memberId, sessionToken: session.sessionToken, op: 'remove_password',
      });
      if (!res || !res.success) throw new Error((res && res.error) || 'Server refused.');
      try { Rooms.updateRoom(room.id, { passwordLocked: false }); } catch {}
      try { RoomPassword.clearStored(room.id); } catch {}
      try { Encryption.clearKey(); } catch {}
      room.passwordLocked = false;
      UI.toast('info', 'Password Removed', 'Anyone with the link can join again. Reloading…');
      setTimeout(() => window.location.reload(), 900);
    } catch (e) {
      showErr((e && e.message) || 'Could not remove the password.');
      try { btn.disabled = false; } catch {}
    }
  });
}

// Build the join.html redirect without losing any invite parameter.
function buildJoinRedirect(params, roomId, hash) {
  const fwd = new URLSearchParams(params);
  fwd.set('r', roomId);
  return `join.html?${fwd.toString()}${hash || ''}`;
}

document.addEventListener('DOMContentLoaded', async () => {
  // Mobile device detection for theme
  if (/Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 800) {
    document.body.classList.add('is-mobile');
  }

  const params  = new URLSearchParams(location.search);
  const roomId  = params.get('r');
  // Room secret may arrive via invite fragment (#k=, preferred) or legacy
  // query (?k=), e.g. when room.html is opened directly from a shared link.
  // Fragment never reaches servers/logs. Decode once here so session +
  // registry can be patched even if join.html was skipped.
  let urlRoomSecret = null;
  try {
    urlRoomSecret = (typeof InstantSecurity !== 'undefined')
      ? InstantSecurity.getInviteSecret()
      : null;
  } catch { urlRoomSecret = null; }
  if (!urlRoomSecret) {
    try {
      const kParam = params.get('k');
      if (kParam) {
        const b64 = kParam.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - kParam.length % 4) % 4);
        urlRoomSecret = atob(b64) || null;
      }
    } catch { urlRoomSecret = null; }
  }
  // Legacy ?k= links still work (getInviteSecret reads them too) — but the
  // secret must not linger in history/logs, so strip it from the address
  // bar unconditionally right after reading.
  try {
    if (params.has('k')) {
      params.delete('k');
      const qs = params.toString();
      history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
    }
  } catch {}
  let urlDeployment = null;
  try {
    const epParam = params.get('ep');
    if (epParam) {
      const b64 = epParam.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - epParam.length % 4) % 4);
      const decoded = atob(b64) || null;
      // Same allow-list as the join flow: ?ep= is attacker-controlled, so an
      // unknown backend is refused instead of silently taking over the chat.
      urlDeployment = (decoded && isAllowedEndpoint(decoded)) ? decoded : null;
      if (decoded && !urlDeployment) console.warn('Refused an unrecognised room backend from the invite link.');
    }
  } catch { urlDeployment = null; }
  // Room theme (?th=) — public wallpaper digit shared via invite link.
  // Null when absent so stored session/registry themes are never clobbered.
  let urlTheme = null;
  try {
    const thP = params.get('th');
    if (thP && typeof RoomTheme !== 'undefined') urlTheme = RoomTheme.normalize(thP);
  } catch { urlTheme = null; }
  // Password-lock flag (?pw=1). The link carries NO key for locked rooms —
  // the password derives everything on-device.
  let urlPwFlag = false;
  try { urlPwFlag = params.get('pw') === '1'; } catch { urlPwFlag = false; }
  // Room display name (?n=) + kind (?rt=saved|quick) from the invite link.
  // Guests on a fresh device have no registry row, so the link is the only
  // source of truth — without this they see a bare 'Private Room'.
  let urlRoomName = null;
  try {
    const nP = params.get('n');
    // URLSearchParams already decoded once; a second decode broke '%' names.
    if (nP) urlRoomName = nP || null;
  } catch { urlRoomName = null; }
  let urlRoomKind = null;
  try {
    const rtP = params.get('rt');
    if (rtP === 'saved' || rtP === 'quick') urlRoomKind = rtP;
  } catch { urlRoomKind = null; }

  if (!roomId) {
    window.location.href = 'index.html';
    return;
  }

  let session = Storage.getSession();

  if (!session || session.roomId !== roomId) {
    // Check if user is owner of this room
    const myRooms = Rooms.getMyRooms() || [];
    const myRoom = myRooms.find(r => r.id === roomId);

    if (myRoom) {
      const authUser = Storage.getAuth()?.user || {};
      const ownerName = authUser.name || localStorage.getItem('shepu_display_name') || 'Owner';
      const ownerPicture = (typeof UI !== 'undefined' && UI.effectivePicture)
        ? UI.effectivePicture()
        : (authUser.picture || '');
      session = {
        roomId,
        memberId:     'u_owner_' + roomId.slice(0, 6),
        // Rebuild the owner credential from the device-local registry entry.
        // A secret-derived token would be reconstructible by anyone holding
        // the invite link, so it must never be used here.
        sessionToken: Rooms.ensureOwnerToken(myRoom),
        displayName:  ownerName,
        picture:      ownerPicture,
        role:         'owner',
        joinedAt:     myRoom.createdAt || new Date().toISOString(),
        deploymentUrl: myRoom.deploymentUrl || `mock://local/${roomId}`,
        roomName:     myRoom.name,
        roomDesc:     myRoom.description,
        roomSecret:   myRoom.secret || '',
      };
      Storage.setSession(session);
      Storage.setCurrentRoom(roomId);
    } else {
      // Check if user previously joined this room
      const joinedRooms = Rooms.getJoinedRooms() || [];
      const joinedRoom = joinedRooms.find(r => r.id === roomId);
      const knownName = Storage.getAuth()?.user?.name || localStorage.getItem('shepu_display_name');

      if (joinedRoom && knownName) {
        const memberPicture = (typeof UI !== 'undefined' && UI.effectivePicture)
          ? UI.effectivePicture()
          : ((Storage.getAuth()?.user || {}).picture || '');
        session = {
          roomId,
          memberId:     'u_' + Date.now().toString(36),
          sessionToken: 'member_sess_' + Date.now(),
          displayName:  knownName,
          picture:      memberPicture,
          role:         'member',
          joinedAt:     joinedRoom.joinedAt || new Date().toISOString(),
          deploymentUrl: urlDeployment || joinedRoom.deploymentUrl || `mock://local/${roomId}`,
          roomName:     joinedRoom.name,
          roomDesc:     joinedRoom.description,
          roomSecret:   urlRoomSecret || joinedRoom.secret || '',
        };
        Storage.setSession(session);
        Storage.setCurrentRoom(roomId);
      } else {
        // No valid session for this room — go to join, forwarding the full
        // invite (endpoint, name, theme, lock flag and #k= key). Dropping
        // these made the joiner lose E2EE key + endpoint.
        window.location.href = buildJoinRedirect(params, roomId, window.location.hash);
        return;
      }
    }
  }

  // Patch a valid session with fresher details from the invite URL.
  // This keeps link-joins working even when an old session exists.
  try {
    if (session && session.roomId === roomId) {
      let patched = false;
      if (urlRoomSecret && session.roomSecret !== urlRoomSecret) {
        session.roomSecret = urlRoomSecret;
        patched = true;
      }
      if (urlDeployment && session.deploymentUrl !== urlDeployment) {
        session.deploymentUrl = urlDeployment;
        patched = true;
      }
      if (urlRoomName && (!session.roomName || session.roomName === 'Private Room')) {
        session.roomName = urlRoomName;
        patched = true;
      }
      if (urlRoomKind && session.roomKind !== urlRoomKind) {
        session.roomKind = urlRoomKind;
        patched = true;
      }
      if (urlTheme && !session.theme) {
        // Fresh join via link adopts the link theme; an already-stored
        // theme (explicit user pick) is NEVER silently overridden.
        session.theme = urlTheme;
        patched = true;
      }
      if (patched) Storage.setSession(session);
    }
  } catch { /* non-critical */ }

  // Refresh session picture from the effective profile (e.g. user set a
  // Settings photo or logged in after joining) so new messages carry it.
  try {
    if (session && session.roomId === roomId && typeof UI !== 'undefined' && UI.effectivePicture) {
      const eff = UI.effectivePicture() || '';
      if ((session.picture || '') !== eff) {
        session.picture = eff;
        Storage.setSession(session);
      }
    }
  } catch { /* non-critical */ }

  // ── Recover room from registry OR rebuild from session ────────
  let room = Rooms.getRoom(roomId);

  // Expose room context for the encrypted-invite picker (invites.js uses this
  // when the user clicks "Invite a Pchat friend" from the share modal).
  window.getRoomInviteContext = function () {
    try {
      const urls = Rooms.getShareUrls(room.id, room.deploymentUrl, room.name);
      return {
        roomId:         room.id,
        roomName:       room.name,
        link:           urls.defaultUrl,
        passwordLocked: room.passwordLocked === true,
      };
    } catch { return null; }
  };

  if (!room) {
    // Room not in registry but session is valid — reconstruct from session
    room = {
      id:            roomId,
      name:          (session.roomName && session.roomName !== 'Private Room' && session.roomName)
                    || (urlRoomName || 'Private Room'),
      description:   session.roomDesc || '',
      status:        'active',
      deploymentUrl: session.deploymentUrl || `mock://local/${roomId}`,
      isOwner:       session.role === 'owner',
      createdAt:     session.joinedAt || new Date().toISOString(),
      secret:        session.roomSecret || urlRoomSecret || '',
      theme:         session.theme || urlTheme || 1,
      kind:          session.roomKind || urlRoomKind || 'quick',
      quickIcon:     session.quickIcon || undefined,
    };
    // Save back to registry so future loads don't have to rebuild
    if (session.role === 'owner') {
      Storage.addMyRoom(room);
    } else {
      Storage.addJoinedRoom(room);
    }
  }

  // Ensure deploymentUrl/secret are always set (backfill from URL/session)
  if (!room.deploymentUrl || urlDeployment) {
    const dep = urlDeployment || room.deploymentUrl || session.deploymentUrl || `mock://local/${roomId}`;
    if (dep && dep !== room.deploymentUrl) {
      room.deploymentUrl = dep;
      try { Rooms.updateRoom(roomId, { deploymentUrl: dep }); } catch {}
    }
  }
  if (!room.secret) {
    const sec = urlRoomSecret || session.roomSecret || '';
    if (sec) {
      room.secret = sec;
      try { Rooms.updateRoom(roomId, { secret: sec }); } catch {}
    }
  }
  // Backfill a truer room name/kind (invite link or session) when the
  // registry still holds a blank/'Private Room' placeholder.
  try {
    const betterName = (urlRoomName && urlRoomName !== 'Private Room' && urlRoomName)
      || (session.roomName && session.roomName !== 'Private Room' && session.roomName)
      || null;
    if (betterName && (!room.name || room.name === 'Private Room')) {
      room.name = betterName;
      try { Rooms.updateRoom(roomId, { name: betterName }); } catch {}
    }
    const betterKind = urlRoomKind || session.roomKind || null;
    if (betterKind && !room.kind) {
      room.kind = betterKind;
      try { Rooms.updateRoom(roomId, { kind: betterKind }); } catch {}
    }
    // Adopt the link's lock flag when the registry doesn't know yet.
    if (urlPwFlag && !room.passwordLocked) {
      room.passwordLocked = true;
      try { Rooms.updateRoom(roomId, { passwordLocked: true }); } catch {}
    }
  } catch { /* non-critical */ }

  // ── Owner membership repair (Google-Sheets-backed rooms) ─────
  // Without a members row with role=owner, every Apps Script room_op returns
  // FORBIDDEN. New rooms get the row at creation; this repairs legacy rooms.
  try {
    if (session.role === 'owner' && room.spreadsheetId && !room.deploymentUrl.startsWith('mock://')) {
      await Rooms.ensureOwnerMemberRow(room, session);
    }
  } catch (e) { console.warn('[app] owner membership repair skipped:', e && e.message); }

  // ── Room-password gate ────────────────────────────────────────
  // Locked rooms stop here without a derived key: no history renders, no
  // sync starts, no plaintext is touched. Unlocking reloads into this same
  // flow with the key present in sessionStorage.
  let pwTopicSecret = null;
  const roomLocked = (room && room.passwordLocked === true) || urlPwFlag === true;
  if (roomLocked) {
    if (!room.passwordLocked) {
      room.passwordLocked = true;
      try { Rooms.updateRoom(roomId, { passwordLocked: true }); } catch {}
    }
    try {
      if (typeof RoomPassword !== 'undefined' && RoomPassword.loadStored) {
        const loaded = await RoomPassword.loadStored(roomId);
        if (loaded && loaded.topicSecret) pwTopicSecret = loaded.topicSecret;
      }
    } catch {}
    let badKey = false;
    try { badKey = typeof RoomPassword !== 'undefined' && RoomPassword.wasRejected(roomId); } catch {}
    if (!pwTopicSecret || badKey) {
      showPwGate({ badKey, roomName: room.name || 'this room' });
      return; // gate reloads on successful unlock
    }
    // A previously-rejected key is good now (we only get here with a key
    // the host hasn't refused this session) — clear the stale flag.
    try { if (badKey && typeof RoomPassword !== 'undefined') RoomPassword.markRejected(roomId, false); } catch {}
  }

  // Effective wire secret: password-derived topic secret wins over any
  // link/registry secret (locked-room links carry no key at all).
  let effSecret = '';
  try {
    effSecret = pwTopicSecret
      || urlRoomSecret || (session && session.roomSecret) || (room && room.secret) || '';
  } catch { effSecret = ''; }
  // Theme: URL (?th=) wins, then session/registry; apply wallpaper now.
  try {
    const th = (typeof RoomTheme !== 'undefined')
      ? RoomTheme.normalize(urlTheme || room.theme || (session && session.theme) || 1)
      : 1;
    room.theme = th;
    if (typeof RoomTheme !== 'undefined') RoomTheme.apply(th);
    try {
      const reg = Rooms.getRoom(roomId);
      if (reg && !reg.theme) Rooms.updateRoom(roomId, { theme: th });
    } catch {}
  } catch { /* non-critical */ }

  // ── Populate header ───────────────────────────────────────────
  // Room names are stored clean now; legacy rooms may still carry a leading
  // emoji marker — strip it so the header stays colourless.
  const displayRoomName = String(room.name || '')
    .replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\s]+/gu, '')
    .trim() || room.name || 'Chat';
  document.title = `${displayRoomName} — Pchat shepu`;
  const titleEl = document.getElementById('room-title');
  const paintTitle = (n) => { if (titleEl) titleEl.innerHTML = emoName(n); };
  paintTitle(displayRoomName);
  // Room profile icon: saved.webp for sheet rooms, one of the four quick
  // avatars (random per room) for instant/P2P rooms.
  try {
    const avImg = document.getElementById('room-avatar');
    if (avImg) {
      const icon = (typeof Rooms !== 'undefined' && Rooms.roomIcon)
        ? Rooms.roomIcon(room, room.kind || urlRoomKind)
        : ((room.spreadsheetId || room.kind === 'saved' || urlRoomKind === 'saved')
          ? 'assets/icons/saved.webp'
          : ((typeof Rooms !== 'undefined' && Rooms.quickIconFor)
            ? Rooms.quickIconFor(room)
            : 'assets/icons/quick.webp'));
      avImg.src = icon;
      avImg.alt = room.name || 'Room';
      avImg.onerror = () => { try { avImg.style.display = 'none'; } catch {} };
    }
  } catch {}
  // Repaint once custom emoji arrive (room names may lead with emoji)
  try {
    if (typeof CustomEmoji !== 'undefined') {
      CustomEmoji.load().then(() => paintTitle(displayRoomName)).catch(() => {});
    }
  } catch {}
  Chat.setStatus('Connecting…', false);

  // ── Setup Google Sheet links in header & menu ────────────────
  const headerSheetBtn = document.getElementById('header-sheet-btn');
  const menuSheetLink  = document.getElementById('menu-sheet-link');
  if (room.spreadsheetId) {
    const sheetUrl = `https://docs.google.com/spreadsheets/d/${room.spreadsheetId}/edit`;
    if (headerSheetBtn) {
      headerSheetBtn.href = sheetUrl;
      headerSheetBtn.style.display = 'inline-flex';
    }
    if (menuSheetLink) {
      menuSheetLink.href = sheetUrl;
      menuSheetLink.style.display = 'flex';
    }
  }

  // ── Init chat module ──────────────────────────────────────────
  // Notify.init() runs BEFORE the chat module so the "my own message" guard
  // is active while the cached history is rendered.
  if (typeof Notify !== 'undefined') {
    Notify.init({
      memberId: session.memberId,
      displayName: session.displayName,
      roomName: room.name || 'Chat',
    });
  }
  Chat.init(room, session);
  // Owner password controls (menu item + modal). No-op for guests.
  try { bindRoomPasswordUI(room, session); } catch {}
  // "End-to-end encrypted" badge — ONLY when the room is password-locked
  // AND this device holds the derived key. Anything else showing it
  // would be a lie (unlocked rooms are plaintext on the relay).
  try {
    const badge = document.getElementById('e2ee-badge');
    if (badge) {
      const e2ee = roomLocked === true
        && typeof Encryption !== 'undefined' && Encryption.isActive
        && Encryption.isActive();
      badge.classList.toggle('hidden', !e2ee);
    }
  } catch {}

  // ── Load cached messages immediately (IDB + localStorage) ─────
  try {
    let cached = [];
    if (typeof IDBStorage !== 'undefined') {
      cached = await IDBStorage.getMessages(roomId, 100);
    }
    const localMsgs = (typeof Storage !== 'undefined' && Storage.getRoomStoredMessages)
      ? Storage.getRoomStoredMessages(roomId)
      : [];

    const combined = [...(cached || []), ...(localMsgs || [])];
    const unique = [];
    const seen = new Set();
    for (const m of combined) {
      if (m && m.id && !seen.has(m.id)) {
        seen.add(m.id);
        unique.push(m);
      }
    }
    if (unique.length) {
      Chat.appendMessages(unique);
      try { updateKeyBanner(); } catch {}
    }
  } catch { /* non-critical */ }

  // ── Load messages directly from Google Sheet if valid Google token is present ──
  try {
    if (room.spreadsheetId && typeof Auth !== 'undefined' && Auth.hasGoogleToken && Auth.hasGoogleToken()) {
      const sheetMsgs = await Chat.loadSheetMessages();
      if (sheetMsgs && sheetMsgs.length) {
        Chat.appendMessages(sheetMsgs);
      try { updateKeyBanner(); } catch {}
      }
    }
  } catch (err) {
    console.warn('[app] Could not load messages from Google Sheet:', err.message);
  }

  // ── Join / re-join the room backend ──────────────────────────
  try {
    const joinRes = await RoomAPI.join(room.deploymentUrl, {
      displayName:  session.displayName,
      memberId:     session.memberId,
      sessionToken: session.sessionToken,
      picture:      session.picture || '',
    });

    if (joinRes && joinRes.success) {
      // Adopt the backend-issued memberId too: on a fresh custom-backend
      // room the server generates one, and keeping the old client-side id
      // caused member-id/token drift and duplicate member rows on rejoin.
      // Mutate in place — Chat.init already holds this object by reference.
      session.memberId     = joinRes.memberId || session.memberId;
      session.sessionToken = joinRes.sessionToken || session.sessionToken;
      session.role         = session.role === 'owner' ? 'owner' : (joinRes.role || session.role);
      Storage.setSession(session);
    } else if (joinRes && joinRes.success === false) {
      const code = joinRes.code;
      if (code === 'DISABLED') { Chat.showUnavailable('This room is currently disabled.'); return; }
      if (code === 'DELETED')  { Chat.showUnavailable('This room has been deleted.'); return; }
      if (code === 'BANNED')   { Chat.showUnavailable('You have been banned from this room.'); return; }
    }

  } catch (err) {
    if (err && err.isNetwork) {
      Chat.setStatus('Offline — cached messages shown', false);
      UI.toast('warning', 'Offline', 'Could not connect to room backend. Showing cached messages.');
    } else {
      // Non-fatal — continue with cached data
      console.warn('[app] join error (non-fatal):', err && err.message);
    }
  }

  // ── Verify room status ─────────────────────────────────────────
  try {
    const roomInfo = await RoomAPI.getRoom(room.deploymentUrl);
    if (roomInfo && roomInfo.success && roomInfo.room) {
      const status = roomInfo.room.status;
      if (status === 'deleted')  { Chat.showUnavailable('This room has been deleted.'); return; }
      if (status === 'disabled') { Chat.showUnavailable('This room is currently unavailable.'); return; }
      if (status === 'locked')   { Chat.setStatus('Locked (read-only)', true); }
      else                        { Chat.setStatus(`${session.displayName}`, true); }

      // Update local room name if renamed
      if (roomInfo.room.name && roomInfo.room.name !== room.name) {
        Rooms.updateRoom(roomId, { name: roomInfo.room.name });
        paintTitle(roomInfo.room.name);
      }
    } else {
      Chat.setStatus(`${session.displayName}`, true);
    }
  } catch {
    // Non-critical — just show connected status
    Chat.setStatus(`${session.displayName}`, true);
  }

  // ── Background room key (decrypt-only) ─────────────────────────
  // Invite-link secret derives the AES-GCM key automatically so OLD
  // enc: messages stay readable — but new messages are sent as PLAINTEXT
  // unless the owner sets a manual passphrase (shield button).
  // Guests NEVER see a password prompt and no login is required.
  try {
    if (typeof Encryption !== 'undefined' && !Encryption.isActive()) {
      const roomSecret = session.roomSecret || room.secret;
      if (roomSecret) {
        await Encryption.deriveKeyFromRoomSecret(roomSecret, roomId);
        console.log('[app] room read-key ready for', roomId);
        try {
          if (typeof Chat !== 'undefined' && Chat.refreshDecryption) {
            await Chat.refreshDecryption();
          }
        } catch {}
        try { updateKeyBanner(); } catch {}
      }
    } else if (typeof Encryption !== 'undefined' && Encryption.isManual
               && Encryption.isManual()
               && typeof Chat !== 'undefined' && Chat.setEncryptionStatus) {
      Chat.setEncryptionStatus(true);
    }
  } catch (err) {
    console.warn('[app] Could not initialize encryption:', err && err.message);
  }

  // ── Address-bar key mirror: if WE hold the secret, ensure #k= is in the
  // URL fragment so copying the address bar shares a WORKING link.
  // Fragments never reach servers/logs. Fixes "guest sees only placeholders"
  // caused by sharing the bare room.html?r= URL.
  // Skipped for password-locked rooms (their links carry no key by design).
  try {
    const sec = session.roomSecret || room.secret || urlRoomSecret;
    if (sec && !roomLocked && typeof InstantSecurity !== 'undefined' && !/[#&]k=/.test(window.location.hash || '')) {
      const frag = (window.location.hash ? window.location.hash + '&' : '#') + 'k=' + InstantSecurity.b64urlEncode(sec);
      history.replaceState(null, '', window.location.pathname + window.location.search + frag);
    }
  } catch { /* non-critical */ }

  // ── Locked-message banner (only when actually needed) ──────────
  // Shows a paste-link box IFF the feed holds enc: messages nobody here can
  // decrypt (no active key) — e.g. owner enabled passphrase-E2EE. Normal
  // readable chat never triggers it. Also covers browsers WITHOUT WebCrypto
  // (http:// LAN, some in-app WebViews): those can NEVER decrypt.
  // Function declaration (not an assignment) so it is hoisted: earlier code
  // in this same callback calls it while loading cached history, which
  // previously ran before the assignment existed and never showed the banner.
  function updateKeyBanner() {
    try {
      const keyBanner = document.getElementById('key-banner');
      if (!keyBanner) return;
      const hasSubtle = !!(window.crypto && window.crypto.subtle);
      let needsKey = false;
      try {
        const keyActive = (typeof Encryption !== 'undefined' && Encryption.isActive) ? Encryption.isActive() : false;
        if (!keyActive && typeof Chat !== 'undefined' && Chat.getMessages) {
          needsKey = Chat.getMessages().some(m => m && !m.deleted &&
            typeof m.message === 'string' && m.message.indexOf('enc:') === 0);
        }
      } catch {}
      if (!needsKey) {
        keyBanner.classList.add('hidden');
        return;
      }
      if (!hasSubtle) {
        const note = keyBanner.querySelector('div');
        if (note) {
          const onHttp = window.location.protocol === 'http:';
          note.innerHTML = onHttp
            ? PW_SHIELD_SVG + ' <strong>Locked messages?</strong> This page is on insecure <strong>http://</strong> — browsers disable decryption here. Open the <strong>https://</strong> link of this site (e.g. GitHub Pages) in Chrome instead.'
            : PW_SHIELD_SVG + ' <strong>Locked messages?</strong> This browser (in-app viewer?) cannot decrypt messages. Please open this room in <strong>Chrome</strong> and paste the full invite link below.';
        }
      }
      keyBanner.classList.toggle('hidden', !needsKey);
    } catch { /* non-critical */ }
  }
  window.updateKeyBanner = updateKeyBanner;
  try {
    document.getElementById('key-banner-btn')?.addEventListener('click', async () => {
      const keyBanner = document.getElementById('key-banner');
      const raw = (document.getElementById('key-banner-input')?.value || '').trim();
      if (!raw) return;
      try {
        const u = new URL(raw, window.location.origin);
        if (u.searchParams.get('r') && u.searchParams.get('r') !== roomId) {
          throw new Error('This link is for a different room.');
        }
        let freshSecret = null;
        const hm = (u.hash || '').match(/[#&]k=([^&#]+)/);
        if (hm && hm[1] && typeof InstantSecurity !== 'undefined') {
          freshSecret = InstantSecurity.b64urlDecode(decodeURIComponent(hm[1]));
        }
        if (!freshSecret) {
          const kP = u.searchParams.get('k');
          if (kP && typeof InstantSecurity !== 'undefined') freshSecret = InstantSecurity.b64urlDecode(kP);
        }
        if (!freshSecret) throw new Error('No room key in that link. Copy the FULL invite link (Invite → Copy).');
        session.roomSecret = freshSecret;
        Storage.setSession(session);
        room.secret = freshSecret;
        try { Rooms.updateRoom(roomId, { secret: freshSecret }); } catch {}
        const thP = u.searchParams.get('th');
        if (thP && typeof RoomTheme !== 'undefined' && !room.theme) {
          const th = RoomTheme.normalize(thP);
          room.theme = th;
          try { Rooms.updateRoom(roomId, { theme: th }); } catch {}
          RoomTheme.apply(th);
        }
        if (typeof Encryption !== 'undefined' && Encryption.deriveKeyFromRoomSecret) {
          await Encryption.deriveKeyFromRoomSecret(freshSecret, roomId);
          if (typeof Chat !== 'undefined' && Chat.refreshDecryption) await Chat.refreshDecryption();
        }
        try {
          const frag = (window.location.hash ? window.location.hash + '&' : '#') + 'k=' + InstantSecurity.b64urlEncode(freshSecret);
          history.replaceState(null, '', window.location.pathname + window.location.search + frag);
        } catch {}
        if (typeof window.updateKeyBanner === 'function') window.updateKeyBanner();
        UI.toast('success', 'Unlocked', 'Messages decrypted.');
      } catch (e) {
        UI.toast('error', 'Invalid link', (e && e.message) || 'Could not read that link.');
      }
    });
  } catch { /* non-critical */ }

  // ── Load members ──────────────────────────────────────────────
  try {
    const members = await Members.fetchAndCache(room.deploymentUrl, room.id);
    if (members && members.length) Chat.renderMembers(members);
  } catch { /* non-critical */ }

  // ── Start sync loop ───────────────────────────────────────────
  // Resume from the stored cursor so reloads don't refetch full history.
  let startRow = 0;
  try {
    if (typeof Storage !== 'undefined' && Storage.getSyncCursor) {
      startRow = Storage.getSyncCursor(roomId) || 0;
    }
  } catch { startRow = 0; }
  Sync.start({
    roomId:      roomId,
    endpointUrl: room.deploymentUrl,
    lastRow:     startRow,
    onMessages:  async (msgs) => {
      Chat.appendMessages(msgs);
      try {
        await IDBStorage.putMessages(msgs.map(m => ({ ...m, roomId })));
      } catch { /* non-critical */ }
    },
  });

  // ── Presence heartbeat (+ cross-device announce) ─────────────
  // Each heartbeat also publishes a tiny presence beacon to the relay so
  // every device's member list stays truthful without any login.
  const announcePresence = (status = 'online') => {
    try {
      if (typeof NtfySync === 'undefined' || !NtfySync.publish) return;
      let pic = session.picture || '';
      if (typeof pic === 'string' && pic.startsWith('data:')) pic = ''; // keep relay light
      NtfySync.publish({
        type: 'presence',
        member: {
          memberId: session.memberId,
          displayName: session.displayName,
          picture: pic,
          role: session.role || 'member',
        },
      });
    } catch {}
  };
  Presence.start({
    roomId:       roomId,
    endpointUrl:  room.deploymentUrl,
    memberId:     session.memberId,
    sessionToken: session.sessionToken,
    onMembersUpdate: (members) => Chat.renderMembers(members),
    announce: announcePresence,
  });

  // ── P2P Real-time WebRTC Mesh (PeerJS) ────────────────────────
  if (typeof P2PSync !== 'undefined') {
    P2PSync.init({
      roomId:      room.id,
      roomSecret: effSecret || null,
      requireProof: roomLocked === true,
      onJoinRejected: (reason) => {
        // Host refused us (wrong/no room password). Mark it so the gate
        // explains instead of looping, then reload into the gate.
        try { RoomPassword.markRejected(room.id, true); } catch {}
        window.location.reload();
      },
      isHost:      session.role === 'owner' || (room && room.isOwner === true) || (typeof Rooms !== 'undefined' && Rooms.getMyRooms().some(r => r.id === room.id)),
      memberId:    session.memberId,
      displayName: session.displayName,
      onMessage: async (msgs) => {
        Chat.appendMessages(msgs);
          try { updateKeyBanner(); } catch {}
        try {
          if (typeof IDBStorage !== 'undefined') {
            await IDBStorage.putMessages(msgs.map(m => ({ ...m, roomId: room.id })));
          }
          if (typeof Storage !== 'undefined' && Storage.saveRoomMessages) {
            Storage.saveRoomMessages(room.id, msgs);
          }
        } catch { /* non-critical */ }
      },
      onHistoryRequest: () => {
        const live = Chat.getMessages();
        if (live && live.length) return live;
        return (typeof Storage !== 'undefined' && Storage.getRoomStoredMessages)
          ? Storage.getRoomStoredMessages(room.id)
          : [];
      },
      onMembersUpdate: (mems) => {
        if (mems && mems.length) Chat.renderMembers(mems);
      },
      onTyping: (info) => {
        if (typeof Chat !== 'undefined' && Chat.handleTypingEvent) {
          Chat.handleTypingEvent(info);
        }
      },
    });
  }

  // ── Ntfy cloud history + realtime relay (Quick room resilience) ──
  // Keeps messages flowing (and gives new joiners history) even when the
  // host's browser is offline. Harmless for Saved rooms (sheet backup also polls).
  if (typeof NtfySync !== 'undefined') {
    NtfySync.init({
      roomId: room.id,
      roomSecret: effSecret || null,
      privateOnly: roomLocked === true,
      onEvent: ({ kind, msg, member, theme, payload }) => {
        if (kind === 'call_signal' && payload) {
          if (typeof CallManager !== 'undefined' && CallManager.handleIncomingSignal) {
            CallManager.handleIncomingSignal(payload);
          }
          return;
        }
        // Room-wide wallpaper change from another device (no echo loop:
        // setTheme with broadcast=false only applies + persists).
        if (kind === 'theme' && theme) {
          const th = (typeof RoomTheme !== 'undefined') ? RoomTheme.normalize(theme) : 0;
          if (th && room.theme !== th) {
            room.theme = th;
            try { Rooms.updateRoom(room.id, { theme: th }); } catch {}
            try {
              const s = Storage.getSession();
              if (s && s.roomId === room.id) { s.theme = th; Storage.setSession(s); }
            } catch {}
            if (typeof Chat !== 'undefined' && Chat.setTheme) {
              try { Chat.setTheme(th, false); } catch {}
            } else if (typeof RoomTheme !== 'undefined') {
              RoomTheme.apply(th);
            }
          }
          return;
        }
        if (kind === 'message' && msg) {
          // Skip our own messages (we already appended them optimistically)
          if (msg.senderId && msg.senderId === session.memberId) return;
          // Skip messages we've already rendered via P2P / sync
          if (typeof Chat.getMessages === 'function') {
            const already = Chat.getMessages().some(m => m.id === msg.id);
            if (already) return;
          }
          Chat.appendMessages([msg]);
          try { updateKeyBanner(); } catch {}
          try {
            if (typeof IDBStorage !== 'undefined') {
              IDBStorage.putMessages([{ ...msg, roomId: room.id }]).catch(() => {});
            }
            if (typeof Storage !== 'undefined' && Storage.saveRoomMessages) {
              Storage.saveRoomMessages(room.id, [msg]);
            }
          } catch { /* non-critical */ }
        }
        // Seen receipts via cloud relay
        if (kind === 'seen' && payload) {
          if (typeof Chat !== 'undefined' && Chat.appendMessages) {
            Chat.appendMessages([{ _seenEvent: true, seenBy: payload.seenBy, messageIds: payload.messageIds }]);
          }
          return;
        }
        // Reaction updates via cloud relay
        if (kind === 'reaction' && payload && payload.reaction) {
          if (typeof Chat !== 'undefined' && Chat.appendMessages) {
            // payload.reaction holds {msgId, emoji, memberId, memberName,
            // action}; spreading `payload` itself dropped all of those and
            // the reaction was silently ignored.
            Chat.appendMessages([{ _reactionEvent: true, ...payload.reaction }]);
          }
          return;
        }
        // Owner changed the room status (quick rooms have no server, so the
        // mock backend relays it). Apply it on every connected guest.
        if (kind === 'room_status' && payload && payload.status) {
          const st = payload.status;
          room.status = st;
          try { Rooms.updateRoom(room.id, { status: st }); } catch {}
          // Mirror it into this device's local mock store so the send path
          // enforces a lock the owner applied on another device.
          try { Rooms.setLocalRoomStatus(room.id, st); } catch {}
          if (st === 'deleted') { Chat.showUnavailable('This room has been deleted.'); return; }
          if (st === 'disabled') { Chat.showUnavailable('This room is currently disabled.'); return; }
          if (st === 'locked') {
            Chat.setStatus('Locked (read-only)', true);
            Chat.setComposerEnabled(false);
            return;
          }
          if (st === 'active') {
            try {
              document.getElementById('room-unavailable-overlay')?.classList.add('hidden');
              Chat.setComposerEnabled(true);
              Chat.setStatus(session.displayName || 'Online', true);
            } catch {}
          }
          return;
        }
        // Cross-device presence beacon → merge into the member directory
        // (marked "seen now"), so online status is truthful everywhere.
        if (kind === 'presence' && member && member.memberId) {
          if (member.memberId === session.memberId) return; // self seeded already
          if (typeof Chat !== 'undefined' && Chat.mergeMembers) {
            try { Chat.mergeMembers([member], { touch: true }); } catch {}
          }
          return;
        }
      },
    });
    NtfySync.start();
    // Announce immediately (first heartbeat otherwise waits ~15s)
    try { announcePresence('online'); } catch {}
  }

  // ── Web push / desktop notifications ───────────────────────────
  // (initialised above, before the history was rendered — see the note there)

  // ── Handle visibility changes ─────────────────────────────────
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      Sync.forceSync();
      Presence.heartbeat();
    }
  });

  // ── Share / QR Modal in Room ─────────────────────────────────
  const qrBtn = document.getElementById('room-qr-btn');
  const shareModal = document.getElementById('share-modal');
  const shareClose = document.getElementById('share-modal-close');
  const shareDone  = document.getElementById('share-modal-done');

  if (qrBtn && shareModal) {
    qrBtn.addEventListener('click', () => {
      // Single universal invite link (no device tabs — one link for all)
      const urls = Rooms.getShareUrls(room.id, room.deploymentUrl, room.name);
      const activeUrl = urls.defaultUrl;

      const shareTitle  = document.getElementById('share-modal-title');
      const qrImg       = document.getElementById('share-qr-img');
      const urlDisplay  = document.getElementById('modal-share-url');

      if (shareTitle) shareTitle.innerHTML = emoName(room.name);
      // Local QR first (secret never leaves device), remote fallback.
      try {
        const qrBox = document.getElementById('share-qr-box');
        if (typeof InstantSecurity !== 'undefined') {
          InstantSecurity.renderQR({ qrImg, qrBox, text: urls.qrText || activeUrl });
        } else if (qrImg) qrImg.src = urls.qrCodeUrl;
      } catch {
        if (qrImg) qrImg.src = urls.qrCodeUrl;
      }
      if (urlDisplay) urlDisplay.textContent = activeUrl;

      const sheetBox  = document.getElementById('modal-sheet-link-box');
      const sheetLink = document.getElementById('modal-sheet-url');
      if (room.spreadsheetId && sheetBox && sheetLink) {
        sheetLink.href = `https://docs.google.com/spreadsheets/d/${room.spreadsheetId}/edit`;
        sheetBox.style.display = 'block';
      } else if (sheetBox) {
        sheetBox.style.display = 'none';
      }

      // Troubleshooting toggle
      const tBtn     = document.getElementById('btn-toggle-troubleshoot');
      const tContent = document.getElementById('troubleshoot-content');
      const tChevron = document.getElementById('troubleshoot-chevron');
      if (tBtn && tContent) {
        tBtn.onclick = () => {
          const hidden = tContent.style.display === 'none' || !tContent.style.display;
          tContent.style.display = hidden ? 'block' : 'none';
          if (tChevron) tChevron.textContent = hidden ? '▴' : '▾';
        };
      }

      const copyBtn = document.getElementById('btn-modal-copy');
      if (copyBtn) copyBtn.onclick = async () => {
        await UI.copyText(activeUrl);
        UI.toast('success', 'Copied', 'Room link copied to clipboard!');
      };

      // Revoke old link → new secret, new topic, new key. Old links die for new joins.
      const rotateBtn = document.getElementById('btn-rotate-link');
      if (rotateBtn) rotateBtn.onclick = async () => {
        try {
          const fresh = Rooms.rotateRoomSecret(room.id);
          if (!fresh) return;
          room.secret = fresh;
          const sess = Storage.getSession();
          if (sess && sess.roomId === room.id) {
            sess.roomSecret = fresh;
            Storage.setSession(sess);
          }
          try {
            if (typeof Encryption !== 'undefined' && Encryption.deriveKeyFromRoomSecret) {
              await Encryption.deriveKeyFromRoomSecret(fresh, room.id);
            }
          } catch {}
          // Follow the new secret immediately: drop the revoked Ntfy topic,
          // verify new P2P proofs against it, and keep the address bar's #k=
          // in sync so a reload/reshare does not resurrect the old link.
          try {
            if (typeof NtfySync !== 'undefined' && NtfySync.setSecret) NtfySync.setSecret(fresh);
          } catch {}
          try {
            if (typeof P2PSync !== 'undefined' && P2PSync.updateSecret) P2PSync.updateSecret(fresh);
          } catch {}
          try {
            const encoded = btoa(fresh).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
            history.replaceState(null, '', window.location.pathname + window.location.search + '#k=' + encoded);
          } catch {}
          try { if (typeof Presence !== 'undefined' && Presence.heartbeat) Presence.heartbeat(); } catch {}
          const urls2 = Rooms.getShareUrls(room.id, room.deploymentUrl, room.name);
          const url2 = urls2.defaultUrl;
          const urlDisplay2 = document.getElementById('modal-share-url');
          if (urlDisplay2) urlDisplay2.textContent = url2;
          try {
            const qrImg2 = document.getElementById('share-qr-img');
            const qrBox2 = document.getElementById('share-qr-box');
            if (typeof InstantSecurity !== 'undefined') {
              InstantSecurity.renderQR({ qrImg: qrImg2, qrBox: qrBox2, text: urls2.qrText || url2 });
            }
          } catch {}
          if (copyBtn) copyBtn.onclick = async () => {
            await UI.copyText(url2);
            UI.toast('success', 'Copied', 'New room link copied!');
          };
          UI.toast('success', 'Link rotated', 'Old invite links no longer work for new joins.');
        } catch (e) {
          UI.toast('error', 'Failed', 'Could not rotate link.');
        }
      };

      shareModal.classList.remove('hidden');
    });

    // invites.js already owns this button's click handler (it binds in its
    // boot). This listener only closes the share modal behind the picker, so
    // the picker is not opened twice.
    const inviteFriendsBtn = document.getElementById('room-invite-friends-btn');
    if (inviteFriendsBtn) {
      inviteFriendsBtn.addEventListener('click', () => {
        if (typeof Invites === 'undefined' || !Invites.openPicker) {
          UI.toast('info', 'Not available', 'Sign in with Google to invite friends.');
          return;
        }
        shareModal.classList.add('hidden');
      });
    }

    if (shareClose) shareClose.addEventListener('click', () => shareModal.classList.add('hidden'));
    if (shareDone)  shareDone.addEventListener('click',  () => shareModal.classList.add('hidden'));
  }

  // ── Leave on unload (best-effort) ─────────────────────────────
  window.addEventListener('pagehide', () => {
    const s = Storage.getSession();
    if (!s || !room.deploymentUrl || room.deploymentUrl.startsWith('mock://')) return;
    try {
      navigator.sendBeacon(
        room.deploymentUrl,
        JSON.stringify({ action: 'leave', memberId: s.memberId, sessionToken: s.sessionToken })
      );
    } catch { /* ignore */ }
  });
});
