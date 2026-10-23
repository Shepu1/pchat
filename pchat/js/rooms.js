/**
 * SHEPU ROOMS — rooms.js
 * Room ID generation, room metadata management,
 * local room registry, and room API client (calls the room's Apps Script endpoint).
 */

// Global sleep utility
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
window.sleep = sleep;

// Timeout guard: Google API calls must NEVER hang silently (blocked popup,
// expired token re-auth, offline, API disabled). Converts a hang into a
// visible error naming the stuck step.
async function googleStep(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      label + ' আটকে গেছে (' + Math.round(ms / 1000) + 's timeout)। পপআপ ব্লকার / নেট / Google API সেটিং দেখো।'
    )), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
window.googleStep = googleStep;

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
};

window.Crypto = Crypto;

// ── Room Theme (weighted random: theme1=15%, the rest split 85%) ───
// Theme travels with the room (?th= in the invite link) so every device
// shows the same chat wallpaper. Not secret — just a digit 1-N.
const RoomTheme = (() => {
  const WEIGHTS = [15, ...Array(11).fill(85 / 11)];

  function pick() {
    const r = Math.random() * 100;
    let acc = 0;
    for (let i = 0; i < WEIGHTS.length; i++) {
      acc += WEIGHTS[i];
      if (r < acc) return i + 1;
    }
    return 1;
  }

  function normalize(v) {
    const n = parseInt(v, 10);
    return (n >= 1 && n <= WEIGHTS.length) ? n : 1;
  }

  // Apply to the chat wallpaper element (desktop + mobile variants
  // are handled in CSS via .theme-N classes + media queries).
  function apply(n) {
    try {
      const el = document.querySelector('.chat-main');
      if (!el) return;
      for (let i = 1; i <= WEIGHTS.length; i++) el.classList.remove('theme-' + i);
      el.classList.add('theme-' + normalize(n));
    } catch {}
  }

  return { pick, normalize, apply, count: WEIGHTS.length };
})();

window.RoomTheme = RoomTheme;

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

  // Mirror a room status change into THIS device's local mock store.
  //
  // A Quick room's status lives in the owner's localStorage. When the owner
  // locks the room, the status is relayed to the other devices — but their
  // own mock store still said "active", so the send path happily accepted
  // messages in a room that was supposed to be read-only. Writing the new
  // status locally makes the mock's own guard reject the send.
  setLocalRoomStatus(roomId, status) {
    try {
      const key = 'shepu_mock_room_' + roomId;
      const raw = localStorage.getItem(key);
      if (!raw) return false;
      const roomData = JSON.parse(raw);
      if (!roomData || typeof roomData !== 'object') return false;
      roomData.status = status;
      localStorage.setItem(key, JSON.stringify(roomData));
      return true;
    } catch { return false; }
  },

  generateRoomId()     { return Crypto.generateRoomId(); },
  generateSecret()     { return Crypto.generateSecret(); },
  generateRoomSecret() { return Crypto.generateSecret(); },

  // ── Room kind + profile icon ────────────────────────────────
  // Saved (Google Sheet backup) rooms → saved.webp. Quick (instant/P2P)
  // rooms get one of the four quick avatars; the pick is random per new
  // room and stored on the room record so the same room never flickers
  // between renders. kindHint ('saved'|'quick') covers invite-link
  // contexts where the registry row has no spreadsheetId.
  QUICK_ROOM_ICONS: [
    'assets/icons/quick.webp',
    'assets/icons/quick1.jpeg',
    'assets/icons/quick2.jpeg',
    'assets/icons/quick3.jpeg',
  ],
  roomKind(room, kindHint) {
    if (kindHint === 'saved' || kindHint === 'quick') return kindHint;
    return (room && room.spreadsheetId) ? 'saved' : 'quick';
  },
  // Random pick for a brand-new quick room.
  rollQuickIcon() {
    const list = this.QUICK_ROOM_ICONS;
    return list[Math.floor(Math.random() * list.length)];
  },
  // Stored pick when available, otherwise a stable hash of the room id
  // (older rooms have no stored icon yet).
  quickIconFor(room) {
    const stored = room && room.quickIcon;
    if (stored && this.QUICK_ROOM_ICONS.indexOf(stored) !== -1) return stored;
    const id = String((room && (room.id || room.roomId)) || '');
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return this.QUICK_ROOM_ICONS[hash % this.QUICK_ROOM_ICONS.length];
  },
  // The icon the owner picked in the create form (chat/trend/rocket/…).
  // Rendered as an SVG data URI so every consumer can keep using <img src>.
  roomIconDataUri(room) {
    const key = room && (room.icon || room.roomIcon);
    if (!key || typeof key !== 'string') return '';
    try {
      if (typeof Icons === 'undefined' || !Icons || typeof Icons[key] !== 'function') return '';
      let markup = Icons[key](64);
      if (typeof markup !== 'string' || !markup) return '';
      // currentColor has no meaning inside a data URI — use a concrete colour.
      markup = markup.replace(/currentColor/g, '#ffffff');
      return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
    } catch { return ''; }
  },
  roomIcon(room, kindHint) {
    // The owner's pick wins — it used to be stored and then never read.
    const picked = this.roomIconDataUri(room);
    if (picked) return picked;
    return this.roomKind(room, kindHint) === 'saved'
      ? 'assets/icons/saved.webp'
      : this.quickIconFor(room);
  },

  createInstantRoom(roomName, roomDesc, ownerName) {
    const roomId = Crypto.generateRoomId();
    const roomSecret = Crypto.generateSecret();
    const now = new Date().toISOString();
    const mockEndpoint = `mock://local/${roomId}`;
    const name = (roomName && roomName.trim()) || 'Private Room';
    const description = (roomDesc && roomDesc.trim()) || 'Private chat room';
    const theme = RoomTheme.pick();

    const room = {
      id: roomId,
      secret: roomSecret,
      name,
      description,
      status: 'active',
      createdAt: now,
      isOwner: true,
      deploymentUrl: mockEndpoint,
      theme,
      // Random quick avatar (one of four) — kept on the room so the icon
      // stays the same on every render.
      quickIcon: this.rollQuickIcon(),
    };
    this.addMyRoom(room);

    // Use provided ownerName, then fallback to auth user, then localStorage
    const resolvedOwner = (ownerName && ownerName.trim())
      || Storage.getAuth()?.user?.name
      || localStorage.getItem('shepu_display_name')
      || 'Owner';
    const memberId = 'u_owner_' + roomId.slice(0, 6);
    // Random owner credential — NOT derived from the room secret (that
    // travels in every invite link, so a derived token is a public token).
    const ownerToken = this.ensureOwnerToken(room);
    const sessionData = {
      roomId,
      memberId,
      sessionToken: ownerToken,
      displayName: resolvedOwner,
      role: 'owner',
      joinedAt: now,
      deploymentUrl: mockEndpoint,
      roomName: name,
      roomDesc: description,
      roomSecret: roomSecret,
      theme,
      quickIcon: room.quickIcon,
      picture: ((typeof UI !== 'undefined' && UI.effectivePicture) ? UI.effectivePicture() : ''),
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
      theme,
      members: [{ id: memberId, name: resolvedOwner, role: 'owner', status: 'online', lastActive: Date.now() }],
      messages: []
    };
    localStorage.setItem(mockStorageKey, JSON.stringify(initialData));

    // Announce to cross-device relay (so a phone / other browser gets the
    // room details). Publishes to BOTH private (secret-derived) + legacy
    // topics, across EVERY configured relay server (failover). The secret
    // itself is never sent — only the room name/meta.
    try {
      const topics = (typeof InstantSecurity !== 'undefined')
        ? InstantSecurity.topicsFor(roomId, roomSecret)
        : [`shepu_pchat_${roomId}`];
      const body = JSON.stringify({ type: 'room_meta', data: initialData });
      if (typeof ShepuRelay !== 'undefined' && ShepuRelay.publish) {
        ShepuRelay.publish(body, topics).catch(() => {});
      } else {
        topics.forEach(t => {
          fetch(`https://ntfy.sh/${t}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body,
          }).catch(() => {});
        });
      }
    } catch {}

    return room;
  },

  // ── Rotate invite link (revoke old links, zero friction) ──────
  // Owner one click → new secret. Old links stop working for NEW joins
  // (P2P proof + ntfy topic both change). No password, no login needed.
  rotateRoomSecret(roomId) {
    const reg = this.getRoom(roomId);
    if (!reg) return null;
    const fresh = Crypto.generateSecret();
    this.updateRoom(roomId, { secret: fresh });
    try {
      const sess = (typeof Storage !== 'undefined' && Storage.getSession) ? Storage.getSession() : null;
      if (sess && sess.roomId === roomId) {
        sess.roomSecret = fresh;
        Storage.setSession(sess);
      }
    } catch {}
    return fresh;
  },

  // ── Owner session token ───────────────────────────────────────
  // The owner's credential used to be DERIVED from the room secret
  // ('owner_sess_' + secret). The secret travels in every invite link
  // (#k=...), and the room id in the query string (?r=...), so anybody
  // holding an invite could reconstruct the owner's memberId + token and
  // act as the owner (delete the room, ban members, wipe the chat).
  // The token is now a random value that lives only in this device's
  // registry — it is never derivable from anything in the link.
  ensureOwnerToken(room) {
    if (!room) return '';
    if (room.ownerToken) return room.ownerToken;
    const token = 'owner_sess_' + Crypto.randomBase62(40);
    // Set it on the record FIRST. If persisting throws (quota, a missing
    // config), the in-memory value must survive — otherwise the owner would
    // get a brand-new token on every call and the backend would reject it.
    room.ownerToken = token;
    try {
      // Persist it so a later reload can rebuild the same session.
      this.updateRoom(room.id, { ownerToken: token });
    } catch { /* keep the in-memory value even if persistence fails */ }
    return token;
  },

  // Ensure the owner has a valid members-sheet row with role=owner.
  // Legacy rooms (created before this row was written at creation time) had
  // no owner row, so every Apps Script room_op failed with FORBIDDEN.
  async ensureOwnerMemberRow(room, session) {
    if (!room || !room.spreadsheetId || !session || session.role !== 'owner') return false;
    if (typeof Sheets === 'undefined' || !Sheets.readValues) return false;
    if (!room.deploymentUrl || room.deploymentUrl.startsWith('mock://')) return false;
    // The token must be the random one from the registry. Falling back to a
    // secret-derived token would re-expose the owner credential, because the
    // secret travels in every invite link.
    const token = session.sessionToken || this.ensureOwnerToken(room);
    const now = new Date().toISOString();
    try {
      const rows = await Sheets.readValues(room.spreadsheetId, `${CONFIG.SHEETS.MEMBERS}!A:I`);
      for (let i = 1; i < rows.length; i++) {
        if (String(rows[i][0] || '') !== String(session.memberId)) continue;
        // Repair fields that drifted instead of appending a duplicate row.
        if (String(rows[i][5] || '') !== 'owner') {
          await Sheets.updateCell(room.spreadsheetId, CONFIG.SHEETS.MEMBERS, i + 1, 6, 'owner');
        }
        if (String(rows[i][8] || '') !== token) {
          await Sheets.updateCell(room.spreadsheetId, CONFIG.SHEETS.MEMBERS, i + 1, 9, token);
        }
        if (String(rows[i][7] || '').toUpperCase() !== 'TRUE') {
          await Sheets.updateCell(room.spreadsheetId, CONFIG.SHEETS.MEMBERS, i + 1, 8, 'TRUE');
        }
        return true;
      }
      await Sheets.appendRows(room.spreadsheetId, CONFIG.SHEETS.MEMBERS, [[
        session.memberId, session.displayName || 'Owner', session.joinedAt || now, now,
        'online', 'owner', 'FALSE', 'TRUE', token,
      ]]);
      return true;
    } catch (e) {
      console.warn('[Rooms] Could not ensure owner membership:', e && e.message);
      return false;
    }
  },

  // ── Create room with Google Sheet backend (async) ─────────────
  // Sheet-backup mode (no per-user setup):
  //   1. Create Google Sheet in user's Drive (inside SHEPU ROOMS folder)
  //   2. Initialize sheet tabs (messages, members, room_config, ...)
  //   3. Chat runs on the P2P mesh (mock endpoint); the owner's device
  //      auto-logs every message to the Sheet. No Apps Script toggle needed.
  // Pass {strict:true} to throw (instead of P2P fallback) when Drive/Sheets
  // fail, {deploy:true} to attempt the advanced Apps Script backend.
  async createRoomWithSheet(roomName, roomDesc, ownerName, onProgress, options = {}) {
    const strict = !!(options && options.strict);
    const progress = (msg) => { if (onProgress) onProgress(msg); };

    const roomId = Crypto.generateRoomId();
    const roomSecret = Crypto.generateSecret();
    const now = new Date().toISOString();
    const memberId = 'u_owner_' + roomId.slice(0, 6);
    // Random owner credential. It used to be derived from the room secret,
    // which travels in every invite link — that made the owner's token
    // public. Stored on the room record below so a reload can rebuild it.
    const ownerSessionToken = 'owner_sess_' + Crypto.randomBase62(40);
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
      console.log('[createRoomWithSheet] step: Drive folder…');
      const folderId = await googleStep(Drive.getOrCreateFolder(), 30000, 'Drive folder তৈরি');
      const sheetTitle = `${CONFIG.SHEET_PREFIX}${name}`;
      console.log('[createRoomWithSheet] step: create spreadsheet…');
      progress('Creating spreadsheet…');
      const file = await googleStep(Drive.createSpreadsheet(sheetTitle, folderId), 30000, 'Sheet তৈরি');
      spreadsheetId = file.id;
      sheetUrl = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
      progress('Initializing spreadsheet structure…');

      // ── Step 2: Initialize sheet tabs ────────────────────────
      // Keys MUST be snake_case — Apps Script Code.gs handleGetRoom reads
      // room_id / room_name / description / room_status / created_at.
      console.log('[createRoomWithSheet] step: init tabs…');
      await googleStep(Sheets.initializeSpreadsheet(spreadsheetId, {
        room_id: roomId,
        room_name: name,
        description,
        owner_id: resolvedOwner,
        created_at: now,
        room_status: 'active',
        config_version: '1',
        room_secret: roomSecret,
        deployment_url: '',
      }), 60000, 'Sheet ট্যাব তৈরি');

      // Register the creator as the owner in the members tab. The Apps Script
      // backend validates that role for every room_op, and without this row a
      // custom-backend room had no owner at all (FORBIDDEN on lock/delete/etc).
      progress('Registering room owner…');
      await googleStep(Sheets.appendRows(spreadsheetId, CONFIG.SHEETS.MEMBERS, [[
        memberId, resolvedOwner, now, now, 'online', 'owner', 'FALSE', 'TRUE', ownerSessionToken,
      ]]), 30000, 'Owner row তৈরি');

      // ── Step 3: Backend — P2P mesh + Sheet backup (zero user setup) ──
      // Chat runs on the P2P mesh; the owner's device auto-logs every message
      // to the Sheet. (Programmatic Apps Script deploy was removed: it needs
      // a per-account toggle from every owner. Manual deploy via the Apps
      // Script editor + "custom script URL" box remains available.)
      progress('Sheet backup ready — no extra setup needed!');

    } catch (err) {
      // Strict (Saved) mode: কখনো চুপচাপ P2P-তে ফলব্যাক নয় — আসল এরর উপরে পাঠাও
      // যাতে UI সত্যিকারের কারণ দেখাতে পারে (Drive 403 / API disabled / scope)।
      if (strict) throw err;
      console.warn('[createRoomWithSheet] Google setup failed, using instant P2P mode:', err.message);
      progress('Google setup failed — using instant P2P mode.');
      // Fall through with mock endpoint
    }

    // ── Step 4: Save room with final endpoint ────────────────────
    const theme = RoomTheme.pick();
    const room = {
      id: roomId,
      secret: roomSecret,
      name,
      description,
      status: 'active',
      createdAt: now,
      isOwner: true,
      deploymentUrl,
      theme,
      spreadsheetId: spreadsheetId || null,
      sheetUrl: sheetUrl || null,
      backendMode: spreadsheetId ? 'google-sheets' : 'p2p',
      // The owner credential lives here (device-local) so it survives a
      // reload and can never be recomputed from the invite link.
      ownerToken: ownerSessionToken,
    };
    this.addMyRoom(room);

    const sessionData = {
      roomId,
      memberId,
      sessionToken: ownerSessionToken,
      displayName: resolvedOwner,
      role: 'owner',
      joinedAt: now,
      deploymentUrl,
      roomName: name,
      roomDesc: description,
      roomSecret: roomSecret,
      theme,
      picture: ((typeof UI !== 'undefined' && UI.effectivePicture) ? UI.effectivePicture() : ''),
    };
    Storage.setSession(sessionData);
    Storage.setCurrentRoom(roomId);

    // Also init local mock store for offline/relay fallback
    const mockStorageKey = 'shepu_mock_room_' + roomId;
    localStorage.setItem(mockStorageKey, JSON.stringify({
      id: roomId, name, description, status: 'active',
      created_at: now, theme,
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

    // Password-locked rooms: the invite link carries NO key material at all
    // (neither ?k= nor #k=) — only `&pw=1`. The password derives everything
    // on the joiner's device. A leaked link alone opens nothing.
    const roomLocked = !!(room && room.passwordLocked === true);
    let roomSecret = '';
    let keyFrag = '';
    if (!roomLocked) {
      roomSecret = (room && room.secret) ? room.secret : '';
      if (!roomSecret) {
        try {
          const sess = (typeof Storage !== 'undefined' && Storage.getSession) ? Storage.getSession() : null;
          if (sess && sess.roomId === roomId && sess.roomSecret) roomSecret = sess.roomSecret;
        } catch {}
      }
    }
    if (roomSecret) {
      const encodedKey = btoa(roomSecret).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      // NOTE: ?k= is no longer emitted (history/log exposure). The #k=
      // fragment never reaches servers/logs — sole key carrier. Old ?k=
      // links are still READ (then stripped from the address bar).
      keyFrag = `#k=${encodedKey}`;
    }

    // Theme is public (just a wallpaper digit) → plain ?th= query param
    // BEFORE the fragment, so every device shows the same chat theme.
    let theme = (room && room.theme) ? room.theme : 0;
    if (!theme) {
      try {
        const sess2 = (typeof Storage !== 'undefined' && Storage.getSession) ? Storage.getSession() : null;
        if (sess2 && sess2.roomId === roomId && sess2.theme) theme = sess2.theme;
      } catch {}
    }
    const themeParam = `&th=${RoomTheme.normalize(theme || 1)}`;

    let phoneUrl = `${phoneOrigin}${basePath}/join.html?r=${roomId}&ep=${encodedEp}&n=${encodedName}${themeParam}&rt=${this.roomKind(room)}${roomLocked ? '&pw=1' : ''}${keyFrag}`;
    let localUrl = `${localOrigin}${basePath}/join.html?r=${roomId}&ep=${encodedEp}&n=${encodedName}${themeParam}&rt=${this.roomKind(room)}${roomLocked ? '&pw=1' : ''}${keyFrag}`;
    // No hardcoded host path anymore: on GitHub Pages (any repo/subfolder)
    // the link is built from the live origin + base path, so moving hosting
    // (e.g. /s/index/pchat → /pchat/pchat) never produces stale links.
    // (phoneUrl differs only on localhost, where it points at the LAN IP.)
    let githubUrl = localUrl;

    const primaryUrl = isLocalhost ? phoneUrl : localUrl;
    // Generate the QR in-page so the secret fragment (#k=...) never leaves
    // the device. Only if the bundled library is missing do we fall back to
    // a remote image — and even then the fragment is stripped first.
    let qrCodeUrl = '';
    try {
      if (typeof qrcode !== 'undefined') {
        const qr = qrcode(0, 'M');
        qr.addData(primaryUrl);
        qr.make();
        qrCodeUrl = qr.createDataURL(4, 8);
      }
    } catch { qrCodeUrl = ''; }
    if (!qrCodeUrl) {
      const safeUrl = primaryUrl.split('#')[0];
      qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(safeUrl)}`;
    }

    return {
      phoneUrl,
      localUrl,
      githubUrl,
      qrCodeUrl,
      qrText: primaryUrl,
      defaultUrl: primaryUrl,
    };
  },
};

window.Rooms = Rooms;

// ── Allowed room backends ─────────────────────────────────────────
// A room's backend URL travels in the invite link (?ep=), and the invite
// link is UNTRUSTED input: anybody can craft one. Without this check a
// link like `join.html?r=X&ep=<b64 of https://evil.example/collect>`
// silently repoints the victim's chat at a foreign server — their
// display name, their picture and the room-password verifier are POSTed
// there, and every message they send afterwards travels in plaintext.
//
// Only the endpoints this app actually creates are allowed:
//   • mock://local/<roomId>  — instant (P2P/relay) rooms
//   • https://script.google.com/…            — Apps Script web app
//   • https://script.googleusercontent.com/…  — the same, via the CDN host
const ALLOWED_ENDPOINT_RE = /^https:\/\/script\.google(usercontent)?\.com\/[^\s"'<>]+$/i;
const ALLOWED_MOCK_RE      = /^mock:\/\/local\/[A-Za-z0-9_-]{1,64}$/;

function isAllowedEndpoint(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!u) return false;
  if (ALLOWED_MOCK_RE.test(u)) return true;
  return ALLOWED_ENDPOINT_RE.test(u);
}
window.isAllowedEndpoint = isAllowedEndpoint;

// ── Room API Client ───────────────────────────────────────────────
// All chat operations go through the room's Apps Script web app endpoint.
// Guests NEVER touch the Google Sheet directly.

const RoomAPI = {
  // Shared with the join/create flows so both sides apply the same rule.
  isAllowedEndpoint,

  // Base fetch to the room's Apps Script endpoint
  async _fetch(endpointUrl, method, body) {
    if (endpointUrl && endpointUrl.startsWith('mock://')) {
      return this._mockFetch(endpointUrl, method, body);
    }

    // Choke point: every room operation funnels through here, so a single
    // allow-list check protects join/read/send/moderate alike. An endpoint
    // that is not on the list can only have arrived from a crafted invite
    // link (?ep=) — never from this app's own room creation.
    if (!isAllowedEndpoint(endpointUrl)) {
      throw new Error('This room link points to an unrecognised backend and was refused.');
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
          // Keep the status so the caller learns WHY the request failed
          // (e.g. "HTTP 429: rate limited") instead of a generic
          // "Request failed" after the retries run out.
          lastErr = new Error('HTTP ' + res.status);
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
  async join(endpointUrl, { displayName, memberId, sessionToken, picture, passwordHash }) {
    return this.post(endpointUrl, { action: 'join', displayName, memberId, sessionToken, picture: picture || '', passwordHash: passwordHash || '' });
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

  // ── Mock Fetch with Universal Cross-Device Cloud Sync (Quick P2P mode) ──
  async _mockFetch(endpointUrl, method, body) {
    const rawUrl = endpointUrl.replace('mock://local/', '');
    const roomId = rawUrl.split('?')[0];
    const params = method === 'GET' ? body : body;
    const action = params?.action || 'room';
    const mockStorageKey = 'shepu_mock_room_' + roomId;
    // Private (secret-derived) + legacy topics. Best-effort secret lookup —
    // falls back to legacy topic so old clients keep working.
    // Password-locked rooms ALWAYS use the password-derived topic secret
    // (link secrets are meaningless there — links carry no key).
    const _sec = (() => {
      try {
        if (typeof RoomPassword !== 'undefined' && RoomPassword.storedTopicSecret) {
          const pw = RoomPassword.storedTopicSecret(roomId);
          if (pw) return pw;
        }
        const reg = (typeof Rooms !== 'undefined' && Rooms.getRoom) ? Rooms.getRoom(roomId) : null;
        if (reg && reg.secret) return reg.secret;
        const sess = (typeof Storage !== 'undefined' && Storage.getSession) ? Storage.getSession() : null;
        if (sess && sess.roomId === roomId && sess.roomSecret) return sess.roomSecret;
      } catch {}
      return null;
    })();
    const _topics = (typeof InstantSecurity !== 'undefined')
      ? InstantSecurity.topicsFor(roomId, _sec)
      : [`shepu_pchat_${roomId}`];
    // Password-locked rooms: relay ONLY on the private topic — the legacy
    // roomId topic is guessable and must see nothing, not even presence.
    try {
      const _regLocked = (typeof Rooms !== 'undefined' && Rooms.getRoom)
        ? (Rooms.getRoom(roomId) || {}).passwordLocked === true : false;
      if (_regLocked && _topics.length > 1) _topics.splice(1);
    } catch {}
    const _relay = (payload) => {
      const rawBody = (typeof payload === 'string') ? payload : JSON.stringify(payload);
      // Multi-server failover (one blocked relay can no longer kill a room).
      if (typeof ShepuRelay !== 'undefined' && ShepuRelay.publish) {
        ShepuRelay.publish(rawBody, _topics).catch(() => {});
        return;
      }
      _topics.forEach(t => {
        try {
          fetch(`https://ntfy.sh/${t}`, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body: rawBody,
          }).catch(() => {});
        } catch {}
      });
    };

    let roomData;
    try {
      roomData = JSON.parse(localStorage.getItem(mockStorageKey)) || { messages: [], members: [] };
    } catch {
      roomData = { messages: [], members: [] };
    }

    if (!Array.isArray(roomData.messages)) roomData.messages = [];
    if (!Array.isArray(roomData.members)) roomData.members = [];

    // Persist the local mirror of the room. This is BEST EFFORT: the mock
    // store grows with every message, and a full (or blocked) localStorage
    // used to throw a QuotaExceededError out of sendMessage — the message was
    // then marked "failed" even though the relay publish would have worked.
    const _persistMockRoom = () => {
      try {
        localStorage.setItem(mockStorageKey, JSON.stringify(roomData));
        return true;
      } catch (e) {
        try { console.warn('[mock] could not persist room data:', (e && e.name) || e); } catch {}
        return false;
      }
    };

    if (action === 'room') {
      // Guests on other devices have no local mock row — fall back to the
      // registry/session name before surrendering to 'Private Room'.
      let fallbackName = '';
      let fallbackLocked = false;
      try {
        const reg = (typeof Rooms !== 'undefined' && Rooms.getRoom) ? Rooms.getRoom(roomId) : null;
        if (reg && reg.name && reg.name !== 'Private Room') fallbackName = reg.name;
        if (reg && reg.passwordLocked === true) fallbackLocked = true;
        if (!fallbackName) {
          const sess = (typeof Storage !== 'undefined' && Storage.getSession) ? Storage.getSession() : null;
          if (sess && sess.roomId === roomId && sess.roomName && sess.roomName !== 'Private Room') fallbackName = sess.roomName;
        }
      } catch {}
      // Status is persisted by owner ops; never hardcode 'active' or the
      // UI would keep reporting a disabled/locked/deleted room as live.
      const roomStatus = roomData.status || 'active';
      const roomObj = {
        id: roomId,
        name: roomData.name || fallbackName || 'Private Room',
        description: roomData.description || 'Welcome to the room!',
        status: roomStatus,
        created_at: roomData.created_at || new Date().toISOString(),
        passwordLocked: !!(roomData.passwordLocked || fallbackLocked),
      };
      return {
        success: true,
        room: roomObj,
        room_id: roomId,
        room_name: roomObj.name,
        status: roomStatus,
        created_at: roomObj.created_at,
      };
    }

    if (action === 'join') {
      // Match the Apps Script backend: disabled/deleted rooms reject joins.
      const joinStatus = roomData.status || 'active';
      if (joinStatus === 'disabled') return { success: false, code: 'DISABLED', error: 'Room is disabled' };
      if (joinStatus === 'deleted')  return { success: false, code: 'DELETED',  error: 'Room has been deleted' };
      const displayName = params.displayName || localStorage.getItem('shepu_display_name') || 'Guest';
      const incomingId = params.memberId || null;
      const memberId = incomingId || ('u_' + Date.now());
      const picture = params.picture || '';
      // Preserve existing role on re-join; room creator on owner device is always 'owner'.
      const isOwnerDevice = (() => {
        try {
          const myRooms = (typeof Rooms !== 'undefined' && Rooms.getMyRooms) ? Rooms.getMyRooms() : [];
          if (myRooms.some(r => r.id === roomId)) return true;
          const sess = (typeof Storage !== 'undefined' && Storage.getSession) ? Storage.getSession() : null;
          if (sess && sess.roomId === roomId && sess.role === 'owner') return true;
        } catch {}
        return false;
      })();
      const existingMember = roomData.members.find(m => (m.id || m.memberId) === memberId);
      // The role comes from THIS device's session or from the stored member
      // row only. The old "u_owner_" prefix check let any guest claim the
      // owner role by sending a crafted memberId.
      const role = isOwnerDevice
        ? 'owner'
        : (existingMember ? (existingMember.role || 'member') : 'member');

      // Broadcast join to public relay (works on GitHub Pages & phones)
      // NOTE: join carries no secret — P2P proof is verified separately.
      _relay({ type: 'join', memberId, displayName, role, picture });

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
      _persistMockRoom();
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

      // The cursor is a MONOTONIC sequence number, never the array index.
      // Using the index broke after clear_chat: the rows restarted at 1 while
      // clients still held a cursor of 50, so nothing new was ever delivered.
      let seq = Number(roomData.seq) || 0;
      let seqChanged = false;
      const allMsgs = roomData.messages.map((m) => {
        if (typeof m._seq !== 'number' || !isFinite(m._seq)) {
          seq += 1;
          m._seq = seq;
          seqChanged = true;
        } else if (m._seq > seq) {
          seq = m._seq;
        }
        return m;
      });
      if (seqChanged || Number(roomData.seq) !== seq) {
        roomData.seq = seq;
        _persistMockRoom();
      }

      const newMsgs = afterRow > 0 ? allMsgs.filter(m => m._seq > afterRow) : allMsgs;

      return {
        success: true,
        messages: newMsgs,
        total: allMsgs.length,
        lastRow: seq,
      };
    }

    if (action === 'message') {
      const sendStatus = roomData.status || 'active';
      if (sendStatus === 'locked')   return { success: false, code: 'LOCKED',   error: 'Room is locked' };
      if (sendStatus === 'disabled') return { success: false, code: 'DISABLED', error: 'Room is disabled' };
      if (sendStatus === 'deleted')  return { success: false, code: 'DELETED',  error: 'Room has been deleted' };
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
        // Monotonic sequence — survives clear_chat, so clients keep polling
        // from the right place.
        roomData.seq = (Number(roomData.seq) || 0) + 1;
        newMsg._seq = roomData.seq;
        roomData.messages.push(newMsg);
        _persistMockRoom();
      }

      // NOTE: the message is NOT relayed from here. chat.js broadcasts every
      // message itself (P2P + cloud relay) right after the send succeeds,
      // so relaying here as well published every message TWICE — twice the
      // traffic and twice the exposure to the relay's payload size limit.

      return { success: true, messageId: newMsg.id };
    }

    if (action === 'delete') {
      const msg = roomData.messages.find(m => m.id === params.messageId);
      if (msg) {
        msg.deleted = true;
        _persistMockRoom();
      }
      return { success: true };
    }

    if (action === 'edit') {
      const msg = roomData.messages.find(m => m.id === params.messageId);
      if (msg) {
        msg.message = params.message;
        msg.edited = true;
        _persistMockRoom();
      }
      return { success: true };
    }

    if (action === 'presence') {
      // Record heartbeat so same-device rosters + last-seen are truthful.
      const mid = params.memberId;
      if (mid) {
        const ix = roomData.members.findIndex(m => (m.id || m.memberId) === mid);
        if (ix >= 0) {
          roomData.members[ix] = {
            ...roomData.members[ix],
            status: params.status || 'online',
            lastActive: Date.now(),
          };
          _persistMockRoom();
        }
      }
      return { success: true };
    }

    if (action === 'leave') {
      const mid = params.memberId;
      if (mid) {
        const ix = roomData.members.findIndex(m => (m.id || m.memberId) === mid);
        if (ix >= 0) {
          roomData.members[ix] = { ...roomData.members[ix], status: 'offline', lastActive: Date.now() };
          _persistMockRoom();
        }
      }
      return { success: true };
    }

    if (action === 'room_op') {
      const op = params.op;
      // Mock rooms have no server-side session table, so enforce ownership
      // locally: only the creating device's session may run owner operations.
      const isOwnerDevice = (() => {
        try {
          const myRooms = (typeof Rooms !== 'undefined' && Rooms.getMyRooms) ? Rooms.getMyRooms() : [];
          if (myRooms.some(r => r.id === roomId)) return true;
          const sess = (typeof Storage !== 'undefined' && Storage.getSession) ? Storage.getSession() : null;
          return !!(sess && sess.roomId === roomId && sess.role === 'owner');
        } catch { return false; }
      })();
      if (!isOwnerDevice) return { success: false, code: 'FORBIDDEN', error: 'Owner only' };

      if (op === 'get_stats') {
        return {
          success: true,
          memberCount: (roomData.members || []).length,
          messageCount: (roomData.messages || []).length,
        };
      }
      if (op === 'clear_chat') {
        roomData.messages = [];
        _persistMockRoom();
        return { success: true };
      }
      if (op === 'lock' || op === 'unlock' || op === 'disable' || op === 'enable') {
        roomData.status = op === 'lock' ? 'locked' : op === 'disable' ? 'disabled' : 'active';
        _persistMockRoom();
        // Tell connected guests immediately; otherwise only this device
        // sees the room as locked/disabled.
        _relay({ type: 'room_status', status: roomData.status, roomId, updatedBy: params.memberId });
        return { success: true };
      }
      if (op === 'delete') {
        roomData.status = 'deleted';
        _persistMockRoom();
        _relay({ type: 'room_status', status: 'deleted', roomId, updatedBy: params.memberId });
        return { success: true };
      }
      if (op === 'rename' && params.name) {
        roomData.name = String(params.name).slice(0, 80);
        _persistMockRoom();
        return { success: true };
      }
      if ((op === 'ban_member' || op === 'remove_member') && params.targetId) {
        roomData.members = (roomData.members || []).filter(m => (m.id || m.memberId) !== params.targetId);
        _persistMockRoom();
        return { success: true };
      }
      if (op === 'set_password' && /^[0-9a-f]{64}$/i.test(String(params.passwordHash || ''))) {
        roomData.passwordHash = String(params.passwordHash).toLowerCase();
        roomData.passwordLocked = true;
        _persistMockRoom();
        return { success: true, passwordLocked: true };
      }
      if (op === 'remove_password') {
        roomData.passwordHash = '';
        roomData.passwordLocked = false;
        _persistMockRoom();
        return { success: true, passwordLocked: false };
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

