/**
 * SHEPU ROOMS — owner.js
 * Owner panel logic: load room info, stats, members, and room controls.
 * Requires: session with role='owner', or Google auth (for owner identity check).
 */

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(location.search);
  const roomId = params.get('r');

  if (!roomId) {
    window.location.href = 'index.html';
    return;
  }

  const room    = Rooms.getRoom(roomId);
  const session = Storage.getSession();

  // Must be the owner
  if (!room || !session || session.role !== 'owner' || session.roomId !== roomId) {
    document.getElementById('owner-loading').style.display = 'none';
    document.getElementById('owner-denied').style.display  = '';
    return;
  }

  // ── Populate header links ─────────────────────────────────────
  const chatLink = document.getElementById('open-chat-link');
  if (chatLink) chatLink.href = `room.html?r=${roomId}`;

  // ── Load room info ────────────────────────────────────────────
  let currentRoomInfo = { name: room.name, description: room.description || '', status: room.status || 'active' };

  try {
    const res = await RoomAPI.getRoom(room.deploymentUrl);
    if (res.success) currentRoomInfo = res.room;
  } catch { /* use local data */ }

  renderRoomHeader(currentRoomInfo, room);
  document.getElementById('owner-loading').style.display  = 'none';
  document.getElementById('owner-content').style.display  = '';

  // ── Load stats ────────────────────────────────────────────────
  loadStats(room, session);

  // ── Load members ──────────────────────────────────────────────
  loadMembers(room, session, currentRoomInfo);

  // ── Room link ─────────────────────────────────────────────────
  const roomUrl = Rooms.getRoomUrl(roomId, room.deploymentUrl);
  document.getElementById('room-link-display').textContent = roomUrl;

  document.getElementById('copy-room-link-btn').addEventListener('click', async () => {
    await UI.copyText(roomUrl);
    UI.toast('success', 'Copied!', 'Invite link copied to clipboard.');
  });

  document.getElementById('share-room-link-btn').addEventListener('click', async () => {
    if (navigator.share) {
      await navigator.share({ title: `${currentRoomInfo.name} — SHEPU ROOMS`, url: roomUrl });
    } else {
      await UI.copyText(roomUrl);
      UI.toast('success', 'Copied', 'Link copied (Web Share not available).');
    }
  });

  // Regenerate button is not implemented yet — explain instead of dead click
  const regenBtn = document.getElementById('regen-link-btn');
  if (regenBtn) {
    regenBtn.addEventListener('click', () => {
      UI.toast('info', 'Coming soon', 'Link regeneration is not available yet. Your current invite link keeps working.');
    });
  }

  // ── Sheet link ────────────────────────────────────────────────
  const sheetBtn = document.getElementById('open-sheet-btn');
  if (sheetBtn && room.spreadsheetId) {
    sheetBtn.href = `https://docs.google.com/spreadsheets/d/${room.spreadsheetId}`;
  } else if (sheetBtn) {
    sheetBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-right:6px;"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="16" y2="17"></line></svg> Export Chat as CSV';
    sheetBtn.onclick = (e) => {
      e.preventDefault();
      exportRoomCsv(room.id, room.name);
    };
  }

  // ── Action buttons ────────────────────────────────────────────
  _bindActions(room, session, currentRoomInfo);
});

// ── Render room header ────────────────────────────────────────────
function renderRoomHeader(roomInfo, room) {
  document.title = `${roomInfo.name} — Owner Panel`;
  // Code-point aware initial (emoji-leading names don't split surrogates)
  const firstCp = Array.from(roomInfo.name || 'R')[0] || 'R';
  document.getElementById('room-initial').innerHTML    = emoName(firstCp);
  // Room profile: the same quick/saved image the chat header uses. The
  // letter stays behind as a fallback if the image cannot load.
  try {
    const wrap = document.getElementById('owner-room-avatar');
    const img  = document.getElementById('owner-room-avatar-img');
    if (wrap && img && typeof Rooms !== 'undefined' && Rooms.roomIcon) {
      img.onload  = () => { img.style.display = 'block'; wrap.style.fontSize = '0'; };
      img.onerror = () => { img.remove(); };
      img.src = Rooms.roomIcon(room, room.kind);
    }
  } catch { /* keep the letter fallback */ }
  document.getElementById('owner-room-name').innerHTML = emoName(roomInfo.name || '—');
  document.getElementById('owner-room-desc').textContent = roomInfo.description || '';

  const statusBadge = document.getElementById('status-badge');
  if (statusBadge) {
    const status = roomInfo.status || 'active';
    statusBadge.textContent  = status.charAt(0).toUpperCase() + status.slice(1);
    statusBadge.className    = `badge ${status === 'active' ? 'badge-success' : status === 'locked' ? 'badge-warning' : 'badge-danger'}`;
  }

  // Show/hide lock/disable buttons based on status (guarded: markup may vary)
  const s = roomInfo.status || 'active';
  const lockBtn = document.getElementById('lock-room-btn');
  const unlockBtn = document.getElementById('unlock-room-btn');
  const disableBtn = document.getElementById('disable-room-btn');
  const enableBtn = document.getElementById('enable-room-btn');
  if (lockBtn) lockBtn.style.display   = s !== 'locked' ? '' : 'none';
  if (unlockBtn) unlockBtn.style.display = s === 'locked'  ? '' : 'none';
  if (disableBtn) disableBtn.style.display= s !== 'disabled' ? '' : 'none';
  if (enableBtn) enableBtn.style.display = s === 'disabled' ? '' : 'none';
}

// ── Load stats ────────────────────────────────────────────────────
async function loadStats(room, session) {
  try {
    const res = await RoomAPI.roomOp(room.deploymentUrl, {
      memberId:     session.memberId,
      sessionToken: session.sessionToken,
      op:           'get_stats',
    });
    if (res.success) {
      document.getElementById('stat-members').textContent  = res.memberCount  ?? '—';
      document.getElementById('stat-messages').textContent = res.messageCount ?? '—';
    }
  } catch { /* silently fail */ }

  if (room.createdAt) {
    document.getElementById('stat-created').textContent = new Date(room.createdAt).toLocaleDateString();
  }
}

// ── Load members ──────────────────────────────────────────────────
async function loadMembers(room, session, roomInfo) {
  const tableEl   = document.getElementById('members-table');
  const emptyEl   = document.getElementById('members-empty');
  const loadingEl = document.getElementById('members-loading');
  const countBadge= document.getElementById('member-count-badge');

  if (loadingEl) loadingEl.style.display = '';

  try {
    const res = await RoomAPI.getMembers(room.deploymentUrl);
    if (!res.success) throw new Error('Failed to load members');

    const members = res.members || [];
    countBadge.textContent = members.length;
    document.getElementById('stat-online').textContent = members.filter(m =>
      m.status === 'online' || (m.lastSeen && Date.now() - new Date(m.lastSeen).getTime() < 120000)
    ).length;

    if (loadingEl) loadingEl.style.display = 'none';

    if (!members.length) {
      emptyEl.style.display = '';
      return;
    }

    tableEl.innerHTML = '';
    members.forEach(m => {
      const isOnline = m.status === 'online' || (m.lastSeen && Date.now() - new Date(m.lastSeen).getTime() < 120000);
      const isMe     = m.memberId === session.memberId;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:0.75rem;padding:0.75rem;background:var(--surface);border-radius:var(--r-md);border:1px solid var(--border);';

      row.innerHTML = `
        <div style="width:36px;height:36px;border-radius:50%;background:var(--accent-dim);display:grid;place-items:center;font-weight:700;color:var(--accent);flex-shrink:0;">
          ${escapeHtmlLocal((m.displayName || '?')[0].toUpperCase())}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:0.9rem;">${escapeHtmlLocal(m.displayName || 'Unknown')}
            ${isMe ? '<span style="color:var(--muted);font-size:0.75rem;font-weight:400;"> (you)</span>' : ''}
            ${m.role === 'owner' ? '<span class="badge badge-accent" style="font-size:0.65rem;padding:0.1rem 0.4rem;margin-left:0.35rem;">Owner</span>' : ''}
          </div>
          <div style="font-size:0.8rem;color:var(--muted);">
            <span style="width:7px;height:7px;border-radius:50%;background:${isOnline ? 'var(--success)' : 'var(--muted)'};display:inline-block;margin-right:0.35rem;"></span>
            ${isOnline ? 'Online' : m.lastSeen ? `Last seen ${UI.relativeTime(m.lastSeen)}` : 'Never'}
          </div>
        </div>
        ${!isMe ? `
          <div style="display:flex;gap:0.5rem;">
            <button class="btn btn-ghost btn-sm member-ban-btn" data-id="${escapeHtmlLocal(m.memberId)}" data-name="${escapeHtmlLocal(m.displayName)}" title="Ban member" aria-label="Ban member"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line></svg></button>
            <button class="btn btn-ghost btn-sm member-remove-btn" data-id="${escapeHtmlLocal(m.memberId)}" data-name="${escapeHtmlLocal(m.displayName)}" title="Remove member" aria-label="Remove member"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
          </div>
        ` : ''}
      `;

      row.querySelector('.member-ban-btn')?.addEventListener('click', () => ownerBanMember(room, session, m.memberId, m.displayName));
      row.querySelector('.member-remove-btn')?.addEventListener('click', () => ownerRemoveMember(room, session, m.memberId, m.displayName, row));

      tableEl.appendChild(row);
    });

  } catch (err) {
    if (loadingEl) loadingEl.style.display = 'none';
    emptyEl.style.display = '';
    UI.toast('error', 'Failed', 'Could not load members: ' + err.message);
  }
}

// ── Member moderation ─────────────────────────────────────────────
async function ownerBanMember(room, session, targetId, name) {
  const okBan = await UI.confirmDialog({
    title: `Ban ${name}?`,
    message: 'They will not be able to rejoin.',
    confirmText: 'Ban',
    danger: true,
  });
  if (!okBan) return;
  try {
    const res = await RoomAPI.roomOp(room.deploymentUrl, {
      memberId: session.memberId, sessionToken: session.sessionToken,
      op: 'ban_member', targetId,
    });
    if (!res.success) throw new Error(res.error);
    UI.toast('success', 'Banned', `${name} has been banned.`);
    location.reload();
  } catch (err) {
    UI.toast('error', 'Failed', err.message);
  }
}

async function ownerRemoveMember(room, session, targetId, name, rowEl) {
  const okRemove = await UI.confirmDialog({
    title: `Remove ${name}?`,
    message: 'They will leave this room immediately.',
    confirmText: 'Remove',
    danger: true,
  });
  if (!okRemove) return;
  try {
    const res = await RoomAPI.roomOp(room.deploymentUrl, {
      memberId: session.memberId, sessionToken: session.sessionToken,
      op: 'remove_member', targetId,
    });
    if (!res.success) throw new Error(res.error);
    rowEl?.remove();
    UI.toast('success', 'Removed', `${name} has been removed.`);
  } catch (err) {
    UI.toast('error', 'Failed', err.message);
  }
}

// ── Bind action buttons ───────────────────────────────────────────
function _bindActions(room, session, roomInfo) {
  async function doRoomOp(op, extra = {}) {
    try {
      const res = await RoomAPI.roomOp(room.deploymentUrl, {
        memberId: session.memberId, sessionToken: session.sessionToken,
        op, ...extra,
      });
      if (!res.success) throw new Error(res.error || 'Operation failed');
      UI.toast('success', 'Done', `${op} applied.`);
      return true;
    } catch (err) {
      UI.toast('error', 'Failed', err.message);
      return false;
    }
  }

  // Rename
  document.getElementById('rename-room-btn').addEventListener('click', () => {
    document.getElementById('rename-input').value = roomInfo.name;
    UI.openModal('rename-modal');
    document.getElementById('rename-input').focus();
  });
  document.getElementById('rename-modal-close').addEventListener('click', () => UI.closeModal('rename-modal'));
  document.getElementById('rename-cancel-btn').addEventListener('click', () => UI.closeModal('rename-modal'));
  document.getElementById('rename-save-btn').addEventListener('click', async () => {
    const name = document.getElementById('rename-input').value.trim();
    if (!name) { UI.toast('error', 'Invalid', 'Room name cannot be empty.'); return; }
    const ok = await doRoomOp('rename', { name });
    if (ok) {
      roomInfo.name = name;
      document.getElementById('owner-room-name').innerHTML = emoName(name);
      Rooms.updateRoom(room.id, { name });
      UI.closeModal('rename-modal');
    }
  });

  // Lock / Unlock
  document.getElementById('lock-room-btn').addEventListener('click', async () => {
    const ok = await doRoomOp('lock');
    if (ok) { roomInfo.status = 'locked'; renderRoomHeader(roomInfo, room); Rooms.updateRoom(room.id, { status: 'locked' }); }
  });
  document.getElementById('unlock-room-btn').addEventListener('click', async () => {
    const ok = await doRoomOp('unlock');
    if (ok) { roomInfo.status = 'active'; renderRoomHeader(roomInfo, room); Rooms.updateRoom(room.id, { status: 'active' }); }
  });

  // Disable / Enable
  document.getElementById('disable-room-btn').addEventListener('click', async () => {
    const okDisable = await UI.confirmDialog({
      title: 'Disable this room?',
      message: 'Members will not be able to send messages.',
      confirmText: 'Disable',
      danger: true,
    });
    if (!okDisable) return;
    const ok = await doRoomOp('disable');
    if (ok) { roomInfo.status = 'disabled'; renderRoomHeader(roomInfo, room); Rooms.updateRoom(room.id, { status: 'disabled' }); }
  });
  document.getElementById('enable-room-btn').addEventListener('click', async () => {
    const ok = await doRoomOp('enable');
    if (ok) { roomInfo.status = 'active'; renderRoomHeader(roomInfo, room); Rooms.updateRoom(room.id, { status: 'active' }); }
  });

  // Export chat
  document.getElementById('export-chat-btn').addEventListener('click', () => {
    if (room.spreadsheetId) {
      window.open(`https://docs.google.com/spreadsheets/d/${room.spreadsheetId}`, '_blank');
    } else {
      exportRoomCsv(room.id, room.name);
    }
  });

  // Endpoint Modal
  const endpointBtn = document.getElementById('endpoint-btn');
  const endpointInput = document.getElementById('endpoint-url-input');
  if (endpointBtn && endpointInput) {
    endpointBtn.addEventListener('click', () => {
      endpointInput.value = (room.deploymentUrl && !room.deploymentUrl.startsWith('mock://')) ? room.deploymentUrl : '';
      UI.openModal('endpoint-modal');
    });
    document.getElementById('endpoint-modal-close')?.addEventListener('click', () => UI.closeModal('endpoint-modal'));
    document.getElementById('endpoint-cancel')?.addEventListener('click', () => UI.closeModal('endpoint-modal'));
    document.getElementById('endpoint-save')?.addEventListener('click', async () => {
      const val = endpointInput.value.trim();
      if (!val) {
        UI.toast('warning', 'Empty', 'Please enter a valid Web App URL');
        return;
      }
      room.deploymentUrl = val;
      Rooms.updateRoom(room.id, { deploymentUrl: val });
      if (session) {
        session.deploymentUrl = val;
        Storage.setSession(session);
      }
      if (room.spreadsheetId && typeof Sheets !== 'undefined' && typeof Auth !== 'undefined' && Auth.isAuthenticated()) {
        try {
          await Sheets.updateRoomConfigKey(room.spreadsheetId, 'deployment_url', val);
        } catch {}
      }
      UI.closeModal('endpoint-modal');
      UI.toast('success', 'Saved!', 'Backend Web App URL updated successfully.');
      const newUrl = Rooms.getRoomUrl(room.id, val);
      document.getElementById('room-link-display').textContent = newUrl;
    });
  }

  // Clear chat
  document.getElementById('clear-chat-btn').addEventListener('click', () => UI.openModal('clear-chat-modal'));
  document.getElementById('clear-chat-close').addEventListener('click',  () => UI.closeModal('clear-chat-modal'));
  document.getElementById('clear-chat-cancel').addEventListener('click', () => UI.closeModal('clear-chat-modal'));
  document.getElementById('clear-chat-confirm').addEventListener('click', async () => {
    const ok = await doRoomOp('clear_chat');
    if (ok) {
      await IDBStorage.clearRoomMessages(room.id);
      UI.closeModal('clear-chat-modal');
      UI.toast('success', 'Cleared', 'All messages have been deleted from your Sheet.');
    }
  });

  // Delete room
  document.getElementById('delete-room-btn').addEventListener('click', () => UI.openModal('delete-room-modal'));
  document.getElementById('delete-room-close').addEventListener('click',  () => UI.closeModal('delete-room-modal'));
  document.getElementById('delete-room-cancel').addEventListener('click', () => UI.closeModal('delete-room-modal'));

  const deleteInput   = document.getElementById('delete-confirm-input');
  const deleteConfBtn = document.getElementById('delete-room-confirm');
  deleteInput.addEventListener('input', () => {
    deleteConfBtn.disabled = deleteInput.value.trim() !== 'DELETE';
  });

  deleteConfBtn.addEventListener('click', async () => {
    const ok = await doRoomOp('delete');
    if (ok) {
      Rooms.removeRoom(room.id);
      Storage.clearSession();
      Storage.clearCurrentRoom();
      UI.closeModal('delete-room-modal');
      UI.toast('info', 'Room Deleted', 'Redirecting to dashboard…');
      setTimeout(() => { window.location.href = 'index.html'; }, 1500);
    }
  });
}

function escapeHtmlLocal(str) {
  return String(str || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

// ── Client-side CSV export for instant (P2P) rooms ─────────────────
// Builds a CSV from the room's locally-stored messages and triggers a download.
function exportRoomCsv(roomId, roomName) {
  try {
    const mockKey = 'shepu_mock_room_' + roomId;
    let roomData = {};
    try { roomData = JSON.parse(localStorage.getItem(mockKey)) || {}; } catch { roomData = {}; }
    const messages = Array.isArray(roomData.messages) ? roomData.messages : [];

    const escapeCsv = (val) => {
      const s = (val == null ? '' : String(val));
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const header = ['id', 'timestamp', 'senderId', 'senderName', 'messageType', 'message', 'replyTo', 'edited', 'deleted'];
    const rows = messages.map(m => [
      m.id, m.createdAt || m.timestamp || '', m.senderId || '', m.senderName || '',
      m.messageType || 'text', m.message || '', m.replyTo || '',
      m.edited ? 'TRUE' : 'FALSE', m.deleted ? 'TRUE' : 'FALSE',
    ]);
    const csv = [header, ...rows].map(r => r.map(escapeCsv).join(',')).join('\n');

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(roomName || 'room').replace(/[^\w\-]+/g, '_')}_chat.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    UI.toast('success', 'Exported', `${messages.length} message(s) exported as CSV.`);
  } catch (err) {
    UI.toast('error', 'Export failed', err.message);
  }
}
