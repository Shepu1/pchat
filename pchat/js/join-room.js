/**
 * SHEPU ROOMS — join-room.js
 * Guest join flow:
 * 1. Read room ID from URL (?r=...)
 * 2. Look up deployment URL from local storage (if owner's device) or prompt
 * 3. Call GET /room on the Apps Script endpoint
 * 4. Show room preview
 * 5. Handle name input → POST /join
 * 6. Redirect to room.html
 */

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(location.search);
  const roomId = params.get('r');

  if (!roomId) {
    showError('Invalid Room Link', 'No room ID found in the URL. Check that you have the correct link.');
    return;
  }

  // ── Check local registry first ────────────────────────────────
  let room = Rooms.getRoom(roomId);

  if (!room) {
    // Try reading from localRoom registry (rooms joined before)
    const joinedRooms = Storage.getRooms().joinedRooms || [];
    room = joinedRooms.find(r => r.id === roomId) || null;
  }

  // ── Resolve deployment URL ─────────────────────────────────────
  // Priority:
  // 1. ?ep= URL parameter (base64url-encoded deploymentUrl) — works for any guest
  // 2. Local storage (owner's device or previously joined)
  // 3. Error
  let deploymentUrl = null;

  const epParam = params.get('ep');
  if (epParam) {
    try {
      // base64url → base64 → string
      const b64 = epParam.replace(/-/g,'+').replace(/_/g,'/') + '=='.slice(0, (4 - epParam.length % 4) % 4);
      deploymentUrl = atob(b64);
    } catch (e) {
      console.warn('Could not decode ep param:', e);
    }
  }

  // ── Room secret from invite link (?k=) — used for E2EE key derivation ──
  let roomSecret = null;
  const kParam = params.get('k');
  if (kParam) {
    try {
      const b64 = kParam.replace(/-/g,'+').replace(/_/g,'/') + '=='.slice(0, (4 - kParam.length % 4) % 4);
      roomSecret = atob(b64);
    } catch (e) {
      console.warn('Could not decode k (room secret) param:', e);
    }
  }

  if (!deploymentUrl && room) {
    deploymentUrl = room.deploymentUrl;
  }

  // Graceful fallback: if no deployment URL, default to mock/local
  if (!deploymentUrl) {
    deploymentUrl = `mock://local/${roomId}`;
  }

  const nameParam = params.get('n') ? decodeURIComponent(params.get('n')) : null;

  // Update local room record with deployment URL if we just learned it
  if (room && !room.deploymentUrl && deploymentUrl) {
    Rooms.updateRoom(roomId, { deploymentUrl });
  }

  // ── Fetch room info from Apps Script ──────────────────────────
  showLoading();
  let roomInfo;
  try {
    const res = await RoomAPI.getRoom(deploymentUrl);
    roomInfo = res && res.room ? res.room : {
      id: roomId,
      name: nameParam || 'Private Room',
      status: 'active'
    };
  } catch (err) {
    // If backend unreachable, still allow joining with name from URL or local room
    roomInfo = {
      id: roomId,
      name: nameParam || (room && room.name) || 'Private Room',
      status: 'active'
    };
  }

  // Check room status
  if (roomInfo.status === 'deleted') {
    showUnavailable('Room Deleted', 'This room has been deleted by the owner.');
    return;
  }

  if (roomInfo.status === 'disabled') {
    showUnavailable('Room Disabled', 'This room is currently unavailable.');
    return;
  }

  // ── Check if already joined ───────────────────────────────────
  const session = Storage.getSession();
  if (session && session.roomId === roomId && session.memberId && session.sessionToken) {
    // Show rejoin card
    showRejoin(roomInfo, session);
    return;
  }

  // ── Show join form ────────────────────────────────────────────
  showJoinForm(roomInfo);

  // ── Join form submit ──────────────────────────────────────────
  document.getElementById('join-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const displayName = document.getElementById('join-name').value.trim();
    if (!displayName) {
      document.getElementById('join-form-error').style.display = '';
      document.getElementById('join-form-error-text').textContent = 'Please enter your display name.';
      return;
    }

    const submitBtn = document.getElementById('join-submit-btn');
    UI.setLoading(submitBtn, true, 'Joining…');
    document.getElementById('join-form-error').style.display = 'none';

    try {
      // Get Google picture if logged in
      const authUser = (typeof Auth !== 'undefined' && Auth.isAuthenticated && Auth.isAuthenticated())
        ? (Auth.getUser ? Auth.getUser() : null)
        : null;
      const picture = authUser?.picture || '';

      const res = await RoomAPI.join(deploymentUrl, { displayName, picture });

      if (!res.success) {
        const msgs = {
          BANNED:   'You have been banned from this room.',
          DISABLED: 'This room is currently disabled.',
          INVALID:  'Invalid request.',
        };
        throw new Error(msgs[res.code] || res.error || 'Join failed');
      }

      // Remember user's display name
      localStorage.setItem('shepu_display_name', displayName);

      // Save session (include roomName for recovery if registry is lost)
      const sessionData = {
        roomId,
        memberId:     res.memberId,
        sessionToken: res.sessionToken,
        displayName:  res.displayName || displayName,
        picture:      picture,
        role:         res.role || 'member',
        joinedAt:     new Date().toISOString(),
        deploymentUrl,
        roomName:     roomInfo.name || 'Private Room',
        roomDesc:     roomInfo.description || '',
        roomSecret:   roomSecret || (room && room.secret) || undefined,
      };

      Storage.setSession(sessionData);
      Storage.setCurrentRoom(roomId);

      // Ensure room is in local registry
      const localRoom = {
        id:          roomId,
        name:        roomInfo.name || 'Private Room',
        description: roomInfo.description || '',
        status:      roomInfo.status || 'active',
        deploymentUrl,
        joinedAt:    sessionData.joinedAt,
        isOwner:     false,
        secret:      roomSecret || (room && room.secret) || undefined,
      };
      Storage.addJoinedRoom(localRoom);

      // Redirect to chat
      window.location.href = `room.html?r=${roomId}`;

    } catch (err) {
      UI.setLoading(submitBtn, false);
      document.getElementById('join-form-error').style.display = '';
      document.getElementById('join-form-error-text').textContent = err.message || 'Join failed.';
    }
  });
});

// ── UI helpers ────────────────────────────────────────────────────

function showLoading() {
  document.getElementById('join-loading').style.display = '';
}

function hideLoading() {
  document.getElementById('join-loading').style.display = 'none';
}

function showError(title, msg) {
  hideLoading();
  const el = document.getElementById('join-error');
  el.style.display = '';
  document.getElementById('join-error-title').textContent = title;
  document.getElementById('join-error-msg').textContent   = msg;
}

function showUnavailable(title, msg) {
  hideLoading();
  const el = document.getElementById('join-unavailable');
  el.style.display = '';
  document.getElementById('unavail-title').textContent = title;
  document.getElementById('unavail-msg').textContent   = msg;
}

function showJoinForm(roomInfo) {
  hideLoading();
  document.getElementById('join-form-card').style.display = '';

  // Room avatar
  const initial = (roomInfo.name || 'R')[0].toUpperCase();
  document.getElementById('join-room-avatar').textContent    = initial;
  document.getElementById('join-room-name').innerHTML      = emoName(roomInfo.name || 'Room');
  document.getElementById('join-room-desc').textContent      = roomInfo.description || 'Private chat room';

  // Status badge
  const badges = document.getElementById('join-room-badges');
  if (roomInfo.status === 'locked') {
    badges.innerHTML = '<span class="badge badge-warning" style="display:inline-flex;align-items:center;gap:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> Locked (read-only)</span>';
  } else {
    badges.innerHTML = '<span class="badge badge-success">● Active</span>';
  }

  // Prefill known display name if available
  const knownName = Storage.getAuth()?.user?.name || localStorage.getItem('shepu_display_name') || '';
  const joinInput = document.getElementById('join-name');
  if (joinInput && knownName) {
    joinInput.value = knownName;
  }

  // Focus name input
  setTimeout(() => {
    if (joinInput) {
      joinInput.focus();
      if (knownName) joinInput.select();
    }
  }, 100);
}

function showRejoin(roomInfo, session) {
  hideLoading();
  // A fresh invite link may carry a newer endpoint/secret (?ep=, ?k=) even
  // when a session already exists — adopt them so the room key never goes stale.
  try {
    const qp = new URLSearchParams(location.search);
    const kP = qp.get('k');
    const epP = qp.get('ep');
    let freshSecret = null;
    let freshDep = null;
    if (kP) {
      try {
        const b64 = kP.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - kP.length % 4) % 4);
        freshSecret = atob(b64) || null;
      } catch {}
    }
    if (epP) {
      try {
        const b64 = epP.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - epP.length % 4) % 4);
        freshDep = atob(b64) || null;
      } catch {}
    }
    let touched = false;
    if (freshSecret && session.roomSecret !== freshSecret) { session.roomSecret = freshSecret; touched = true; }
    if (freshDep && session.deploymentUrl !== freshDep) { session.deploymentUrl = freshDep; touched = true; }
    if (touched) Storage.setSession(session);
    const reg = Rooms.getRoom(session.roomId);
    if (reg) {
      const patch = {};
      if (freshSecret && !reg.secret) patch.secret = freshSecret;
      if (freshDep && reg.deploymentUrl !== freshDep) patch.deploymentUrl = freshDep;
      if (Object.keys(patch).length) { try { Rooms.updateRoom(session.roomId, patch); } catch {} }
    }
  } catch { /* non-critical */ }
  document.getElementById('join-rejoin').style.display = '';
  document.getElementById('rejoin-room-name').innerHTML = emoName(roomInfo.name || 'this room');
  document.getElementById('rejoin-as').textContent = `Joining as: ${session.displayName}`;

  document.getElementById('rejoin-btn').addEventListener('click', () => {
    // Ensure room is in registry before navigating
    const existingRoom = Rooms.getRoom(session.roomId);
    if (!existingRoom) {
      const recoveredRoom = {
        id:           session.roomId,
        name:         roomInfo.name || session.roomName || 'Private Room',
        description:  roomInfo.description || session.roomDesc || '',
        status:       roomInfo.status || 'active',
        deploymentUrl: session.deploymentUrl || `mock://local/${session.roomId}`,
        joinedAt:     session.joinedAt || new Date().toISOString(),
        isOwner:      session.role === 'owner',
        secret:       session.roomSecret || '',
      };
      if (session.role === 'owner') {
        Storage.addMyRoom(recoveredRoom);
      } else {
        Storage.addJoinedRoom(recoveredRoom);
      }
    }
    Storage.setCurrentRoom(session.roomId);
    window.location.href = `room.html?r=${session.roomId}`;
  });

  document.getElementById('rejoin-different-btn').addEventListener('click', () => {
    Storage.clearSession();
    showJoinForm(roomInfo);
    document.getElementById('join-rejoin').style.display = 'none';
  });
}
