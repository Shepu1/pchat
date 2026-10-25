/**
 * SHEPU ROOMS — create-room.js
 * Orchestrates the full room creation flow:
 * 1. Validate form
 * 2. Ensure Google auth
 * 3. Find/create Drive folder
 * 4. Create Google Sheet
 * 5. Initialize sheet tabs
 * 6. Create + deploy Apps Script (automatic)
 *    → fallback to manual wizard if API blocked
 * 7. Save room to local registry
 * 8. Show success card
 */

document.addEventListener('DOMContentLoaded', () => {
  const form         = document.getElementById('create-form');
  const nameInput    = document.getElementById('room-name');
  const descInput    = document.getElementById('room-description');
  const nameCount    = document.getElementById('room-name-count');
  const createBtn    = document.getElementById('create-btn');
  const errorEl      = document.getElementById('create-error');
  const errorText    = document.getElementById('create-error-text');

  let createdRoom    = null;  // The final room object
  let roomMode       = 'instant';  // 'instant' (P2P) | 'secure' (Google Sheet)

  // ── Connection Mode selector (Quick P2P vs Saved Sheet-backup) ──
  const modeBtns = document.querySelectorAll('#room-mode-picker .room-mode-btn');
  const modeHint = document.getElementById('mode-hint');
  const MODE_HINTS = {
    instant: 'Quick rooms connect directly peer-to-peer — no sign-in, no cloud backup.',
    secure:  'Saved rooms auto-save every message to a Google Sheet in your Drive. Google sign-in required.',
  };
  const sheetCard = document.getElementById('sheet-integration-card');
  const syncSheetCard = () => {
    if (sheetCard) sheetCard.style.display = (roomMode === 'secure') ? 'block' : 'none';
  };
  syncSheetCard();

  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      roomMode = btn.dataset.mode;
      modeBtns.forEach(b => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        // Thin, soft accent edge for the selected mode (no heavy ring).
        b.style.background  = isActive ? 'rgba(99,102,241,0.10)' : 'var(--surface-2)';
        b.style.borderColor = isActive ? 'rgba(99,102,241,0.45)' : 'var(--border)';
      });
      if (modeHint) modeHint.textContent = MODE_HINTS[roomMode] || '';
      syncSheetCard();
    });
  });

  // ── Character count ──────────────────────────────────────────
  nameInput.addEventListener('input', () => {
    nameCount.textContent = `${nameInput.value.length} / 80`;
  });

  // ── Copy Apps Script Code button ──────────────────────────────
  const copyScriptBtn = document.getElementById('btn-copy-apps-script-code');
  if (copyScriptBtn) {
    copyScriptBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('apps-script/Code.gs');
        const code = await res.text();
        const ok = await UI.copyText(code);
        if (!ok) throw new Error('Clipboard access was blocked. Select and copy the code manually.');
        UI.toast('success', 'Copied', 'Apps Script code copied to clipboard!');
      } catch (err) {
        UI.toast('error', 'Copy failed', err.message || 'Could not copy code.');
      }
    });
  }

  // ── Form submit ───────────────────────────────────────────────
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.style.display = 'none';

    let roomName = nameInput.value.trim();
    const roomDesc = descInput.value.trim();

    if (!roomName) {
      errorEl.style.display = '';
      errorText.textContent = 'Room name is required.';
      nameInput.focus();
      return;
    }

    // Show progress
    document.getElementById('step-form').style.display     = 'none';
    document.getElementById('step-progress').style.display = '';

    if (window.UI?.initStepIcons) UI.initStepIcons();

    try {
      createdRoom = await createRoom(roomName, roomDesc);
      if (!createdRoom) {
        // Name prompt cancelled — back to the form, no error.
        document.getElementById('step-progress').style.display = 'none';
        document.getElementById('step-form').style.display     = '';
        return;
      }
      showSuccess(createdRoom);
    } catch (err) {
      console.error('Room creation failed:', err);
      // In Saved mode, never silently fall back to Quick — surface the error
      // and return the user to the form so they can retry or switch mode.
      if (roomMode === 'secure') {
        document.getElementById('step-progress').style.display = 'none';
        document.getElementById('step-form').style.display     = '';
        errorEl.style.display = '';
        errorText.textContent = err.message || 'Saved room creation failed. Please try again.';
        if (window.UI?.toast) UI.toast('error', 'Saved room failed', err.message || 'Please try again.');
        return;
      }
      // Fallback (Quick mode): create instant room immediately
      createdRoom = Rooms.createInstantRoom(roomName, roomDesc);
      showSuccess(createdRoom);
    }
  });

  // ── Main creation flow ────────────────────────────────────────
  async function createRoom(roomName, roomDesc) {
    // One rule (all modes): logged-in → Gmail name; logged-out → one-time
    // name prompt. Null = user cancelled → abort quietly (caller shows form).
    let ownerDisplayName = await UI.resolveDisplayName();
    if (!ownerDisplayName) return null;

    const customScriptUrl = document.getElementById('custom-script-url')?.value?.trim();
    if (customScriptUrl && !isAllowedEndpoint(customScriptUrl)) {
      // A backend URL that does not match was dropped without a message and
      // the room was created on the mock endpoint — the invite link then
      // pointed nowhere. Tell the owner instead.
      showProgressError('That Apps Script URL does not look right. It must start with https://script.google.com/ (or https://script.googleusercontent.com/).');
      throw new Error('Invalid custom Apps Script URL');
    }
    if (customScriptUrl && isAllowedEndpoint(customScriptUrl)) {
      const roomId = Rooms.generateRoomId();
      const roomSecret = Rooms.generateRoomSecret();
      const now = new Date().toISOString();
      const room = {
        id: roomId,
        secret: roomSecret,
        name: roomName,
        description: roomDesc,
        status: 'active',
        createdAt: now,
        isOwner: true,
        deploymentUrl: customScriptUrl,
        theme: (typeof RoomTheme !== 'undefined') ? RoomTheme.pick() : 1,
      };
      Rooms.addMyRoom(room);

      // The owner credential is random and device-local (see
      // Rooms.ensureOwnerToken). The memberId length must match the one
      // used everywhere else (rooms.js / app.js use 6 chars) — a mismatch
      // creates a duplicate owner row and a session the backend rejects.
      const memberId = 'u_owner_' + roomId.slice(0, 6);
      const ownerToken = Rooms.ensureOwnerToken(room);
      Storage.setSession({
        roomId,
        memberId,
        sessionToken: ownerToken,
        displayName:  ownerDisplayName,
        role:         'owner',
        joinedAt:     now,
        deploymentUrl: customScriptUrl,
        roomName:     roomName,
        roomDesc:     roomDesc,
        roomSecret:   roomSecret,
        theme:        room.theme,
        picture:      ((typeof UI !== 'undefined' && UI.effectivePicture) ? UI.effectivePicture() : ''),
      });
      Storage.setCurrentRoom(roomId);
      localStorage.setItem('shepu_display_name', ownerDisplayName);

      return room;
    }

    // ── Quick (P2P) mode — no Google sign-in required ──
    if (roomMode === 'instant') {
      await sleep(150);
      // ps-* progress steps only exist on some pages; UI.setStep no-ops safely.
      setStep('ps-auth', 'done');
      setStep('ps-folder', 'done');
      setStep('ps-sheet', 'done');
      setStep('ps-tabs', 'done');
      setStep('ps-script', 'done');
      setStep('ps-deploy', 'done');
      setStep('ps-link', 'done');
      return Rooms.createInstantRoom(roomName, roomDesc);
    }

    // ── Saved (Sheet backup) mode — requires Google sign-in ──
    setStep('ps-auth', 'active');
    console.log('[createRoom] secure flow: auth check…');
    // Per-step timeout so a stuck Google call becomes a VISIBLE error
    // instead of a dead button. googleStep() lives in rooms.js (loaded above).
    const step = (typeof googleStep === 'function')
      ? googleStep
      : (p) => p;
    let auth = Storage.getAuth() || {};

    if (!CONFIG.isGoogleConfigured()) {
      showProgressError('Saved mode needs a Google Client ID. Configure it in Settings, or switch to Quick mode.');
      throw new Error('Google Client ID not configured');
    }

    // Prompt Google sign-in if we have no usable Google token.
    // isAuthenticated() is also true for email/demo logins, which have no
    // Google token at all — the Drive call then failed with a 401 and an
    // unsolicited OAuth popup.
    const hasGoogleToken = () => {
      if (typeof Auth === 'undefined') return false;
      if (typeof Auth.hasGoogleToken === 'function') return !!Auth.hasGoogleToken();
      return false;
    };
    if (!hasGoogleToken()) {
      try {
        console.log('[createRoom] secure flow: requesting Google sign-in…');
        await step(Auth.signIn(), 180000, 'Google sign-in');
        auth = Storage.getAuth() || {};
      } catch (err) {
        showProgressError('Google sign-in is required for Saved rooms: ' + err.message);
        throw err;
      }
    }

    const hasGoogle = CONFIG.isGoogleConfigured() && hasGoogleToken();

    if (!hasGoogle) {
      showProgressError('Google sign-in is required for Saved rooms. Please try again or switch to Quick mode.');
      throw new Error('Google sign-in required for Saved rooms');
    }

    setStep('ps-auth', 'done');

    // Login just happened (or already authed) → Gmail name wins over the
    // one-time prompt name, per the one-name rule.
    ownerDisplayName = Storage.getAuth()?.user?.name || ownerDisplayName;

    // Step: Folder
    setStep('ps-folder', 'active');
    console.log('[createRoom] secure flow: Drive folder…');
    let folderId;
    try {
      folderId = await step(Drive.getOrCreateFolder(), 30000, 'Drive folder তৈরি');
    } catch (err) {
      setStep('ps-folder', 'error');
      showProgressError('Failed to create Drive folder: ' + err.message);
      throw err;
    }
    setStep('ps-folder', 'done');

    // Step: Sheet
    setStep('ps-sheet', 'active');
    console.log('[createRoom] secure flow: create spreadsheet…');
    let spreadsheetFile;
    try {
      const sheetName = `${CONFIG.SHEET_PREFIX}${roomName}`;
      spreadsheetFile = await step(Drive.createSpreadsheet(sheetName, folderId), 30000, 'Sheet তৈরি');
    } catch (err) {
      setStep('ps-sheet', 'error');
      showProgressError('Failed to create Google Sheet: ' + err.message);
      throw err;
    }
    setStep('ps-sheet', 'done');

    const spreadsheetId = spreadsheetFile.id;

    // Generate room credentials
    const roomId     = Rooms.generateRoomId();
    const roomSecret = Rooms.generateRoomSecret();
    const now        = new Date().toISOString();
    const ownerUser  = auth?.user || {};
    const ownerId    = ownerUser.sub || ownerUser.email || ownerUser.name || 'owner';

    // Step: Initialize tabs
    setStep('ps-tabs', 'active');
    const roomConfigData = {
      room_id:                   roomId,
      room_name:                 roomName,
      description:               roomDesc,
      owner_id:                  ownerId,
      created_at:                now,
      room_status:               'active',
      config_version:            '1',
      deployment_url:            '',  // filled after deploy
    };

    try {
      await step(Sheets.initializeSpreadsheet(spreadsheetId, roomConfigData), 60000, 'Sheet ট্যাব তৈরি');
    } catch (err) {
      setStep('ps-tabs', 'error');
      showProgressError('Failed to initialize sheet tabs: ' + err.message);
      throw err;
    }
    setStep('ps-tabs', 'done');

    // Step: Backend — P2P mesh + automatic Sheet backup (ZERO user setup).
    // Programmatic Apps Script deploy is intentionally SKIPPED: it forces EVERY
    // room owner to flip a per-account toggle (script.google.com/home/usersettings),
    // which normal users will never do. Chat runs on the P2P mesh (mock endpoint)
    // and the owner's device auto-logs every message to the Sheet
    // (see Chat.appendMessages sheet-backup hook). No per-user toggles needed.
    setStep('ps-script', 'active');
    setStep('ps-deploy', 'active');
    console.log('[createRoom] secure flow: sheet-backup mode (deploy skipped by design)…');
    let deploymentUrl = `mock://local/${roomId}`;
    setStep('ps-script', 'done');
    setStep('ps-deploy', 'done');

    // Record the backup backend in sheet config (best-effort)
    try {
      await step(Sheets.updateRoomConfigKey(spreadsheetId, 'deployment_url', deploymentUrl), 30000, 'Sheet config update');
      await step(Sheets.updateRoomConfigKey(spreadsheetId, 'backend_mode', 'sheet-backup'), 30000, 'Sheet config update');
    } catch (e) { /* non-critical */ }

    // NOTE: programmatic Apps Script deploy was removed on purpose (it needs a
    // per-account toggle from every owner). Owners who want the advanced
    // server-side backend can deploy manually in the Apps Script editor and
    // paste the URL in the "custom script URL" box (handled at flow start).

    // Step: Generate link
    setStep('ps-link', 'active');
    const roomTheme = (typeof RoomTheme !== 'undefined') ? RoomTheme.pick() : 1;
    const room = {
      id:              roomId,
      secret:          roomSecret,
      name:            roomName,
      description:     roomDesc,
      spreadsheetId,
      sheetUrl:        `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      backendMode:     'google-sheets',
      status:          'active',
      createdAt:       now,
      isOwner:         true,
      deploymentUrl,
      theme:           roomTheme,
    };

    Rooms.addMyRoom(room);

    // Random, device-local owner credential — never derived from the room
    // secret, which travels in every invite link.
    const memberId = 'u_owner_' + roomId.slice(0, 6);
    const ownerToken = Rooms.ensureOwnerToken(room);
    Storage.setSession({
      roomId,
      memberId,
      sessionToken: ownerToken,
      displayName:  ownerDisplayName,
      role:         'owner',
      joinedAt:     now,
      deploymentUrl,
      roomName:     roomName,
      roomDesc:     roomDesc,
      roomSecret:   roomSecret,
      theme:        roomTheme,
      picture:      ((typeof UI !== 'undefined' && UI.effectivePicture) ? UI.effectivePicture() : ''),
    });
    Storage.setCurrentRoom(roomId);
    localStorage.setItem('shepu_display_name', ownerDisplayName);

    setStep('ps-link', 'done');

    return room;
  }

  // ── Success View ──────────────────────────────────────────────
  function showSuccess(room) {
    document.getElementById('step-progress').style.display = 'none';
    document.getElementById('step-form').style.display     = 'none';
    if (document.getElementById('step-manual')) document.getElementById('step-manual').style.display = 'none';
    document.getElementById('step-done').style.display     = '';

    const urls = Rooms.getShareUrls(room.id, room.deploymentUrl, room.name);
    const activeUrl = urls.defaultUrl; // Single universal link for phone + PC

    document.getElementById('done-room-name').innerHTML = emoName(room.name) + ' is live & ready!';

    const urlDisplay = document.getElementById('done-room-url');
    if (urlDisplay) urlDisplay.textContent = activeUrl;

    const qrImg = document.getElementById('done-qr-img');
    if (qrImg) qrImg.src = urls.qrCodeUrl;

    // Troubleshooting toggle
    const tBtn = document.getElementById('btn-toggle-troubleshoot');
    const tContent = document.getElementById('troubleshoot-content');
    const tChevron = document.getElementById('troubleshoot-chevron');
    if (tBtn && tContent) {
      tBtn.onclick = () => {
        const isHidden = tContent.style.display === 'none';
        tContent.style.display = isHidden ? 'block' : 'none';
        if (tChevron) tChevron.textContent = isHidden ? '▴' : '▾';
      };
    }

    const copyBtn = document.getElementById('copy-link-btn');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        await UI.copyText(activeUrl);
        UI.toast('success', 'Copied', 'Room link copied to clipboard!');
      };
    }

    const shareBtn = document.getElementById('share-link-btn');
    if (shareBtn) {
      shareBtn.onclick = async () => {
        if (navigator.share) {
          try {
            await navigator.share({ title: `${room.name} — SHEPU ROOMS`, url: activeUrl });
          } catch { /* cancelled */ }
        } else {
          await UI.copyText(activeUrl);
          UI.toast('success', 'Copied', 'Room link copied to clipboard!');
        }
      };
    }

    const openChatBtn = document.getElementById('open-chat-btn');
    if (openChatBtn) {
      openChatBtn.onclick = () => {
        window.location.href = `room.html?r=${room.id}`;
      };
    }

    // Play the room-created animation (centered, ~2.5s) over the success screen
    if (window.UI?.playRoomCreatedAnimation) UI.playRoomCreatedAnimation();
  }

  // ── Progress step helper ──────────────────────────────────────
  function setStep(id, state) { UI.setStep(id, state); }

  function showProgressError(message) {
    const pt = document.getElementById('progress-title');
    if (pt) pt.textContent = 'Setup failed';
    const ps = document.getElementById('progress-subtitle');
    if (ps) ps.textContent = message;
    const pi = document.getElementById('progress-icon');
    if (pi) {
      // Swap the spinner for an error icon — otherwise it kept spinning
      // forever next to the "Setup failed" message.
      pi.classList.remove('spinner', 'animate-spin');
      pi.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
    }
    UI.toast('error', 'Room creation failed', message);
  }
});
