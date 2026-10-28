/**
 * SHEPU ROOMS — Config
 * Central configuration. Never commit real secrets here.
 * Dynamically loads Google Client ID from localStorage if configured.
 */

const savedClientId = (typeof localStorage !== 'undefined') ? localStorage.getItem('shepu_google_client_id') : null;

function normalizeIceServerList(...groups) {
  const result = [];
  const seen = new Set();
  groups.flat().forEach(server => {
    if (!server || typeof server !== 'object' || !server.urls) return;
    const urls = Array.isArray(server.urls) ? server.urls.filter(url => typeof url === 'string') : server.urls;
    if ((Array.isArray(urls) && !urls.length) || (!Array.isArray(urls) && typeof urls !== 'string')) return;
    const normalized = { ...server, urls };
    const key = JSON.stringify(normalized);
    if (!seen.has(key)) { seen.add(key); result.push(normalized); }
  });
  return result;
}

// ── Hardcoded Google Client ID (registered for this app) ──────────
// Client Secret is NOT stored here — it is not needed for client-side OAuth.
const HARDCODED_CLIENT_ID = '199864473289-e151rru9i5vkimgserucoruhrpvp2niu.apps.googleusercontent.com';

// Optional app-wide Metered TURN setup. Use only the TURN credentials API key
// issued by Metered (browser-visible by design), never the account Secret Key.
// These may also be set per device in Settings → Relay.
const METERED_TURN_APP_NAME = '';
const METERED_TURN_API_KEY = '';

const CONFIG = {
  // ── Google OAuth ──────────────────────────────────────────────
  // Uses localStorage override first (for dev/testing), otherwise uses hardcoded ID
  GOOGLE_CLIENT_ID: (savedClientId && savedClientId.trim()) || HARDCODED_CLIENT_ID,

  isGoogleConfigured() {
    return !!(this.GOOGLE_CLIENT_ID &&
              this.GOOGLE_CLIENT_ID.trim() !== '' &&
              !this.GOOGLE_CLIENT_ID.includes('YOUR_GOOGLE_CLIENT_ID'));
  },

  setClientId(clientId) {
    if (!clientId) return false;
    const clean = clientId.trim();
    localStorage.setItem('shepu_google_client_id', clean);
    this.GOOGLE_CLIENT_ID = clean;
    if (typeof window !== 'undefined' && window.Auth && typeof window.Auth.resetTokenClient === 'function') {
      window.Auth.resetTokenClient();
    }
    return true;
  },

  clearClientId() {
    localStorage.removeItem('shepu_google_client_id');
    this.GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
    if (typeof window !== 'undefined' && window.Auth && typeof window.Auth.resetTokenClient === 'function') {
      window.Auth.resetTokenClient();
    }
  },

  // OAuth scopes
  AUTH_SCOPES: 'openid email profile',
  DRIVE_SCOPES: [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.metadata.readonly',
    'https://www.googleapis.com/auth/script.projects',
    'https://www.googleapis.com/auth/script.deployments',
    'openid',
    'email',
    'profile',
  ].join(' '),
  OAUTH_SCOPES: [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.projects',
    'https://www.googleapis.com/auth/script.deployments',
    'openid',
    'email',
    'profile',
  ].join(' '),

  // ── API Base URLs ─────────────────────────────────────────────
  DRIVE_API:   'https://www.googleapis.com/drive/v3',
  SHEETS_API:  'https://sheets.googleapis.com/v4/spreadsheets',
  SCRIPT_API:  'https://script.googleapis.com/v1',

  // ── App Settings ──────────────────────────────────────────────
  APP_NAME:         'Pchat shepu',
  APP_TAGLINE:      'Fast & Private Messaging',
  FOLDER_NAME:      'SHEPU ROOMS',          // Keep Drive folder compatible
  SHEET_PREFIX:     'Pchat Shepu — ',        // Prefix for each room's spreadsheet name
  ROOM_ID_LENGTH:   12,
  TOKEN_LENGTH:     32,

  // ── WebRTC TURN relay configuration ───────────────────────────
  // Metered's browser API key is public by design; never use an account secret.
  TURN_METERED_CONFIG_KEY: 'shepu_turn_metered_config',
  TURN_CUSTOM_ICE_KEY: 'shepu_turn_custom_ice_servers',

  getMeteredTurnConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.TURN_METERED_CONFIG_KEY) || '{}');
      return {
        appName: String(saved.appName || METERED_TURN_APP_NAME || '').trim(),
        apiKey: String(saved.apiKey || METERED_TURN_API_KEY || '').trim(),
      };
    } catch { return { appName: METERED_TURN_APP_NAME, apiKey: METERED_TURN_API_KEY }; }
  },

  setMeteredTurnConfig(config) {
    if (!config || typeof config !== 'object') return false;
    const value = {
      appName: String(config.appName || '').trim(),
      apiKey: String(config.apiKey || '').trim(),
    };
    try { localStorage.setItem(this.TURN_METERED_CONFIG_KEY, JSON.stringify(value)); return true; }
    catch { return false; }
  },

  getCustomIceServers() {
    try {
      const saved = JSON.parse(localStorage.getItem(this.TURN_CUSTOM_ICE_KEY) || '[]');
      return Array.isArray(saved) ? normalizeIceServerList(saved) : [];
    } catch { return []; }
  },

  setCustomIceServers(servers) {
    if (!Array.isArray(servers)) return false;
    const valid = normalizeIceServerList(servers);
    try { localStorage.setItem(this.TURN_CUSTOM_ICE_KEY, JSON.stringify(valid)); return true; }
    catch { return false; }
  },

  clearTurnConfig() {
    try {
      localStorage.removeItem(this.TURN_METERED_CONFIG_KEY);
      localStorage.removeItem(this.TURN_CUSTOM_ICE_KEY);
    } catch {}
  },

  getBaseIceServers() {
    return normalizeIceServerList([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ], this.getCustomIceServers());
  },

  async getIceServers() {
    const base = this.getBaseIceServers();
    const { appName, apiKey } = this.getMeteredTurnConfig();
    if (!appName || !apiKey) return base;
    if (!/^[a-z0-9-]{1,63}$/i.test(appName)) throw new Error('Invalid Metered app name.');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const url = 'https://' + appName + '.metered.live/api/v1/turn/credentials?apiKey=' + encodeURIComponent(apiKey);
      const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('Metered TURN credentials request failed (' + response.status + ').');
      const payload = await response.json();
      const provided = Array.isArray(payload) ? payload : payload && payload.iceServers;
      if (!Array.isArray(provided) || !provided.length) throw new Error('Metered returned no ICE servers.');
      return normalizeIceServerList(base, provided);
    } finally { clearTimeout(timeout); }
  },

  async testTurn() {
    let iceServers;
    try { iceServers = await this.getIceServers(); }
    catch { return { ok: false, configured: true, relayCandidates: 0, error: 'Could not fetch TURN credentials. Check the Metered app name, API key, and network.' }; }

    const hasTurn = iceServers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls])
      .some(url => /^turns?:/i.test(url)));
    if (!hasTurn) return { ok: false, configured: false, relayCandidates: 0, error: 'No TURN server is configured. STUN alone cannot relay media through restrictive NATs.' };
    if (typeof RTCPeerConnection === 'undefined') return { ok: false, configured: true, relayCandidates: 0, error: 'This browser does not support RTCPeerConnection.' };

    let pc;
    try { pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: 'relay' }); }
    catch { return { ok: false, configured: true, relayCandidates: 0, error: 'The browser rejected the TURN server configuration.' }; }
    const startedAt = Date.now();
    try {
      return await new Promise(resolve => {
        let finished = false;
        let relayCandidates = 0;
        let timer;
        const finish = error => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve({ ok: relayCandidates > 0, configured: true, relayCandidates, elapsedMs: Date.now() - startedAt,
            error: error || (relayCandidates ? '' : 'No TURN relay candidate gathered. The relay may be blocked, offline, or credentials may be invalid.') });
        };
        pc.onicecandidate = event => {
          if (event.candidate && /\btyp relay\b/.test(event.candidate.candidate || '')) relayCandidates++;
          if (!event.candidate) finish('');
        };
        pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') finish(''); };
        timer = setTimeout(() => finish('Timed out while gathering TURN candidates.'), 15000);
        pc.createDataChannel('turn-health-check');
        pc.createOffer().then(offer => pc.setLocalDescription(offer)).catch(() => finish('Could not start ICE candidate gathering.'));
      });
    } finally { try { pc.close(); } catch {} }
  },

  // ── Message / Sync Settings ───────────────────────────────────

  SYNC_INTERVAL_MS:      2000,   // How often to poll for new messages (ms)
  PRESENCE_INTERVAL_MS: 15000,   // Presence heartbeat
  MAX_MESSAGE_LENGTH:    4000,   // Characters
  MAX_RETRY_ATTEMPTS:       5,
  BASE_BACKOFF_MS:        500,

  // ── Local Storage Keys ────────────────────────────────────────
  LS_AUTH:         'shepu_auth',
  LS_ROOMS:        'shepu_rooms',
  LS_CURRENT_ROOM: 'shepu_current_room',
  LS_SESSION:      'shepu_session',

  // ── IndexedDB ────────────────────────────────────────────────
  IDB_NAME:    'SHEPURooms',
  IDB_VERSION:  1,

  // ── Sheet Tab Names ───────────────────────────────────────────
  SHEETS: {
    MESSAGES:    'messages',
    MEMBERS:     'members',
    ROOM_CONFIG: 'room_config',
    ATTACHMENTS: 'attachments',
    MODERATION:  'moderation',
    SYNC_STATE:  'sync_state',
  },

  // ── Firebase Social Layer Kill Switches ───────────────────────
  // Set to false to disable the social layer without removing script tags.
  // Chat, rooms, and calls continue working regardless of these flags.
  // At 70 % of daily Firestore quota: reduce PRESENCE throttle to 20 min.
  // At 85 % quota: set PRESENCE_ENABLED = false (cached "last seen" shown).
  FRIENDS_ENABLED:  true,   // friend graph, search, requests, invites
  PRESENCE_ENABLED: true,   // lastActiveAt heartbeat + "active now" status
};

// Make globally accessible
window.CONFIG = CONFIG;
