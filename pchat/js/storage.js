/**
 * SHEPU ROOMS — storage.js
 * localStorage / sessionStorage helpers + IndexedDB wrapper
 */

const Storage = {
  // ── LocalStorage ─────────────────────────────────────────────
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('Storage.set error', e); }
  },

  get(key) {
    try {
      const v = localStorage.getItem(key);
      return v !== null ? JSON.parse(v) : null;
    } catch { return null; }
  },

  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },

  // ── Auth ─────────────────────────────────────────────────────
  setAuth(authObj) { this.set(CONFIG.LS_AUTH, authObj); },
  getAuth()        { return this.get(CONFIG.LS_AUTH); },
  clearAuth()      { this.remove(CONFIG.LS_AUTH); },

  // ── Rooms ─────────────────────────────────────────────────────
  setRooms(rooms) { this.set(CONFIG.LS_ROOMS, rooms); },
  getRooms()      { return this.get(CONFIG.LS_ROOMS) || { myRooms: [], joinedRooms: [] }; },

  addMyRoom(room) {
    const data = this.getRooms();
    data.myRooms = data.myRooms.filter(r => r.id !== room.id);
    data.myRooms.unshift(room);
    this.setRooms(data);
  },

  addJoinedRoom(room) {
    const data = this.getRooms();
    data.joinedRooms = data.joinedRooms.filter(r => r.id !== room.id);
    data.joinedRooms.unshift(room);
    this.setRooms(data);
  },

  updateRoom(roomId, updates) {
    const data = this.getRooms();
    data.myRooms = data.myRooms.map(r => r.id === roomId ? { ...r, ...updates } : r);
    data.joinedRooms = data.joinedRooms.map(r => r.id === roomId ? { ...r, ...updates } : r);
    this.setRooms(data);
  },

  removeRoom(roomId) {
    const data = this.getRooms();
    data.myRooms    = data.myRooms.filter(r => r.id !== roomId);
    data.joinedRooms = data.joinedRooms.filter(r => r.id !== roomId);
    this.setRooms(data);
  },

  // ── Session (current room chat session) ──────────────────────
  setSession(session) { this.set(CONFIG.LS_SESSION, session); },
  getSession()        { return this.get(CONFIG.LS_SESSION); },
  clearSession()      { this.remove(CONFIG.LS_SESSION); },

  // ── Current Room ─────────────────────────────────────────────
  setCurrentRoom(roomId) { this.set(CONFIG.LS_CURRENT_ROOM, roomId); },
  clearCurrentRoom()     { this.remove(CONFIG.LS_CURRENT_ROOM); },

  // ── Pending Messages (offline queue) ─────────────────────────
  getPendingMessages(roomId) {
    return this.get(`pending_${roomId}`) || [];
  },
  addPendingMessage(roomId, msg) {
    const q = this.getPendingMessages(roomId);
    q.push(msg);
    this.set(`pending_${roomId}`, q);
  },
  removePendingMessage(roomId, messageId) {
    const q = this.getPendingMessages(roomId).filter(m => m.id !== messageId);
    this.set(`pending_${roomId}`, q);
  },

  // ── Sync cursors ─────────────────────────────────────────────
  // The cursor is a ROW NUMBER. Older builds stored an object
  // ({ lastRow: N }); reading it back as a number produced
  // "afterRow=[object Object]", so the backend always started from row 0 and
  // a reload only ever returned the newest 50 rows.
  getSyncCursor(roomId) {
    const raw = this.get(`sync_${roomId}`);
    if (raw == null) return 0;
    if (typeof raw === 'object') return Number(raw.lastRow) || 0;
    return Number(raw) || 0;
  },
  setSyncCursor(roomId, cursor) {
    const n = (cursor && typeof cursor === 'object') ? (Number(cursor.lastRow) || 0) : (Number(cursor) || 0);
    this.set(`sync_${roomId}`, n);
  },

  // ── Room Messages Persistence ─────────────────────────────────
  getRoomStoredMessages(roomId) {
    try {
      const data = JSON.parse(localStorage.getItem('shepu_mock_room_' + roomId));
      return Array.isArray(data?.messages) ? data.messages : [];
    } catch { return []; }
  },
  saveRoomMessages(roomId, msgs) {
    if (!roomId || !msgs || !msgs.length) return;
    try {
      const key = 'shepu_mock_room_' + roomId;
      const data = JSON.parse(localStorage.getItem(key)) || { messages: [], members: [] };
      if (!Array.isArray(data.messages)) data.messages = [];
      const msgList = Array.isArray(msgs) ? msgs : [msgs];
      let added = false;
      msgList.forEach(m => {
        if (m && m.id && !data.messages.some(x => x.id === m.id)) {
          data.messages.push(m);
          added = true;
        }
      });
      if (added) {
        data.messages.sort((a, b) => new Date(a.createdAt || a.timestamp || 0) - new Date(b.createdAt || b.timestamp || 0));
        localStorage.setItem(key, JSON.stringify(data));
      }
    } catch (e) { console.warn('Storage.saveRoomMessages error', e); }
  },
};

window.Storage = Storage;

// ── IndexedDB Wrapper ─────────────────────────────────────────────
const IDBStorage = (() => {
  let db = null;

  const STORES = {
    MESSAGES: 'messages',
    ROOMS:    'rooms',
    MEMBERS:  'members',
  };

  async function open() {
    if (db) return db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CONFIG.IDB_NAME, CONFIG.IDB_VERSION);

      req.onupgradeneeded = (e) => {
        const idb = e.target.result;

        if (!idb.objectStoreNames.contains(STORES.MESSAGES)) {
          const ms = idb.createObjectStore(STORES.MESSAGES, { keyPath: 'id' });
          ms.createIndex('roomId',    'roomId',    { unique: false });
          ms.createIndex('createdAt', 'createdAt', { unique: false });
        }

        if (!idb.objectStoreNames.contains(STORES.ROOMS)) {
          idb.createObjectStore(STORES.ROOMS, { keyPath: 'id' });
        }

        if (!idb.objectStoreNames.contains(STORES.MEMBERS)) {
          const mem = idb.createObjectStore(STORES.MEMBERS, { keyPath: 'id' });
          mem.createIndex('roomId', 'roomId', { unique: false });
        }
      };

      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror   = ()  => reject(req.error);
    });
  }

  function txn(storeName, mode = 'readonly') {
    return db.transaction([storeName], mode).objectStore(storeName);
  }

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  return {
    STORES,

    async init() { await open(); },

    // Messages
    async putMessage(msg) {
      await open();
      return promisify(txn(STORES.MESSAGES, 'readwrite').put(msg));
    },

    async putMessages(msgs) {
      await open();
      const store = txn(STORES.MESSAGES, 'readwrite');
      return Promise.all(msgs.map(m => promisify(store.put(m))));
    },

    async getMessages(roomId, limit = 100) {
      await open();
      return new Promise((resolve, reject) => {
        const store  = txn(STORES.MESSAGES).index('roomId');
        const req    = store.getAll(IDBKeyRange.only(roomId));
        req.onsuccess = () => {
          const all = req.result || [];
          all.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
          resolve(all.slice(-limit));
        };
        req.onerror = () => reject(req.error);
      });
    },

    async updateMessage(id, updates) {
      await open();
      const store = txn(STORES.MESSAGES, 'readwrite');
      return new Promise((resolve, reject) => {
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          if (!getReq.result) return resolve(null);
          const updated = { ...getReq.result, ...updates };
          const putReq = store.put(updated);
          putReq.onsuccess = () => resolve(updated);
          putReq.onerror   = () => reject(putReq.error);
        };
        getReq.onerror = () => reject(getReq.error);
      });
    },

    async clearRoomMessages(roomId) {
      await open();
      const store = txn(STORES.MESSAGES, 'readwrite').index('roomId');
      return new Promise((resolve, reject) => {
        const req = store.openCursor(IDBKeyRange.only(roomId));
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
          else resolve();
        };
        req.onerror = () => reject(req.error);
      });
    },

    // Rooms
    async putRoom(room) {
      await open();
      return promisify(txn(STORES.ROOMS, 'readwrite').put(room));
    },

    async getRoom(id) {
      await open();
      return promisify(txn(STORES.ROOMS).get(id));
    },

    // Members
    async putMembers(roomId, members) {
      await open();
      const store = txn(STORES.MEMBERS, 'readwrite');
      return Promise.all(members.map(m => promisify(store.put({ ...m, roomId }))));
    },

    async getMembers(roomId) {
      await open();
      return new Promise((resolve, reject) => {
        const req = txn(STORES.MEMBERS).index('roomId').getAll(IDBKeyRange.only(roomId));
        req.onsuccess = () => resolve(req.result || []);
        req.onerror   = () => reject(req.error);
      });
    },

    async clearAll() {
      await open();
      const names = [STORES.MESSAGES, STORES.ROOMS, STORES.MEMBERS];
      return Promise.all(names.map(name => promisify(txn(name, 'readwrite').clear())));
    },
  };
})();

window.IDBStorage = IDBStorage;

// Initialize IDB on load
IDBStorage.init().catch(e => console.warn('IDB init failed (non-critical):', e));
