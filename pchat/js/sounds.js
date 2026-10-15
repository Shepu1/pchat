/**
 * SHEPU ROOMS — sounds.js
 * Chat sound effects (assets/sounds):
 * - emoji.mp3        → someone sends a message containing any emoji
 * - notification.mp3 → any other incoming message (foreground or background).
 *                      History older than 2 min never beeps (chat.js filters).
 * Autoplay-safe: unlocks on the first user gesture; all plays are
 * promise-guarded with per-sound cooldowns.
 */

const RoomSounds = (() => {
  const EMOJI_SRC = 'assets/sounds/emoji.mp3';
  const NOTIF_SRC = 'assets/sounds/notification.mp3';

  let _emojiAudio = null;
  let _notifAudio = null;
  let _unlocked = false;
  let _lastEmojiAt = 0;
  let _lastNotifAt = 0;

  // Emoji sound must fire EVERY time (no noticeable gating) —
  // tiny guard only against the same-frame duplicate delivery.
  const EMOJI_COOLDOWN_MS = 350;
  const NOTIF_COOLDOWN_MS = 3000;

  function _make(src) {
    try {
      const a = new Audio(src);
      a.preload = 'auto';
      try { a.load(); } catch {}
      return a;
    } catch {
      return null;
    }
  }

  // Must run after a user gesture at least once (browser autoplay policy)
  function unlock() {
    if (_unlocked) return;
    _unlocked = true;
    try {
      if (!_emojiAudio) _emojiAudio = _make(EMOJI_SRC);
      if (!_notifAudio) _notifAudio = _make(NOTIF_SRC);
      // Prime both elements so later plays are instant
      [_emojiAudio, _notifAudio].forEach(a => {
        if (!a) return;
        const p = a.play();
        if (p && p.then) {
          p.then(() => { try { a.pause(); a.currentTime = 0; } catch {} })
           .catch(() => {});
        }
      });
    } catch { /* ignore */ }
  }

  function _play(audio, lastAt, cooldown) {
    const now = Date.now();
    if (now - lastAt < cooldown) return lastAt;
    try {
      if (!audio) return lastAt;
      audio.currentTime = 0;
      const p = audio.play();
      if (p && p.catch) p.catch(() => {}); // still locked / interrupted
      return now;
    } catch {
      return lastAt;
    }
  }

  function playEmoji() {
    _lastEmojiAt = _play(_emojiAudio || (_emojiAudio = _make(EMOJI_SRC)), _lastEmojiAt, EMOJI_COOLDOWN_MS);
  }

  function playNotification() {
    _lastNotifAt = _play(_notifAudio || (_notifAudio = _make(NOTIF_SRC)), _lastNotifAt, NOTIF_COOLDOWN_MS);
  }

  // Chat is "in background" when the tab is hidden or the window lost focus
  function isBackground() {
    try {
      if (typeof document !== 'undefined' && document.hidden) return true;
      if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) return true;
    } catch { /* ignore */ }
    return false;
  }

  // Auto-unlock on first interaction anywhere in the page
  try {
    const opts = { once: true, passive: true, capture: true };
    document.addEventListener('pointerdown', unlock, opts);
    document.addEventListener('touchstart', unlock, opts);
    document.addEventListener('touchend', unlock, opts);
    document.addEventListener('keydown', unlock, opts);
    document.addEventListener('click', unlock, opts);
  } catch { /* non-DOM env */ }

  return {
    unlock,
    playEmoji,
    playNotification,
    isBackground,
  };
})();

window.RoomSounds = RoomSounds;
