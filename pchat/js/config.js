/**
 * SHEPU ROOMS — Config
 * Central configuration. Never commit real secrets here.
 * Dynamically loads Google Client ID from localStorage if configured.
 */

const savedClientId = (typeof localStorage !== 'undefined') ? localStorage.getItem('shepu_google_client_id') : null;

// ── Hardcoded Google Client ID (registered for this app) ──────────
// Client Secret is NOT stored here — it is not needed for client-side OAuth.
const HARDCODED_CLIENT_ID = '199864473289-e151rru9i5vkimgserucoruhrpvp2niu.apps.googleusercontent.com';


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
