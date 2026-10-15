/**
 * SHEPU CHAT — p2p-sync.js
 * Real-time peer-to-peer WebRTC data mesh powered by PeerJS.
 * Connects host and guests directly across remote devices (phones & PCs)
 * on GitHub Pages without requiring external relay servers.
 */

const P2PSync = (() => {
  let _peer = null;
  let _roomId = null;
  let _isHost = false;
  let _memberId = null;
  let _displayName = null;
  let _connections = new Map(); // peerId -> DataConnection
  let _onMessageCb = null;
  let _onHistoryRequestCb = null;
  let _onMembersUpdateCb = null;
  let _onTypingCb = null;
  let _reconnectTimer = null;
  let _activeMembers = new Map(); // memberId -> { id, name, role, lastSeen }

  function getHostPeerId(roomId) {
    // Sanitized alphanumeric peer ID for PeerJS
    const cleanId = String(roomId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
    return `pchat_h_${cleanId}`;
  }

  function getGuestPeerId(roomId, memberId) {
    const cleanRoom = String(roomId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
    const cleanMember = String(memberId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
    const rand = Math.random().toString(36).slice(2, 6);
    return `pchat_g_${cleanRoom}_${cleanMember}_${rand}`;
  }

  function init({ roomId, isHost, memberId, displayName, onMessage, onHistoryRequest, onMembersUpdate, onTyping }) {
    if (typeof Peer === 'undefined') {
      console.warn('[P2PSync] PeerJS library not loaded.');
      return;
    }

    // Clean up any existing instance
    destroy();

    _roomId = roomId;
    _isHost = !!isHost;
    _memberId = memberId;
    _displayName = displayName;
    _onMessageCb = onMessage;
    _onHistoryRequestCb = onHistoryRequest;
    _onMembersUpdateCb = onMembersUpdate;
    _onTypingCb = onTyping;

    _activeMembers.set(_memberId, {
      memberId: _memberId,
      id: _memberId,
      displayName: _displayName,
      name: _displayName,
      role: _isHost ? 'owner' : 'member',
      lastSeen: Date.now()
    });

    if (_isHost) {
      _initHost();
    } else {
      _initGuest();
    }
  }

  // ── Host Peer Initialization ──────────────────────────────────
  function _initHost() {
    const hostId = getHostPeerId(_roomId);
    console.log('[P2PSync] Starting Host Peer:', hostId);

    try {
      _peer = new Peer(hostId, {
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
          ]
        }
      });
    } catch (err) {
      console.warn('[P2PSync] Host peer init error:', err);
      return;
    }

    _peer.on('open', (id) => {
      console.log('[P2PSync] Host online as peer:', id);
    });

    _peer.on('connection', (conn) => {
      console.log('[P2PSync] Guest connecting:', conn.peer);
      _setupHostConnection(conn);
    });

    _peer.on('error', (err) => {
      console.warn('[P2PSync] Host Peer error:', err && err.type, err && err.message);
      // If host ID is temporarily taken (e.g. reload before timeout), retry with short backoff
      if (err && err.type === 'unavailable-id') {
        setTimeout(() => {
          if (_isHost && (!_peer || _peer.destroyed)) _initHost();
        }, 3000);
      }
    });

    _peer.on('disconnected', () => {
      if (_peer && !_peer.destroyed) {
        try { _peer.reconnect(); } catch {}
      }
    });
  }

  function _setupHostConnection(conn) {
    conn.on('open', () => {
      console.log('[P2PSync] Guest connection open:', conn.peer);
      _connections.set(conn.peer, conn);

      // Send recent message history to the newly connected guest
      if (_onHistoryRequestCb) {
        const history = _onHistoryRequestCb() || [];
        if (history.length) {
          conn.send({ type: 'history', messages: history });
        }
      }
    });

    conn.on('data', (data) => {
      _handleHostIncomingData(conn, data);
    });

    conn.on('close', () => {
      console.log('[P2PSync] Guest disconnected:', conn.peer);
      _connections.delete(conn.peer);
      // Remove ghost member entries tied to this connection (best-effort)
      try {
        for (const [mid, m] of Array.from(_activeMembers.entries())) {
          if (m.peerId === conn.peer) _activeMembers.delete(mid);
        }
      } catch {}
      _notifyMembersUpdate();
    });

    conn.on('error', (err) => {
      console.warn('[P2PSync] Guest conn error:', err);
      _connections.delete(conn.peer);
      try {
        for (const [mid, m] of Array.from(_activeMembers.entries())) {
          if (m.peerId === conn.peer) _activeMembers.delete(mid);
        }
      } catch {}
    });
  }

  function _handleHostIncomingData(conn, data) {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'join') {
      const mem = data.member;
      if (mem && (mem.id || mem.memberId)) {
        const mid = mem.memberId || mem.id;
        _activeMembers.set(mid, {
          memberId: mid,
          id: mid,
          displayName: mem.displayName || mem.name || 'Guest',
          name: mem.displayName || mem.name || 'Guest',
          role: 'member',
          peerId: conn.peer,
          lastSeen: Date.now()
        });
        _notifyMembersUpdate();
      }
      return;
    }

    if (data.type === 'message' && data.message) {
      const msg = data.message;
      // 1. Fire local message callback on host (which updates UI & saves to Google Sheet!)
      if (_onMessageCb) {
        _onMessageCb([msg]);
      }

      // 2. Broadcast to all other connected guests
      _connections.forEach((c, peerId) => {
        if (peerId !== conn.peer && c.open) {
          try { c.send({ type: 'message', message: msg }); } catch {}
        }
      });
    }

    if (data.type === 'seen' && data.seenBy) {
      // Relay seen event to all connections (so sender's tick turns blue)
      _connections.forEach((c, peerId) => {
        if (c.open) {
          try { c.send({ type: 'seen', seenBy: data.seenBy, messageIds: data.messageIds }); } catch {}
        }
      });
      // Also fire locally on host
      if (_onMessageCb) {
        _onMessageCb([{ _seenEvent: true, seenBy: data.seenBy, messageIds: data.messageIds }]);
      }
    }

    if (data.type === 'reaction' && data.reaction) {
      // Relay reaction to all connections
      _connections.forEach((c) => {
        if (c.open) { try { c.send({ type: 'reaction', reaction: data.reaction }); } catch {} }
      });
      // Fire locally on host
      if (_onMessageCb) {
        _onMessageCb([{ _reactionEvent: true, ...data.reaction }]);
      }
    }

    if (data.type === 'music_sync' && data.payload) {
      // Relay music sync event to all connections
      _connections.forEach((c) => {
        if (c.open) { try { c.send({ type: 'music_sync', payload: data.payload }); } catch {} }
      });
      // Fire locally on host
      if (_onMessageCb) {
        _onMessageCb([{ _musicEvent: true, payload: data.payload }]);
      }
    }

    if (data.type === 'typing' && data.memberId) {
      // Relay typing indicator to all OTHER connections
      _connections.forEach((c, peerId) => {
        if (peerId !== conn.peer && c.open) {
          try { c.send({ type: 'typing', memberId: data.memberId, displayName: data.displayName, isTyping: data.isTyping }); } catch {}
        }
      });
      if (_onTypingCb) {
        _onTypingCb({ memberId: data.memberId, displayName: data.displayName, isTyping: data.isTyping });
      }
    }
  }

  // ── Guest Peer Initialization ─────────────────────────────────
  function _initGuest() {
    const guestId = getGuestPeerId(_roomId, _memberId);
    console.log('[P2PSync] Starting Guest Peer:', guestId);

    try {
      _peer = new Peer(guestId, {
        debug: 1,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
          ]
        }
      });
    } catch (err) {
      console.warn('[P2PSync] Guest peer init error:', err);
      return;
    }

    _peer.on('open', (id) => {
      console.log('[P2PSync] Guest online as:', id);
      _connectToHost();
    });

    _peer.on('error', (err) => {
      console.warn('[P2PSync] Guest peer error:', err && err.type, err && err.message);
      _scheduleGuestReconnect(5000);
    });

    _peer.on('disconnected', () => {
      if (_peer && !_peer.destroyed) {
        try { _peer.reconnect(); } catch {}
      }
    });
  }

  function _connectToHost() {
    if (!_peer || _peer.destroyed) return;
    const hostId = getHostPeerId(_roomId);
    console.log('[P2PSync] Connecting to Host:', hostId);

    const conn = _peer.connect(hostId, { reliable: true });

    conn.on('open', () => {
      console.log('[P2PSync] Connected to Host successfully!');
      _connections.set('host', conn);

      // Announce identity
      conn.send({
        type: 'join',
        member: { id: _memberId, memberId: _memberId, name: _displayName, displayName: _displayName }
      });
    });

    conn.on('data', (data) => {
      _handleGuestIncomingData(data);
    });

    conn.on('close', () => {
      console.log('[P2PSync] Host connection lost. Will retry…');
      _connections.delete('host');
      _scheduleGuestReconnect(4000);
    });

    conn.on('error', (err) => {
      console.warn('[P2PSync] Conn to host failed:', err);
      _connections.delete('host');
      _scheduleGuestReconnect(4000);
    });
  }

  function _handleGuestIncomingData(data) {
    if (!data || typeof data !== 'object') return;

    if (data.type === 'history' && Array.isArray(data.messages)) {
      if (_onMessageCb) _onMessageCb(data.messages);
    } else if (data.type === 'message' && data.message) {
      if (_onMessageCb) _onMessageCb([data.message]);
    } else if (data.type === 'seen' && data.seenBy) {
      if (_onMessageCb) _onMessageCb([{ _seenEvent: true, seenBy: data.seenBy, messageIds: data.messageIds }]);
    } else if (data.type === 'reaction' && data.reaction) {
      if (_onMessageCb) _onMessageCb([{ _reactionEvent: true, ...data.reaction }]);
    } else if (data.type === 'music_sync' && data.payload) {
      if (_onMessageCb) _onMessageCb([{ _musicEvent: true, payload: data.payload }]);
    } else if (data.type === 'typing' && data.memberId) {
      if (_onTypingCb) {
        _onTypingCb({ memberId: data.memberId, displayName: data.displayName, isTyping: data.isTyping });
      }
    }
  }

  function _scheduleGuestReconnect(delay) {
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    _reconnectTimer = setTimeout(() => {
      if (!_isHost && !_connections.has('host') && _peer && !_peer.destroyed) {
        _connectToHost();
      }
    }, delay);
  }

  function broadcastMessage(msg) {
    if (!msg) return;

    if (_isHost) {
      // Host broadcasts to all connected guests
      _connections.forEach(conn => {
        if (conn.open) {
          try { conn.send({ type: 'message', message: msg }); } catch {}
        }
      });
    } else {
      // Guest sends message to host
      const hostConn = _connections.get('host');
      if (hostConn && hostConn.open) {
        try { hostConn.send({ type: 'message', message: msg }); } catch {}
      }
    }
  }

  function broadcastSeen(seenBy, messageIds) {
    if (!seenBy || !messageIds || !messageIds.length) return;
    const payload = { type: 'seen', seenBy, messageIds };
    if (_isHost) {
      _connections.forEach(conn => {
        if (conn.open) { try { conn.send(payload); } catch {} }
      });
    } else {
      const hostConn = _connections.get('host');
      if (hostConn && hostConn.open) { try { hostConn.send(payload); } catch {} }
    }
  }

  function broadcastReaction(reaction) {
    if (!reaction) return;
    const payload = { type: 'reaction', reaction };
    if (_isHost) {
      _connections.forEach(conn => {
        if (conn.open) { try { conn.send(payload); } catch {} }
      });
    } else {
      const hostConn = _connections.get('host');
      if (hostConn && hostConn.open) { try { hostConn.send(payload); } catch {} }
    }
  }

  function broadcastMusic(payload) {
    if (!payload) return;
    const msg = { type: 'music_sync', payload };
    if (_isHost) {
      _connections.forEach(conn => {
        if (conn.open) { try { conn.send(msg); } catch {} }
      });
    } else {
      const hostConn = _connections.get('host');
      if (hostConn && hostConn.open) { try { hostConn.send(msg); } catch {} }
    }
  }

  function broadcastTyping(isTyping) {
    const msg = { type: 'typing', memberId: _memberId, displayName: _displayName, isTyping: !!isTyping };
    if (_isHost) {
      _connections.forEach(conn => {
        if (conn.open) { try { conn.send(msg); } catch {} }
      });
    } else {
      const hostConn = _connections.get('host');
      if (hostConn && hostConn.open) { try { hostConn.send(msg); } catch {} }
    }
  }

  function _notifyMembersUpdate() {
    if (_onMembersUpdateCb) {
      // Emit shape expected by chat.js renderMembers:
      // { memberId, displayName, status, lastSeen, picture, role }
      const list = Array.from(_activeMembers.values()).map(m => ({
        memberId: m.memberId || m.id,
        displayName: m.displayName || m.name || 'Unknown',
        status: (Date.now() - (m.lastSeen || 0) < 120000) ? 'online' : 'offline',
        lastSeen: m.lastSeen ? new Date(m.lastSeen).toISOString() : new Date().toISOString(),
        picture: m.picture || '',
        role: m.role || 'member',
      }));
      _onMembersUpdateCb(list);
    }
  }

  function destroy() {
    if (_reconnectTimer) clearTimeout(_reconnectTimer);
    _reconnectTimer = null;

    _connections.forEach(c => {
      try { c.close(); } catch {}
    });
    _connections.clear();

    if (_peer && !_peer.destroyed) {
      try { _peer.destroy(); } catch {}
    }
    _peer = null;
  }

  function isConnected() {
    if (_isHost) {
      return _connections.size > 0;
    }
    const hostConn = _connections.get('host');
    return !!(hostConn && hostConn.open);
  }

  return {
    init,
    broadcastMessage,
    broadcastSeen,
    broadcastReaction,
    broadcastMusic,
    broadcastTyping,
    destroy,
    isConnected,
  };
})();

window.P2PSync = P2PSync;
