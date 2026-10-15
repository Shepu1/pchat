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
  // Room secret / endpoint may arrive via invite params (?k=, ?ep=), e.g.
  // when room.html is opened directly from a shared link. Decode once here
  // so session + registry can be patched even if join.html was skipped.
  let urlRoomSecret = null;
  try {
    const kParam = params.get('k');
    if (kParam) {
      const b64 = kParam.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - kParam.length % 4) % 4);
      urlRoomSecret = atob(b64) || null;
    }
  } catch { urlRoomSecret = null; }
  let urlDeployment = null;
  try {
    const epParam = params.get('ep');
    if (epParam) {
      const b64 = epParam.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - epParam.length % 4) % 4);
      urlDeployment = atob(b64) || null;
    }
  } catch { urlDeployment = null; }

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
      const ownerPicture = authUser.picture || '';
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
        const authUser2 = Storage.getAuth()?.user || {};
        session = {
          roomId,
          memberId:     'u_' + Date.now().toString(36),
          sessionToken: 'member_sess_' + Date.now(),
          displayName:  knownName,
          picture:      authUser2.picture || '',
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

  // Patch a valid session with a fresher secret/endpoint from the invite URL.
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
      if (patched) Storage.setSession(session);
    }
  } catch { /* non-critical */ }

  // ── Recover room from registry OR rebuild from session ────────
  let room = Rooms.getRoom(roomId);

  if (!room) {
    // Room not in registry but session is valid — reconstruct from session
    room = {
      id:            roomId,
      name:          session.roomName || 'Private Room',
      description:   session.roomDesc || '',
      status:        'active',
      deploymentUrl: session.deploymentUrl || `mock://local/${roomId}`,
      isOwner:       session.role === 'owner',
      createdAt:     session.joinedAt || new Date().toISOString(),
      secret:        session.roomSecret || urlRoomSecret || '',
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

  // ── Populate header ───────────────────────────────────────────
  document.title = `${room.name} — Pchat shepu`;
  const titleEl = document.getElementById('room-title');
  const paintTitle = (n) => { if (titleEl) titleEl.innerHTML = emoName(n); };
  paintTitle(room.name);
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
    }
  } catch { /* non-critical */ }

  // ── Load messages directly from Google Sheet if valid Google token is present ──
  try {
    if (room.spreadsheetId && typeof Auth !== 'undefined' && Auth.hasGoogleToken && Auth.hasGoogleToken()) {
      const sheetMsgs = await Chat.loadSheetMessages();
      if (sheetMsgs && sheetMsgs.length) {
        Chat.appendMessages(sheetMsgs);
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

  // ── Background room key (decrypt-only) ──────────────────────────
  // New messages are sent as plaintext so guests NEVER need a passphrase.
  // The invite-link room key is derived only to read OLD enc: history,
  // then already-rendered placeholders are retried.
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
      }
    } else if (typeof Encryption !== 'undefined' && Encryption.isManual
               && Encryption.isManual()
               && typeof Chat !== 'undefined' && Chat.setEncryptionStatus) {
      Chat.setEncryptionStatus(true);
    }
  } catch (err) {
    console.warn('[app] Could not initialize encryption:', err && err.message);
  }

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

  // ── Presence heartbeat ────────────────────────────────────────
  Presence.start({
    roomId:       roomId,
    endpointUrl:  room.deploymentUrl,
    memberId:     session.memberId,
    sessionToken: session.sessionToken,
    onMembersUpdate: (members) => Chat.renderMembers(members),
  });

  // ── P2P Real-time WebRTC Mesh (PeerJS) ────────────────────────
  if (typeof P2PSync !== 'undefined') {
    P2PSync.init({
      roomId:      room.id,
      isHost:      session.role === 'owner',
      memberId:    session.memberId,
      displayName: session.displayName,
      onMessage: async (msgs) => {
        Chat.appendMessages(msgs);
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

  // ── Ntfy cloud history + realtime relay (Instant room resilience) ──
  // Keeps messages flowing (and gives new joiners history) even when the
  // host's browser is offline. Harmless for Secure rooms (Apps Script also polls).
  if (typeof NtfySync !== 'undefined') {
    NtfySync.init({
      roomId: room.id,
      onEvent: ({ kind, msg, member }) => {
        if (kind === 'message' && msg) {
          // Skip our own messages (we already appended them optimistically)
          if (msg.senderId && msg.senderId === session.memberId) return;
          // Skip messages we've already rendered via P2P / sync
          if (typeof Chat.getMessages === 'function') {
            const already = Chat.getMessages().some(m => m.id === msg.id);
            if (already) return;
          }
          Chat.appendMessages([msg]);
          try {
            if (typeof IDBStorage !== 'undefined') {
              IDBStorage.putMessages([{ ...msg, roomId: room.id }]).catch(() => {});
            }
            if (typeof Storage !== 'undefined' && Storage.saveRoomMessages) {
              Storage.saveRoomMessages(room.id, [msg]);
            }
          } catch { /* non-critical */ }
        }
      },
    });
    NtfySync.start();
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
      if (qrImg)      qrImg.src = urls.qrCodeUrl;
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
