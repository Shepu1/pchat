/**
 * SHEPU ROOMS — rooms.js
 * Room ID generation, room metadata management,
 * local room registry, and room API client (calls the room's Apps Script endpoint).
 */

// Global sleep utility
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
window.sleep = sleep;

// ── Crypto Utilities ──────────────────────────────────────────────
const Crypto = {
  // Cryptographically secure random base62 string
  randomBase62(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const arr = new Uint8Array(length * 2);
    crypto.getRandomValues(arr);
    let result = '';
    for (let i = 0; i < arr.length && result.length < length; i++) {
      const idx = arr[i] % chars.length;
      result += chars[idx];
    }
    return result.slice(0, length);
  },

  generateRoomId()  { return Crypto.randomBase62(CONFIG.ROOM_ID_LENGTH); },
  generateSecret()  { return Crypto.randomBase62(CONFIG.TOKEN_LENGTH); },
  generateMemberId(){ return 'u_' + Crypto.randomBase62(16); },
};

window.Crypto = Crypto;

// ── Room Registry ─────────────────────────────────────────────────
const Rooms = {
  getMyRooms()     { return Storage.getRooms().myRooms    || []; },
  getJoinedRooms() { return Storage.getRooms().joinedRooms || []; },

  getRoom(roomId) {
    const data = Storage.getRooms();
    return data.myRooms.find(r => r.id === roomId)
        || data.joinedRooms.find(r => r.id === roomId)
        || null;
  },

  addMyRoom(room)    { Storage.addMyRoom(room); },
  addJoinedRoom(room){ Storage.addJoinedRoom(room); },
  updateRoom(id, u)  { Storage.updateRoom(id, u); },
  removeRoom(id)     { Storage.removeRoom(id); },

  generateRoomId()     { return Crypto.generateRoomId(); },
  generateSecret()     { return Crypto.generateSecret(); },
  generateRoomSecret() { return Crypto.generateSecret(); },

  createInstantRoom(roomName, roomDesc, ownerName) {
    const roomId = Crypto.generateRoomId();
    const roomSecret = Crypto.generateSecret();
    const now = new Date().toISOString();
    const mockEndpoint = `mock://local/${roomId}`;
    const name = (roomName && roomName.trim()) || 'Private Room';
    const description = (roomDesc && roomDesc.trim()) || 'Private chat room';

    const room = {
      id: roomId,
      secret: roomSecret,
      name,
      description,
      status: 'active',
      createdAt: now,
      isOwner: true,
      deploymentUrl: mockEndpoint,
    };
    this.addMyRoom(room);

    // Use provided ownerName, then fallback to auth user, then localStorage
    const resolvedOwner = (ownerName && ownerName.trim())
      || Storage.getAuth()?.user?.name
      || localStorage.getItem('shepu_display_name')
      || 'Owner';
    const memberId = 'u_owner_' + roomId.slice(0, 6);
    const sessionData = {
      roomId,
      memberId,
      sessionToken: 'owner_sess_' + roomSecret,
      displayName: resolvedOwner,
      role: 'owner',
      joinedAt: now,
      deploymentUrl: mockEndpoint,
      roomName: name,
      roomDesc: description,
      roomSecret: roomSecret,
    };
    Storage.setSession(sessionData);
    Storage.setCurrentRoom(roomId);

    // Initialize mock store
    const mockStorageKey = 'shepu_mock_room_' + roomId;
    const initialData = {
      id: roomId,
      name,
      description,
      status: 'active',
      created_at: now,
      members: [{ id: memberId, name: resolvedOwner, role: 'owner', status: 'online', lastActive: Date.now() }],
      messages: []
    };
    localStorage.setItem(mockStorageKey, JSON.stringify(initialData));

    // Announce to cross-device relay (so mobile phone gets room details)
    try {
      fetch(`https://ntfy.sh/shepu_pchat_${roomId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'room_meta', data: initialData }),
      }).catch(() => {});
    } catch {}

    return room;
  },

  // ── Create room with Google Sheet backend (async) ─────────────
  // Full flow:
  //   1. Create Google Sheet in user's Drive (inside SHEPU ROOMS folder)
  //   2. Initialize sheet tabs (messages, members, room_config, ...)
  //   3. Deploy Apps Script as web app → get endpoint URL
  //   4. Save room with that endpoint URL
  //   5. Open the Google Sheet in a new tab
  async createRoomWithSheet(roomName, roomDesc, ownerName, onProgress) {
    const progress = (msg) => { if (onProgress) onProgress(msg); };

    const roomId = Crypto.generateRoomId();
    const roomSecret = Crypto.generateSecret();
    const now = new Date().toISOString();
    const name = (roomName && roomName.trim()) || 'Private Room';
    const description = (roomDesc && roomDesc.trim()) || 'Private chat room';

    const resolvedOwner = (ownerName && ownerName.trim())
      || Storage.getAuth()?.user?.name
      || localStorage.getItem('shepu_display_name')
      || 'Owner';

    let deploymentUrl = `mock://local/${roomId}`; // fallback
    let spreadsheetId = null;
    let sheetUrl = null;

    // ── Step 1: Create Google Sheet ─────────────────────────────
    try {
      progress('Creating Google Sheet in your Google Drive…');
      const folderId = await Drive.getOrCreateFolder();
      const sheetTitle = `${CONFIG.SHEET_PREFIX}${name}`;
      const file = await Drive.createSpreadsheet(sheetTitle, folderId);
      spreadsheetId = file.id;
      sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
      progress('Initializing spreadsheet structure…');

      // ── Step 2: Initialize sheet tabs ────────────────────────
      await Sheets.initializeSpreadsheet(spreadsheetId, {
        roomId,
        roomName: name,
        description,
        createdAt: now,
        ownerId: resolvedOwner,
        roomSecret,
      });

      // ── Step 3: Deploy Apps Script ───────────────────────────
      try {
        progress('Deploying chat backend (Apps Script)…');
        const deployed = await AppsScriptAPI.fullyDeploy(
          spreadsheetId, roomId, roomSecret,
          `Pchat shepu — ${name}`
        );
        if (deployed && deployed.webAppUrl) {
          deploymentUrl = deployed.webAppUrl;
          progress('Backend deployed successfully!');
        }
      } catch (deployErr) {
        console.warn('[createRoomWithSheet] Apps Script auto-deploy skipped:', deployErr.message);
        progress('Spreadsheet ready in Google Drive!');
      }

    } catch (err) {
      console.warn('[createRoomWithSheet] Google setup failed, using instant P2P mode:', err.message);
      progress('Google setup failed — using instant P2P mode.');
      // Fall through with mock endpoint
    }

    // ── Step 4: Save room with final endpoint ────────────────────
    const room = {
      id: roomId,
      secret: roomSecret,
      name,
      description,
      status: 'active',
      createdAt: now,
      isOwner: true,
      deploymentUrl,
      spreadsheetId: spreadsheetId || null,
      sheetUrl: sheetUrl || null,
      backendMode: spreadsheetId ? 'google-sheets' : 'p2p',
    };
    this.addMyRoom(room);

    const memberId = 'u_owner_' + roomId.slice(0, 6);
    const sessionData = {
      roomId,
      memberId,
      sessionToken: 'owner_sess_' + roomSecret,
      displayName: resolvedOwner,
      role: 'owner',
      joinedAt: now,
      deploymentUrl,
      roomName: name,
      roomDesc: description,
      roomSecret: roomSecret,
    };
    Storage.setSession(sessionData);
    Storage.setCurrentRoom(roomId);

    // Also init local mock store for offline/relay fallback
    const mockStorageKey = 'shepu_mock_room_' + roomId;
    localStorage.setItem(mockStorageKey, JSON.stringify({
      id: roomId, name, description, status: 'active',
      created_at: now,
      members: [{ id: memberId, name: resolvedOwner, role: 'owner', status: 'online', lastActive: Date.now() }],
      messages: []
    }));

    // ── Step 5: Open Google Sheet in new tab ─────────────────────
    if (sheetUrl) {
      progress('Opening your Google Sheet…');
      setTimeout(() => window.open(sheetUrl, '_blank'), 800);
    }

    return room;
  },

  // Room URL
  getRoomUrl(roomId, deploymentUrl) {
    const urls = this.getShareUrls(roomId, deploymentUrl);
    return urls.defaultUrl;
  },

  // Returns URLs tailored for GitHub Pages / Phone / Local PC
  getShareUrls(roomId, deploymentUrl, roomName) {
    const port = window.location.port ? `:${window.location.port}` : '';
    const host = window.location.hostname || '';
    const protocol = window.location.protocol || 'https:';
    const isGithub = host.includes('github.io');
    const isLocalhost = host === '127.0.0.1' || host === 'localhost' || host === '';

    const origin = (window.location.origin && window.location.origin !== 'null' && !window.location.origin.startsWith('file'))
      ? window.location.origin
      : 'https://shepu1.github.io';

    // Derive base path from the current page (e.g. /pchat). Fall back to ''
    // for file:// or workspace previews (/mnt, /run, /tmp) instead of a
    // hardcoded repo path that breaks QR codes on other hosts.
    let basePath = '';
    try {
      const p = window.location.pathname || '';
      if (p && !p.startsWith('/mnt') && !p.startsWith('/run') && !p.startsWith('/tmp')) {
        basePath = p.split('/').slice(0, -1).join('/') || '';
      }
    } catch { basePath = ''; }

    // LAN IP for phone testing is configurable (Settings/auto-detect can set it).
    // Falls back to previous default for backward compatibility.
    let lanIp = '192.168.10.240';
    try {
      lanIp = localStorage.getItem('shepu_lan_ip') || lanIp;
    } catch { /* ignore */ }
    const phoneOrigin = isLocalhost ? `${protocol}//${lanIp}${port}` : origin;
    const localOrigin = origin;

    const effectiveDepUrl = deploymentUrl || `mock://local/${roomId}`;
    const encodedEp = btoa(effectiveDepUrl).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

    const room = this.getRoom(roomId);
    const effectiveName = roomName || (room && room.name) || 'Private Room';
    const encodedName = encodeURIComponent(effectiveName);

    // Embed the room secret in the invite link so every member derives the
    // same AES-GCM key → messages stay encrypted at rest (ntfy cloud / localStorage).
    // Fall back to the active session secret so re-shared links never lose ?k=.
    let roomSecret = (room && room.secret) ? room.secret : '';
    if (!roomSecret) {
      try {
        const sess = (typeof Storage !== 'undefined' && Storage.getSession) ? Storage.getSession() : null;
        if (sess && sess.roomId === roomId && sess.roomSecret) roomSecret = sess.roomSecret;
      } catch {}
    }
    const encodedKey = roomSecret
      ? btoa(roomSecret).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
      : '';
    const keyParam = encodedKey ? `&k=${encodedKey}` : '';

    let phoneUrl = `${phoneOrigin}${basePath}/join.html?r=${roomId}&ep=${encodedEp}&n=${encodedName}${keyParam}`;
    let localUrl = `${localOrigin}${basePath}/join.html?r=${roomId}&ep=${encodedEp}&n=${encodedName}${keyParam}`;
    let githubUrl = `https://shepu1.github.io/s/index/pchat/join.html?r=${roomId}&ep=${encodedEp}&n=${encodedName}${keyParam}`;

    if (isGithub) {
      phoneUrl = githubUrl;
      localUrl = githubUrl;
    }

    const primaryUrl = isGithub ? githubUrl : (isLocalhost ? phoneUrl : localUrl);
    const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(primaryUrl)}`;

    return {
      phoneUrl,
      localUrl,
      githubUrl,
      qrCodeUrl,
      defaultUrl: primaryUrl,
    };
  },
};

window.Rooms = Rooms;

// ── Room API Client ───────────────────────────────────────────────
// All chat operations go through the room's Apps Script web app endpoint.
// Guests NEVER touch the Google Sheet directly.

const RoomAPI = {
  // Base fetch to the room's Apps Script endpoint
  async _fetch(endpointUrl, method, body) {
    if (endpointUrl && endpointUrl.startsWith('mock://')) {
      return this._mockFetch(endpointUrl, method, body);
    }

    const url = method === 'GET'
      ? `${endpointUrl}?${new URLSearchParams(body)}`
      : endpointUrl;

    const options = method === 'GET'
      ? { method: 'GET', redirect: 'follow' }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body),
          redirect: 'follow',
        };

    let lastErr;
    let attempt = 0;

    while (attempt <= CONFIG.MAX_RETRY_ATTEMPTS) {
      try {
        const res = await fetch(url, options);

        if (res.status === 429 || res.status >= 500) {
          const wait = CONFIG.BASE_BACKOFF_MS * Math.pow(2, attempt);
          await sleep(wait);
          attempt++;
          continue;
        }

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }

        const data = await res.json();
        return data;

      } catch (err) {
        lastErr = err;
        if (err.name === 'TypeError') {
          lastErr = new Error('Network offline or endpoint unreachable');
          lastErr.isNetwork = true;
          break; // Don't retry network errors
        }
        if (attempt >= CONFIG.MAX_RETRY_ATTEMPTS) break;
        await sleep(CONFIG.BASE_BACKOFF_MS * Math.pow(2, attempt));
        attempt++;
      }
    }

    throw lastErr || new Error('Request failed');
  },

  async get(endpointUrl, params) {
    return this._fetch(endpointUrl, 'GET', params);
  },

  async post(endpointUrl, body) {
    return this._fetch(endpointUrl, 'POST', body);
  },

  // ── Room info ─────────────────────────────────────────────────
  async getRoom(endpointUrl) {
    return this.get(endpointUrl, { action: 'room' });
  },

  // ── Join ──────────────────────────────────────────────────────
  async join(endpointUrl, { displayName, memberId, sessionToken, picture }) {
    return this.post(endpointUrl, { action: 'join', displayName, memberId, sessionToken, picture: picture || '' });
  },

  // ── Leave ─────────────────────────────────────────────────────
  async leave(endpointUrl, { memberId, sessionToken }) {
    return this.post(endpointUrl, { action: 'leave', memberId, sessionToken });
  },

  // ── Get messages (incremental) ────────────────────────────────
  async getMessages(endpointUrl, { afterRow, limit } = {}) {
    const params = { action: 'messages' };
    if (afterRow) params.afterRow = afterRow;
    if (limit)    params.limit    = limit;
    return this.get(endpointUrl, params);
  },

  // ── Send message ──────────────────────────────────────────────
  async sendMessage(endpointUrl, { memberId, sessionToken, messageId, message, messageType, replyTo, displayName, picture }) {
    return this.post(endpointUrl, {
      action: 'message', memberId, sessionToken, messageId,
      message, messageType: messageType || 'text',
      replyTo: replyTo || '', displayName: displayName || '',
      picture: picture || '',
    });
  },

  // ── Edit message ──────────────────────────────────────────────
  async editMessage(endpointUrl, { memberId, sessionToken, messageId, message }) {
    return this.post(endpointUrl, { action: 'edit', memberId, sessionToken, messageId, message });
  },

  // ── Delete message ────────────────────────────────────────────
  async deleteMessage(endpointUrl, { memberId, sessionToken, messageId }) {
    return this.post(endpointUrl, { action: 'delete', memberId, sessionToken, messageId });
  },

  // ── Presence ──────────────────────────────────────────────────
  async updatePresence(endpointUrl, { memberId, sessionToken, status }) {
    return this.post(endpointUrl, { action: 'presence', memberId, sessionToken, status });
  },

  // ── Get members ───────────────────────────────────────────────
  async getMembers(endpointUrl) {
    return this.get(endpointUrl, { action: 'members' });
  },

  // ── Owner operations ──────────────────────────────────────────
  async roomOp(endpointUrl, { memberId, sessionToken, op, ...extra }) {
    return this.post(endpointUrl, { action: 'room_op', memberId, sessionToken, op, ...extra });
  },

  // ── Mock Fetch with Universal Cross-Device Cloud Sync (Instant P2P mode) ──
  async _mockFetch(endpointUrl, method, body) {
    const rawUrl = endpointUrl.replace('mock://local/', '');
    const roomId = rawUrl.split('?')[0];
    const params = method === 'GET' ? body : body;
    const action = params?.action || 'room';
    const mockStorageKey = 'shepu_mock_room_' + roomId;
    const ntfyTopic = `shepu_pchat_${roomId}`;
    const ntfyUrl = `https://ntfy.sh/${ntfyTopic}`;

    let roomData;
    try {
      roomData = JSON.parse(localStorage.getItem(mockStorageKey)) || { messages: [], members: [] };
    } catch {
      roomData = { messages: [], members: [] };
    }

    if (!Array.isArray(roomData.messages)) roomData.messages = [];
    if (!Array.isArray(roomData.members)) roomData.members = [];

    if (action === 'room') {
      const roomObj = {
        id: roomId,
        name: roomData.name || 'Private Room',
        description: roomData.description || 'Welcome to the room!',
        status: 'active',
        created_at: roomData.created_at || new Date().toISOString(),
      };
      return {
        success: true,
        room: roomObj,
        room_id: roomId,
        room_name: roomObj.name,
        status: 'active',
        created_at: roomObj.created_at,
      };
    }

    if (action === 'join') {
      const displayName = params.displayName || localStorage.getItem('shepu_display_name') || 'Guest';
      const incomingId = params.memberId || null;
      const memberId = incomingId || ('u_' + Date.now());
      const picture = params.picture || '';
      // Preserve existing role on re-join; new members are always 'member'.
      // Never promote to owner just because a sessionToken was supplied.
      const existingMember = roomData.members.find(m => (m.id || m.memberId) === memberId);
      const role = existingMember ? (existingMember.role || 'member') : 'member';

      // Broadcast join to public relay (works on GitHub Pages & phones)
      try {
        fetch(ntfyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'join', memberId, displayName, role, picture }),
        }).catch(() => {});
      } catch (e) {}

      const existingIdx = roomData.members.findIndex(m => m.id === memberId);
      if (existingIdx >= 0) {
        // Update existing member (refresh name/picture/status)
        roomData.members[existingIdx] = {
          ...roomData.members[existingIdx],
          name: displayName, picture, status: 'online', lastActive: Date.now()
        };
      } else {
        roomData.members.push({ id: memberId, name: displayName, picture, role, status: 'online', lastActive: Date.now() });
      }
      localStorage.setItem(mockStorageKey, JSON.stringify(roomData));
      return {
        success: true,
        sessionToken: 'mock_sess_' + Date.now(),
        memberId,
        displayName,
        role,
      };
    }

    if (action === 'messages') {
      const afterRow = parseInt(params.afterRow || 0, 10);

      // Sort chronologically
      roomData.messages.sort((a, b) => new Date(a.createdAt || a.timestamp || 0) - new Date(b.createdAt || b.timestamp || 0));

      const allMsgs = roomData.messages.map((m, idx) => ({ ...m, row: idx + 1 }));
      const newMsgs = afterRow > 0 ? allMsgs.filter(m => m.row > afterRow) : allMsgs;

      return {
        success: true,
        messages: newMsgs,
        total: allMsgs.length,
        lastRow: allMsgs.length,
      };
    }

    if (action === 'message') {
      const senderName = params.displayName || localStorage.getItem('shepu_display_name') || 'Guest';
      const senderPicture = params.picture || '';
      const msgId = params.messageId || ('m_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
      const msgType = ['text','image','file','audio'].includes(params.messageType) ? params.messageType : 'text';
      const newMsg = {
        id: msgId,
        senderId: params.memberId,
        senderName: senderName,
        senderPicture: senderPicture,
        messageType: msgType,
        message: params.message,
        replyTo: params.replyTo || '',
        createdAt: new Date().toISOString(),
        timestamp: new Date().toISOString(),
        deleted: false,
        edited: false,
      };

      if (!roomData.messages.some(m => m.id === newMsg.id)) {
        roomData.messages.push(newMsg);
        localStorage.setItem(mockStorageKey, JSON.stringify(roomData));
      }

      // 1. Broadcast to public cloud relay (ntfy.sh) so phones & other browsers receive it instantly
      try {
        fetch(ntfyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'message', msg: newMsg }),
        }).catch(() => {});
      } catch (e) {}

      return { success: true, messageId: newMsg.id };
    }

    if (action === 'delete') {
      const msg = roomData.messages.find(m => m.id === params.messageId);
      if (msg) {
        msg.deleted = true;
        localStorage.setItem(mockStorageKey, JSON.stringify(roomData));
      }
      return { success: true };
    }

    if (action === 'edit') {
      const msg = roomData.messages.find(m => m.id === params.messageId);
      if (msg) {
        msg.message = params.message;
        msg.edited = true;
        localStorage.setItem(mockStorageKey, JSON.stringify(roomData));
      }
      return { success: true };
    }

    if (action === 'presence' || action === 'leave') {
      return { success: true };
    }

    if (action === 'room_op') {
      const op = params.op;
      if (op === 'get_stats') {
        return {
          success: true,
          memberCount: (roomData.members || []).length,
          messageCount: (roomData.messages || []).length,
        };
      }
      if (op === 'clear_chat') {
        roomData.messages = [];
        localStorage.setItem(mockStorageKey, JSON.stringify(roomData));
        return { success: true };
      }
      if (op === 'lock' || op === 'unlock' || op === 'disable' || op === 'enable') {
        roomData.status = op === 'lock' ? 'locked' : op === 'disable' ? 'disabled' : 'active';
        localStorage.setItem(mockStorageKey, JSON.stringify(roomData));
        return { success: true };
      }
      if (op === 'delete') {
        roomData.status = 'deleted';
        localStorage.setItem(mockStorageKey, JSON.stringify(roomData));
        return { success: true };
      }
      if (op === 'rename' && params.name) {
        roomData.name = String(params.name).slice(0, 80);
        localStorage.setItem(mockStorageKey, JSON.stringify(roomData));
        return { success: true };
      }
      if ((op === 'ban_member' || op === 'remove_member') && params.targetId) {
        roomData.members = (roomData.members || []).filter(m => (m.id || m.memberId) !== params.targetId);
        localStorage.setItem(mockStorageKey, JSON.stringify(roomData));
        return { success: true };
      }
      return { success: true };
    }

    if (action === 'members') {
      // Normalize local storage members
      const normalized = (roomData.members || []).map(m => ({
        memberId:    m.memberId || m.id,
        displayName: m.displayName || m.name || 'Unknown',
        picture:     m.picture || '',
        role:        m.role || 'member',
        status:      m.status || (Date.now() - (m.lastActive || 0) < 120000 ? 'online' : 'offline'),
        lastSeen:    m.lastSeen || (m.lastActive ? new Date(m.lastActive).toISOString() : null),
      }));
      return { success: true, members: normalized };
    }

    return { success: true };
  },
};

window.RoomAPI = RoomAPI;

