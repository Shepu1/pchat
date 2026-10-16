/**
 * SHEPU ROOMS — notify.js
 * Web Notifications for new chat messages. Requests permission lazily,
 * and only fires a notification when the tab is hidden/backgrounded so we
 * never spam the user while they're actively looking at the chat.
 *
 * A new message is surfaced to this module via Chat's append pipeline by
 * calling Notify.notifyMessage(msg) from the room entry point (app.js).
 */

const Notify = (() => {
  let _memberId = null;
  let _roomName = 'Chat';
  let _enabled = false;
  const _lastShownAt = new Map(); // dedupe by message id
  const DEDUPE_WINDOW_MS = 10000;

  // User's ON/OFF choice for the header bell (default ON).
  // OFF mutes BOTH system notifications and chat sound effects.
  const LS_KEY = 'shepu_notify_pref';

  function getUserPref() {
    try {
      const v = localStorage.getItem(LS_KEY);
      return v === 'off' ? 'off' : 'on'; // default ON
    } catch {
      return 'on';
    }
  }

  function setUserPref(v) {
    try { localStorage.setItem(LS_KEY, v === 'off' ? 'off' : 'on'); } catch {}
  }

  // Sound effects follow the same switch: OFF = fully silent.
  function isSoundOn() { return getUserPref() !== 'off'; }

  function init({ memberId, displayName, roomName }) {
    _memberId = memberId;
    _roomName = roomName || 'Chat';
    _enabled = _supported() && Notification.permission === 'granted';
  }

  function _supported() {
    return typeof window !== 'undefined' && 'Notification' in window;
  }

  // Ask the user for permission (must be called from a user gesture for best results).
  async function requestPermission() {
    if (!_supported()) return 'unsupported';
    if (Notification.permission === 'granted') { _enabled = true; return 'granted'; }
    if (Notification.permission === 'denied') return 'denied';
    try {
      const result = await Notification.requestPermission();
      _enabled = result === 'granted';
      return result;
    } catch {
      return 'error';
    }
  }

  function isEnabled() {
    // User switch OFF disables everything. Otherwise read live permission:
    // init() runs when permission is often still "default", so a cached flag
    // would stay false forever even after the user grants access.
    if (!isSoundOn()) return false;
    try {
      return _supported() && typeof Notification !== 'undefined' && Notification.permission === 'granted';
    } catch {
      return false;
    }
  }

  function isBackground() {
    // A tab can be visible yet unfocused (side-by-side windows, minimized,
    // Alt-Tab). Those should still notify — visibilityState alone misses them.
    try {
      if (typeof document !== 'undefined' && document.hidden) return true;
      if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) return true;
    } catch { /* ignore */ }
    return false;
  }

  // Called for every incoming message. Only notifies for others' messages
  // and only when the chat is not in front of the user.
  function notifyMessage(msg) {
    if (!msg) return;
    // Sender-local / unconfirmed rows must never notify (also guards against
    // stale peers that still broadcast _optimistic on the wire).
    if (msg._optimistic) return;
    if (msg.senderId && _memberId && msg.senderId === _memberId) return;      // my own message
    if (!isBackground()) return;          // user is looking at the chat
    if (!isEnabled()) return;

    const id = msg.id;
    if (id) {
      const now = Date.now();
      if (_lastShownAt.has(id) && now - _lastShownAt.get(id) < DEDUPE_WINDOW_MS) return;
      _lastShownAt.set(id, now);
    }

    const sender = msg.senderName || 'New message';
    let body = '';
    if (typeof msg.message === 'string') {
      // Strip encryption prefix / JSON attachment wrapper for a clean preview
      if (msg.message.startsWith('enc:')) body = 'Encrypted message (locked)';
      else if (msg.message.startsWith('{')) {
        try { const p = JSON.parse(msg.message); body = p.text || p.fileName || '📎 Attachment'; }
        catch { body = 'New message'; }
      } else {
        body = msg.message.length > 120 ? msg.message.slice(0, 120) + '…' : msg.message;
      }
    } else {
      body = 'New message';
    }

    try {
      const n = new Notification(`${sender} · ${_roomName}`, {
        body,
        tag: id || undefined,
        icon: 'assets/icons/icon.png',
        badge: 'assets/icons/icon.png',
      });
      n.onclick = () => {
        try { window.focus(); } catch {}
        n.close();
      };
    } catch { /* some browsers require a service worker; ignore */ }
  }

  return { init, requestPermission, notifyMessage, isEnabled, isSupported: _supported, isSoundOn, getUserPref, setUserPref };
})();

window.Notify = Notify;
