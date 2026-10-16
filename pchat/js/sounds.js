/**
 * SHEPU ROOMS — sounds.js
 * Chat sound effects (assets/sounds):
 * - emoji.mp3        → someone sends a message containing any emoji
 * - notification.mp3 → any other incoming message (foreground or background).
 *                      History older than 2 min never beeps (chat.js filters).
 *
 * Robustness notes (Chrome / Firefox / Brave fix):
 * - Every play uses a FRESH Audio element. Reusing one shared element and
 *   resetting currentTime=0 fails on strict browsers when the previous play
 *   is still pending ("play() interrupted") — async human messages arriving
 *   via poll/P2P were dropped while locally-triggered bot replies (inside the
 *   user's click-activation window) still played.
 * - unlock() retries on EVERY gesture until a real play succeeds (no once:true
 *   one-shot that can stay "unlocked" while actually blocked).
 * - A play blocked by autoplay does NOT consume the cooldown: the gate is
 *   reset so the next message retries immediately instead of staying silent
 *   for 3 more seconds.
 */

const RoomSounds = (() => {
  const EMOJI_SRC = 'assets/sounds/emoji.mp3';
  const NOTIF_SRC = 'assets/sounds/notification.mp3';

  let _unlocked = false;
  let _lastEmojiAt = 0;
  let _lastNotifAt = 0;

  // Emoji sound must fire EVERY time (no noticeable gating) —
  // tiny guard only against the same-frame duplicate delivery.
  const EMOJI_COOLDOWN_MS = 350;
  const NOTIF_COOLDOWN_MS = 3000;

  // Both chat effects play at 60% (40% lower than full volume).
  const SOUND_VOLUME = 0.6;

  function _make(src) {
    try {
      const a = new Audio(src);
      a.preload = 'auto';
      try { a.volume = SOUND_VOLUME; } catch {}
      try { a.load(); } catch {}
      return a;
    } catch {
      return null;
    }
  }

  // Must run after a user gesture at least once (browser autoplay policy).
  // Retries on every gesture until one priming play actually succeeds.
  function unlock() {
    if (_unlocked) return;
    try {
      const probe = _make(NOTIF_SRC);
      if (!probe) return;
      const p = probe.play();
      if (p && p.then) {
        p.then(() => {
          try { probe.pause(); } catch {}
          _unlocked = true;
        }).catch(() => {
          // Still blocked (Firefox/Brave strict autoplay) — keep listeners
          // armed so the next click/keypress retries.
        });
      } else {
        _unlocked = true;
      }
    } catch { /* ignore — will retry on next gesture */ }
  }

  // Fresh-element play. Spam-gates on attempt, but a blocked play resets
  // the gate so the NEXT message retries immediately.
  function _playFresh(src, getLast, setLast, resetLast, cooldown) {
    // Header bell OFF = fully silent (user's choice, default ON).
    try {
      if (typeof Notify !== 'undefined' && Notify.isSoundOn && !Notify.isSoundOn()) return;
      else if (typeof Notify === 'undefined' && typeof localStorage !== 'undefined'
        && localStorage.getItem('shepu_notify_pref') === 'off') return;
    } catch {}
    const now = Date.now();
    if (now - getLast() < cooldown) return;
    setLast(now);
    let audio = null;
    try {
      audio = _make(src);
      if (!audio) { resetLast(); return; }
      const p = audio.play();
      if (p && p.then) {
        p.then(() => {
          _unlocked = true;
          try {
            audio.addEventListener('ended', () => {
              try { audio.pause(); } catch {}
            }, { once: true });
          } catch {}
        }).catch(() => {
          // Blocked by autoplay policy — don't swallow the next beep.
          resetLast();
          try { unlock(); } catch {}
        });
      }
    } catch {
      resetLast();
    }
  }

  function playEmoji() {
    _playFresh(
      EMOJI_SRC,
      () => _lastEmojiAt,
      (t) => { _lastEmojiAt = t; },
      () => { _lastEmojiAt = 0; },
      EMOJI_COOLDOWN_MS
    );
  }

  function playNotification() {
    _playFresh(
      NOTIF_SRC,
      () => _lastNotifAt,
      (t) => { _lastNotifAt = t; },
      () => { _lastNotifAt = 0; },
      NOTIF_COOLDOWN_MS
    );
  }

  // Chat is "in background" when the tab is hidden or the window lost focus
  function isBackground() {
    try {
      if (typeof document !== 'undefined' && document.hidden) return true;
      if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) return true;
    } catch { /* ignore */ }
    return false;
  }

  // Auto-unlock on interaction anywhere in the page (persistent, not once —
  // Firefox/Brave may reject the first priming attempt).
  try {
    const opts = { passive: true, capture: true };
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
