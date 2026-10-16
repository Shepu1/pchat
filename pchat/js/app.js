/**
 * SHEPU ROOMS — app.js
 * Main entry point for room.html.
 * Orchestrates: session validation → room load → initial messages → sync loop → presence.
 */

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
  let urlDeployment = null;
  try {
    const epParam = params.get('ep');
    if (epParam) {
      const b64 = epParam.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - epParam.length % 4) % 4);
      urlDeployment = atob(b64) || null;
    }
  } catch { urlDeployment = null; }
  // Room theme (?th=) — public wallpaper digit shared via invite link.
  // Null when absent so stored session/registry themes are never clobbered.
  let urlTheme = null;
  try {
    const thP = params.get('th');
    if (thP && typeof RoomTheme !== 'undefined') urlTheme = RoomTheme.normalize(thP);
  } catch { urlTheme = null; }
  // Room display name (?n=) + kind (?rt=saved|quick) from the invite link.
  // Guests on a fresh device have no registry row, so the link is the only
  // source of truth — without this they see a bare 'Private Room'.
  let urlRoomName = null;
  try {
    const nP = params.get('n');
    if (nP) urlRoomName = decodeURIComponent(nP) || null;
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
        memberId:     'u_owner_' + roomId.slice(0, 8),
        sessionToken: 'owner_sess_' + (myRoom.secret || roomId),
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
        // No valid session for this room — go to join
        window.location.href = `join.html?r=${roomId}`;
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
  } catch { /* non-critical */ }
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
  document.title = `${room.name} — Pchat shepu`;
  const titleEl = document.getElementById('room-title');
  const paintTitle = (n) => { if (titleEl) titleEl.innerHTML = emoName(n); };
  paintTitle(room.name);
  // Room profile icon: saved.webp for sheet rooms, quick.webp otherwise.
  try {
    const avImg = document.getElementById('room-avatar');
    if (avImg) {
      const icon = (typeof Rooms !== 'undefined' && Rooms.roomIcon)
        ? Rooms.roomIcon(room, room.kind || urlRoomKind)
        : ((room.spreadsheetId || room.kind === 'saved' || urlRoomKind === 'saved') ? 'assets/icons/saved.webp' : 'assets/icons/quick.webp');
      avImg.src = icon;
      avImg.alt = room.name || 'Room';
      avImg.onerror = () => { try { avImg.style.display = 'none'; } catch {} };
    }
  } catch {}
  // Repaint once custom emoji arrive (room names may lead with emoji)
  try {
    if (typeof CustomEmoji !== 'undefined') {
      CustomEmoji.load().then(() => paintTitle(room.name)).catch(() => {});
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
  Chat.init(room, session);

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
      try { if (typeof window.updateKeyBanner === 'function') window.updateKeyBanner(); } catch {}
    }
  } catch { /* non-critical */ }

  // ── Load messages directly from Google Sheet if valid Google token is present ──
  try {
    if (room.spreadsheetId && typeof Auth !== 'undefined' && Auth.hasGoogleToken && Auth.hasGoogleToken()) {
      const sheetMsgs = await Chat.loadSheetMessages();
      if (sheetMsgs && sheetMsgs.length) {
        Chat.appendMessages(sheetMsgs);
      try { if (typeof window.updateKeyBanner === 'function') window.updateKeyBanner(); } catch {}
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
      const code = joinRes.code;
      if (code === 'DISABLED') { Chat.showUnavailable('This room is currently disabled.'); return; }
      if (code === 'DELETED')  { Chat.showUnavailable('This room has been deleted.'); return; }
      if (code === 'BANNED')   { Chat.showUnavailable('You have been banned from this room.'); return; }

      // Persist fresh session token
      const updatedSession = {
        ...session,
        sessionToken: joinRes.sessionToken || session.sessionToken,
        role:         joinRes.role || session.role,
      };
      Storage.setSession(updatedSession);
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
        try { if (typeof window.updateKeyBanner === 'function') window.updateKeyBanner(); } catch {}
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
  try {
    const sec = session.roomSecret || room.secret || urlRoomSecret;
    if (sec && typeof InstantSecurity !== 'undefined' && !/[#&]k=/.test(window.location.hash || '')) {
      const frag = (window.location.hash ? window.location.hash + '&' : '#') + 'k=' + InstantSecurity.b64urlEncode(sec);
      history.replaceState(null, '', window.location.pathname + window.location.search + frag);
    }
  } catch { /* non-critical */ }

  // ── Locked-message banner (only when actually needed) ──────────
  // Shows a paste-link box IFF the feed holds enc: messages nobody here can
  // decrypt (no active key) — e.g. owner enabled passphrase-E2EE. Normal
  // readable chat never triggers it. Also covers browsers WITHOUT WebCrypto
  // (http:// LAN, some in-app WebViews): those can NEVER decrypt.
  // Global so message handlers below can re-check after every batch.
  window.updateKeyBanner = function () {
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
            ? '🔒 <strong>Locked messages?</strong> This page is on insecure <strong>http://</strong> — browsers disable decryption here. Open the <strong>https://</strong> link of this site (e.g. GitHub Pages) in Chrome instead.'
            : '🔒 <strong>Locked messages?</strong> This browser (in-app viewer?) cannot decrypt messages. Please open this room in <strong>Chrome</strong> and paste the full invite link below.';
        }
      }
      keyBanner.classList.toggle('hidden', !needsKey);
    } catch { /* non-critical */ }
  };
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
      roomSecret: session.roomSecret || room.secret || urlRoomSecret || null,
      isHost:      session.role === 'owner',
      memberId:    session.memberId,
      displayName: session.displayName,
      onMessage: async (msgs) => {
        Chat.appendMessages(msgs);
          try { if (typeof window.updateKeyBanner === 'function') window.updateKeyBanner(); } catch {}
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
      roomSecret: session.roomSecret || room.secret || urlRoomSecret || null,
      onEvent: ({ kind, msg, member, theme }) => {
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
          try { if (typeof window.updateKeyBanner === 'function') window.updateKeyBanner(); } catch {}
          try {
            if (typeof IDBStorage !== 'undefined') {
              IDBStorage.putMessages([{ ...msg, roomId: room.id }]).catch(() => {});
            }
            if (typeof Storage !== 'undefined' && Storage.saveRoomMessages) {
              Storage.saveRoomMessages(room.id, [msg]);
            }
          } catch { /* non-critical */ }
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
  if (typeof Notify !== 'undefined') {
    Notify.init({
      memberId: session.memberId,
      displayName: session.displayName,
      roomName: room.name || 'Chat',
    });
  }

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
