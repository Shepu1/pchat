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

  // ── Connection Mode selector (Instant P2P vs Secure Google Sheet) ──
  const modeBtns = document.querySelectorAll('#room-mode-picker .room-mode-btn');
  const modeHint = document.getElementById('mode-hint');
  const MODE_HINTS = {
    instant: 'Instant rooms connect devices directly over peer-to-peer — no sign-in needed.',
    secure:  'Secure rooms back up every message to a Google Sheet in your Drive. Google sign-in required.',
  };
  modeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      roomMode = btn.dataset.mode;
      modeBtns.forEach(b => {
        const isActive = b === btn;
        b.classList.toggle('active', isActive);
        b.style.background  = isActive ? 'var(--surface-3)' : 'var(--surface-2)';
        b.style.borderColor = isActive ? 'var(--accent)' : 'var(--border)';
      });
      if (modeHint) modeHint.textContent = MODE_HINTS[roomMode] || '';
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
        await navigator.clipboard.writeText(code);
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

    const activeEmoji = document.querySelector('.btn-emoji-tag.active')?.dataset?.emoji;
    if (activeEmoji && !roomName.includes(activeEmoji)) {
      roomName = `${activeEmoji} ${roomName}`;
    }

    // Show progress
    document.getElementById('step-form').style.display     = 'none';
    document.getElementById('step-progress').style.display = '';

    if (window.UI?.initStepIcons) UI.initStepIcons();

    try {
      createdRoom = await createRoom(roomName, roomDesc);
      showSuccess(createdRoom);
    } catch (err) {
      console.error('Room creation failed:', err);
      // In Secure mode, never silently fall back to Instant — surface the error
      // and return the user to the form so they can retry or switch mode.
      if (roomMode === 'secure') {
        document.getElementById('step-progress').style.display = 'none';
        document.getElementById('step-form').style.display     = '';
        errorEl.style.display = '';
        errorText.textContent = err.message || 'Secure room creation failed. Please try again.';
        if (window.UI?.toast) UI.toast('error', 'Secure room failed', err.message || 'Please try again.');
        return;
      }
      // Fallback (Instant mode): create instant room immediately
      createdRoom = Rooms.createInstantRoom(roomName, roomDesc);
      showSuccess(createdRoom);
    }
  });

  // ── Main creation flow ────────────────────────────────────────
  async function createRoom(roomName, roomDesc) {
    const customScriptUrl = document.getElementById('custom-script-url')?.value?.trim();
    if (customScriptUrl && customScriptUrl.startsWith('https://script.google.com')) {
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
      };
      Rooms.addMyRoom(room);

      const ownerDisplayName = Storage.getAuth()?.user?.name || localStorage.getItem('shepu_display_name') || 'Owner';
      const memberId = 'u_owner_' + roomId.slice(0, 8);
      Storage.setSession({
        roomId,
        memberId,
        sessionToken: 'owner_sess_' + roomSecret,
        displayName:  ownerDisplayName,
        role:         'owner',
        joinedAt:     now,
        deploymentUrl: customScriptUrl,
        roomName:     roomName,
        roomDesc:     roomDesc,
        roomSecret:   roomSecret,
      });
      Storage.setCurrentRoom(roomId);
      localStorage.setItem('shepu_display_name', ownerDisplayName);

      return room;
    }

    // ── Instant (P2P) mode — no Google sign-in required ──
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

    // ── Secure (Google Sheet) mode — requires Google sign-in ──
    setStep('ps-auth', 'active');
    let auth = Storage.getAuth() || {};

    if (!CONFIG.isGoogleConfigured()) {
      showProgressError('Secure mode needs a Google Client ID. Configure it in Settings, or switch to Instant mode.');
      throw new Error('Google Client ID not configured');
    }

    // Prompt Google sign-in if the user is not already authenticated
    if (!Auth.isAuthenticated()) {
      try {
        await Auth.signIn();
        auth = Storage.getAuth() || {};
      } catch (err) {
        showProgressError('Google sign-in is required for Secure rooms: ' + err.message);
        throw err;
      }
    }

    const hasGoogle = CONFIG.isGoogleConfigured() && Auth.isAuthenticated();

    if (!hasGoogle) {
      showProgressError('Google sign-in is required for Secure rooms. Please try again or switch to Instant mode.');
      throw new Error('Google sign-in required for Secure rooms');
    }

    setStep('ps-auth', 'done');

    // Step: Folder
    setStep('ps-folder', 'active');
    let folderId;
    try {
      folderId = await Drive.getOrCreateFolder();
    } catch (err) {
      setStep('ps-folder', 'error');
      showProgressError('Failed to create Drive folder: ' + err.message);
      throw err;
    }
    setStep('ps-folder', 'done');

    // Step: Sheet
    setStep('ps-sheet', 'active');
    let spreadsheetFile;
    try {
      const sheetName = `${CONFIG.SHEET_PREFIX}${roomName}`;
      spreadsheetFile = await Drive.createSpreadsheet(sheetName, folderId);
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
      await Sheets.initializeSpreadsheet(spreadsheetId, roomConfigData);
    } catch (err) {
      setStep('ps-tabs', 'error');
      showProgressError('Failed to initialize sheet tabs: ' + err.message);
      throw err;
    }
    setStep('ps-tabs', 'done');

    // Step: Apps Script
    setStep('ps-script', 'active');
    let deployResult;
    let deploymentUrl = null;
    let isManualSetup = false;

    try {
      setStep('ps-deploy', 'active');
      deployResult = await AppsScriptAPI.fullyDeploy(
        spreadsheetId,
        roomId,
        roomSecret,
        `SHEPU-${roomName}-Backend`
      );
      deploymentUrl = deployResult.webAppUrl;
      setStep('ps-script', 'done');
      setStep('ps-deploy', 'done');

      // Update deployment_url in sheet config
      await Sheets.updateRoomConfigKey(spreadsheetId, 'deployment_url', deploymentUrl);

    } catch (err) {
      console.warn('Automatic deploy failed, falling back to manual:', err);
      setStep('ps-script', 'error');
      setStep('ps-deploy', 'error');
      isManualSetup = true;

      // Show fallback notice (guard: create.html has no manual wizard elements)
      const fallbackReason = document.getElementById('fallback-reason');
      if (fallbackReason) {
        fallbackReason.textContent =
          `Automatic deployment failed: ${err.message}. Use the manual setup wizard below.`;
      }
      const fallbackNotice = document.getElementById('fallback-notice');
      if (fallbackNotice) fallbackNotice.style.display = '';

      // If no manual wizard exists on this page, surface the error instead of crashing
      if (!document.getElementById('step-manual')) {
        showProgressError('Automatic deployment failed: ' + err.message);
        throw err;
      }

      // Build the room object with null deploymentUrl for now
      const partialRoom = {
        id:              roomId,
        secret:          roomSecret,
        name:            roomName,
        description:     roomDesc,
        spreadsheetId,
        status:          'setup_pending',
        createdAt:       now,
        isOwner:         true,
        deploymentUrl:   null,
      };

      await showManualWizard(partialRoom, spreadsheetId);
      return; // Wait for manual completion
    }

    // Step: Generate link
    setStep('ps-link', 'active');
    const room = {
      id:              roomId,
      secret:          roomSecret,
      name:            roomName,
      description:     roomDesc,
      spreadsheetId,
      status:          'active',
      createdAt:       now,
      isOwner:         true,
      deploymentUrl,
      scriptId:        deployResult?.scriptId,
      deploymentId:    deployResult?.deploymentId,
    };

    Rooms.addMyRoom(room);

    const ownerDisplayName = ownerUser.name || localStorage.getItem('shepu_display_name') || 'Owner';
    const memberId = 'u_owner_' + roomId.slice(0, 8);
    Storage.setSession({
      roomId,
      memberId,
      sessionToken: 'owner_sess_' + roomSecret,
      displayName:  ownerDisplayName,
      role:         'owner',
      joinedAt:     now,
      deploymentUrl,
      roomName:     roomName,
      roomDesc:     roomDesc,
      roomSecret:   roomSecret,
    });
    Storage.setCurrentRoom(roomId);
    localStorage.setItem('shepu_display_name', ownerDisplayName);

    setStep('ps-link', 'done');

    return room;
  }

  // ── Manual Wizard ─────────────────────────────────────────────
  async function showManualWizard(partialRoom, spreadsheetId) {
    const progressStep = document.getElementById('step-progress');
    if (progressStep) progressStep.style.display = 'none';
    const manualStep = document.getElementById('step-manual');
    if (!manualStep) {
      showProgressError('Automatic deployment failed and manual setup is not available on this page.');
      throw new Error('Manual setup wizard not available on this page');
    }
    manualStep.style.display = '';

    // Script link
    const scriptLink = document.getElementById('manual-script-link');
    if (scriptLink) {
      scriptLink.href = `https://script.google.com/home/projects`;
      scriptLink.textContent = 'Open Apps Script ↗';
    }

    // Show generated code
    const code = AppsScriptAPI.getScriptCodeForManualSetup(
      partialRoom.id, partialRoom.secret, spreadsheetId
    );
    const codeBlock = document.getElementById('manual-code-block');
    if (codeBlock) codeBlock.textContent = code;

    // Copy button (bind once)
    const copyBtn = document.getElementById('copy-script-btn');
    if (copyBtn && !copyBtn.dataset.bound) {
      copyBtn.dataset.bound = '1';
      copyBtn.addEventListener('click', async () => {
        await UI.copyText(code);
        UI.toast('success', 'Copied', 'Script code copied to clipboard.');
      });
    }

    // Finish button (bind once)
    const finishBtn = document.getElementById('manual-finish-btn');
    if (!finishBtn || finishBtn.dataset.bound) return;
    finishBtn.dataset.bound = '1';
    finishBtn.addEventListener('click', async () => {
      const urlEl = document.getElementById('manual-deploy-url');
      const urlInput = (urlEl ? urlEl.value : '').trim();
      if (!urlInput || !urlInput.startsWith('https://script.google.com/macros/')) {
        UI.toast('error', 'Invalid URL', 'Please paste the Apps Script web app URL.');
        return;
      }

      // Update room with deployment URL
      partialRoom.deploymentUrl = urlInput;
      partialRoom.status        = 'active';

      try {
        await Sheets.updateRoomConfigKey(spreadsheetId, 'deployment_url', urlInput);
        await Sheets.updateRoomConfigKey(spreadsheetId, 'room_status',    'active');
      } catch (e) { /* non-critical */ }

      Rooms.addMyRoom(partialRoom);

      const ownerDisplayName = Storage.getAuth()?.user?.name || localStorage.getItem('shepu_display_name') || 'Owner';
      const memberId = 'u_owner_' + partialRoom.id.slice(0, 8);
      Storage.setSession({
        roomId:       partialRoom.id,
        memberId,
        sessionToken: 'owner_sess_' + (partialRoom.secret || partialRoom.id),
        displayName:  ownerDisplayName,
        role:         'owner',
        joinedAt:     partialRoom.createdAt || new Date().toISOString(),
        deploymentUrl: urlInput,
        roomName:     partialRoom.name,
        roomDesc:     partialRoom.description,
        roomSecret:   partialRoom.secret || '',
      });
      Storage.setCurrentRoom(partialRoom.id);
      localStorage.setItem('shepu_display_name', ownerDisplayName);

      showSuccess(partialRoom);
      document.getElementById('step-manual').style.display = 'none';
    });
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
    if (pi) pi.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    if (pi) pi.classList.remove('animate-spin');
    UI.toast('error', 'Room creation failed', message);
  }
});
