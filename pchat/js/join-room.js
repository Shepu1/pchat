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

  // ── Room theme (?th=) — public wallpaper digit, default 1 ──────
  // Null when absent so a stored registry theme is never clobbered.
  let inviteTheme = null;
  try {
    const thP = params.get('th');
    if (thP && typeof RoomTheme !== 'undefined') inviteTheme = RoomTheme.normalize(thP);
  } catch { inviteTheme = null; }

  // ── Room secret from invite link (#k= new, ?k= legacy) — E2EE key ──
  // Fragment (#k=) is preferred: it never reaches servers/logs.
  let roomSecret = null;
  try {
    roomSecret = (typeof InstantSecurity !== 'undefined')
      ? InstantSecurity.getInviteSecret()
      : null;
  } catch { roomSecret = null; }
  if (!roomSecret) {
    const kParam = params.get('k');
    if (kParam) {
      try {
        const b64 = kParam.replace(/-/g,'+').replace(/_/g,'/') + '=='.slice(0, (4 - kParam.length % 4) % 4);
        roomSecret = atob(b64);
      } catch (e) {
        console.warn('Could not decode k (room secret) param:', e);
      }
    }
  }
  // Legacy ?k= links still work (getInviteSecret reads them too) — but the
  // secret must not linger in history/logs, so strip it unconditionally now.
  try {
    if (params.has('k')) {
      params.delete('k');
      const qs = params.toString();
      history.replaceState(null, '', window.location.pathname + (qs ? '?' + qs : '') + window.location.hash);
    }
  } catch {}

  if (!deploymentUrl && room) {
    deploymentUrl = room.deploymentUrl;
  }

  // Graceful fallback: if no deployment URL, default to mock/local
  if (!deploymentUrl) {
    deploymentUrl = `mock://local/${roomId}`;
  }

  // URLSearchParams.get() already percent-decodes once; decoding again broke names containing '%'.
  const nameParam = params.get('n') || null;
  // Password-locked rooms advertise `&pw=1` in the link (no key material).
  const pwParam = params.get('pw') === '1';
  // Room kind (?rt=saved|quick) tells the join card which profile icon to show.
  const kindParam = params.get('rt') === 'saved' ? 'saved' : (params.get('rt') === 'quick' ? 'quick' : null);

  // Update local room record with deployment URL if we just learned it
  if (room && !room.deploymentUrl && deploymentUrl) {
    Rooms.updateRoom(roomId, { deploymentUrl });
  }

  // ── Fetch room info from Apps Script ──────────────────────────
  showLoading();
  let roomInfo;
  // True only when the backend actually answered with a room object; an
  // unreachable backend must never be treated as "password removed".
  let roomInfoTrusted = false;
  try {
    const res = await RoomAPI.getRoom(deploymentUrl);
    roomInfo = res && res.room ? res.room : {
      id: roomId,
      name: nameParam || 'Private Room',
      status: 'active'
    };
    roomInfoTrusted = !!(res && res.room);
  } catch (err) {
    // If backend unreachable, still allow joining with name from URL or local room
    roomInfo = {
      id: roomId,
      name: nameParam || (room && room.name) || 'Private Room',
      status: 'active'
    };
  }

  // The invite link name (?n=) wins over a blank/'Private Room' backend
  // answer — for quick rooms on a guest's device the backend has no row and
  // would otherwise stomp the real name guests should see.
  if ((!roomInfo.name || roomInfo.name === 'Private Room') && nameParam) {
    roomInfo.name = nameParam;
  }
  // Local registry is the next-best source (rejoin on same device).
  if ((!roomInfo.name || roomInfo.name === 'Private Room') && room && room.name && room.name !== 'Private Room') {
    roomInfo.name = room.name;
  }
  // Room kind for the profile icon: link param → backend → registry.
  roomInfo.kind = kindParam
    || (roomInfo.spreadsheetId ? 'saved' : null)
    || ((room && room.spreadsheetId) ? 'saved' : null)
    || 'quick';
  // Password lock: server flag is authoritative; `&pw=1` covers quick rooms
  // whose backend (guest's own mock row) cannot know the lock state.
  roomInfo.passwordLocked = roomInfo.passwordLocked === true || pwParam === true;

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
    // A newly locked room invalidates keyless sessions: force a fresh join
    // (with password) instead of sailing into a room we cannot read.
    try {
      const needsPw = roomInfo.passwordLocked === true
        && typeof RoomPassword !== 'undefined' && !RoomPassword.hasStored(roomId);
      if (needsPw) {
        Storage.clearSession();
        showJoinForm(roomInfo);
        return;
      }
    } catch {}
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
      // Effective picture: manual Settings photo → Google photo → ''
      const picture = (typeof UI !== 'undefined' && UI.effectivePicture)
        ? UI.effectivePicture()
        : (authUser?.picture || '');

      // Password-locked rooms: derive the key FIRST (stays on this device),
      // then prove knowledge with a hash — the password itself never travels.
      let passwordHash = '';
      if (roomInfo.passwordLocked === true) {
        const pwEl = document.getElementById('join-password');
        const pw = (pwEl && pwEl.value) || '';
        if (!pw) throw new Error('This room needs a password — ask the owner.');
        try {
          await RoomPassword.deriveAndStore(roomId, pw);
          passwordHash = await RoomPassword.hashForServer(roomId, pw);
        } catch (err) {
          throw new Error((err && err.message) || 'Password setup failed.');
        }
        try { if (pwEl) pwEl.value = ''; } catch {}
      }

      const res = await RoomAPI.join(deploymentUrl, { displayName, picture, passwordHash });

      if (!res.success) {
        const msgs = {
          BANNED:   'You have been banned from this room.',
          DISABLED: 'This room is currently disabled.',
          INVALID:  'Invalid request.',
          PASSWORD_REQUIRED: 'This room needs a password.',
          WRONG_PASSWORD:    'Wrong room password — try again.',
          RATE_LIMITED: 'Too many attempts — wait a minute and retry.',
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
        roomKind:     roomInfo.kind || kindParam || 'quick',
        passwordLocked: roomInfo.passwordLocked === true,
        roomSecret:   roomSecret || (room && room.secret) || undefined,
        theme:        inviteTheme || (room && room.theme) || 1,
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
        kind:        roomInfo.kind || kindParam || 'quick',
        passwordLocked: roomInfo.passwordLocked === true,
        secret:      roomSecret || (room && room.secret) || undefined,
        theme:       inviteTheme || (room && room.theme) || 1,
      };
      Storage.addJoinedRoom(localRoom);

      // Redirect to chat — FORWARD the full invite params (r/ep/n/th/k + #k=)
      // so room.html can recover the key even if session save hiccups.
      // (This is the "URL crop" users notice; the key travels in session AND url.)
      window.location.href = `room.html${window.location.search || `?r=${roomId}`}${window.location.hash || ''}`;

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

// Decide the registry's passwordLocked flag after reading the room.
// A link (&pw=1) or the backend saying "locked" means locked. Only a
// *trusted* backend answer may clear a stale lock — an unreachable backend
// must never silently unlock a room we cannot verify.
function passwordLockPatch(regLocked, infoLocked, infoTrusted, pwFlag) {
  if (pwFlag === true || infoLocked === true) return true;
  if (infoTrusted) return false;
  return !!regLocked;
}

// Early-warning badge text for an invite that carries no key. Password rooms
// intentionally ship no key material (the password derives it), so telling
// those users "no key in link" sent them chasing a link that cannot have one.
function inviteKeyWarning(hasKey, passwordLocked) {
  if (hasKey) return '';
  return passwordLocked
    ? '🔒 Password protected — enter the room password'
    : '⚠ No key in link — ask owner for the FULL invite link';
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

  // Locked rooms demand the password field.
  try {
    const pwGroup = document.getElementById('join-pw-group');
    if (pwGroup) pwGroup.classList.toggle('hidden', roomInfo.passwordLocked !== true);
  } catch {}

  // Room avatar — saved.webp for sheet rooms, quick.webp otherwise.
  // Letter stays behind as fallback; image covers it, removes itself on error.
  const initial = (roomInfo.name || 'R')[0].toUpperCase();
  const avEl = document.getElementById('join-room-avatar');
  avEl.textContent = initial;
  try {
    const icon = (typeof Rooms !== 'undefined' && Rooms.roomIcon)
      ? Rooms.roomIcon(roomInfo, roomInfo.kind)
      : (roomInfo.kind === 'saved'
        ? 'assets/icons/saved.webp'
        : ((typeof Rooms !== 'undefined' && Rooms.quickIconFor)
          ? Rooms.quickIconFor(roomInfo)
          : 'assets/icons/quick.webp'));
    const img = document.createElement('img');
    img.src = icon;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:20px;';
    img.onerror = () => { try { img.remove(); } catch {} };
    avEl.style.position = 'relative';
    avEl.style.overflow = 'hidden';
    avEl.appendChild(img);
  } catch {}
  document.getElementById('join-room-name').innerHTML      = emoName(roomInfo.name || 'Room');
  document.getElementById('join-room-desc').textContent      = roomInfo.description || 'Private chat room';

  // Status badge
  const badges = document.getElementById('join-room-badges');
  if (roomInfo.status === 'locked') {
    badges.innerHTML = '<span class="badge badge-warning" style="display:inline-flex;align-items:center;gap:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> Locked (read-only)</span>';
  } else {
    badges.innerHTML = '<span class="badge badge-success">● Active</span>';
  }
  // Early warning: this invite carries NO room key (fragment stripped or
  // partial link). Joining anyway means locked messages — tell them now.
  // Password rooms are the exception: their links never carry a key.
  try {
    const storedSecret = (room && room.secret) ? room.secret : null;
    const warning = inviteKeyWarning(!!roomSecret || !!storedSecret, roomInfo.passwordLocked === true);
    if (warning && badges) {
      badges.innerHTML += ' <span class="badge badge-warning">' + warning + '</span>';
    }
  } catch {}

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
    const epP = qp.get('ep');
    let freshSecret = null;
    let freshDep = null;
    try {
      freshSecret = (typeof InstantSecurity !== 'undefined')
        ? InstantSecurity.getInviteSecret()
        : null;
    } catch {}
    if (!freshSecret) {
      const kP = qp.get('k');
      if (kP) {
        try {
          const b64 = kP.replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - kP.length % 4) % 4);
          freshSecret = atob(b64) || null;
        } catch {}
      }
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
    // A fresh invite may also carry a truer room name (?n=) / kind (?rt=):
    // adopt them when the stored ones are blank or still 'Private Room'.
    try {
      const nP = qp.get('n') || null; // already decoded by URLSearchParams
      if (nP && (!session.roomName || session.roomName === 'Private Room') && (!roomInfo || !roomInfo.name || roomInfo.name === 'Private Room')) {
        session.roomName = nP;
        if (roomInfo) roomInfo.name = nP;
        touched = true;
      } else if (roomInfo && roomInfo.name && roomInfo.name !== 'Private Room' && session.roomName !== roomInfo.name) {
        session.roomName = roomInfo.name;
        touched = true;
      }
      const rtP = qp.get('rt');
      if ((rtP === 'saved' || rtP === 'quick') && session.roomKind !== rtP) {
        session.roomKind = rtP;
        if (roomInfo) roomInfo.kind = rtP;
        touched = true;
      }
    } catch {}
    try {
      const thP = qp.get('th');
      if (thP && typeof RoomTheme !== 'undefined' && !session.theme) {
        // Adopt link theme only when nothing stored yet — explicit picks win.
        session.theme = RoomTheme.normalize(thP);
        touched = true;
      }
    } catch {}
    if (touched) Storage.setSession(session);
    const reg = Rooms.getRoom(session.roomId);
    if (reg) {
      const patch = {};
      // A fresh invite link is authoritative: after the owner rotates the
      // link, a rejoin must adopt the new secret instead of keeping the
      // stale registry copy (which caused unreadable history + old topic).
      if (freshSecret && reg.secret !== freshSecret) patch.secret = freshSecret;
      if (freshDep && reg.deploymentUrl !== freshDep) patch.deploymentUrl = freshDep;
      if ((!reg.name || reg.name === 'Private Room') && session.roomName && session.roomName !== 'Private Room') patch.name = session.roomName;
      if (!reg.kind && session.roomKind) patch.kind = session.roomKind;
      // Owner may have removed the password: clear the stale flag so rejoin
      // stops prompting forever. Uses all four signals (link/backend/trust).
      const desiredLocked = passwordLockPatch(reg.passwordLocked, roomInfo.passwordLocked, roomInfoTrusted, pwParam);
      if (desiredLocked !== !!reg.passwordLocked) patch.passwordLocked = desiredLocked;
      try {
        const thP = qp.get('th');
        if (thP && typeof RoomTheme !== 'undefined' && !reg.theme) patch.theme = RoomTheme.normalize(thP);
      } catch {}
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
        theme:        session.theme || 1,
      };
      if (session.role === 'owner') {
        Storage.addMyRoom(recoveredRoom);
      } else {
        Storage.addJoinedRoom(recoveredRoom);
      }
    }
    Storage.setCurrentRoom(session.roomId);
    // Forward full invite params (see note above) so the key survives.
    window.location.href = `room.html${window.location.search || `?r=${session.roomId}`}${window.location.hash || ''}`;
  });

  document.getElementById('rejoin-different-btn').addEventListener('click', () => {
    Storage.clearSession();
    showJoinForm(roomInfo);
    document.getElementById('join-rejoin').style.display = 'none';
  });
}
