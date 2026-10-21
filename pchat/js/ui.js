/**
 * SHEPU ROOMS — ui.js
 * Toast notifications, modal helpers, DOM utilities
 */

const UI = {
  // ── Toast ─────────────────────────────────────────────────────
  toast(type = 'info', title = '', message = '', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // Flood guard: identical toasts refresh instead of stacking, and at most
    // 3 are ever visible — busy rooms used to bury the chat under a wall.
    try {
      const key = `${type}|${title}|${message}`.slice(0, 160);
      const dup = [...container.querySelectorAll('.toast')].find(
        (n) => n.getAttribute('data-toast-key') === key
      );
      if (dup) {
        clearTimeout(dup._toastTimer);
        dup._toastTimer = setTimeout(() => UI._dismissToast(dup), duration);
        return dup.id;
      }
      while (container.querySelectorAll('.toast').length >= 3) {
        container.querySelector('.toast')?.remove();
      }
    } catch {}
    const icons = {
      success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>',
      error: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>',
      warning: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>',
      info: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>',
    };
    const id = 'toast_' + Date.now();

    const el = document.createElement('div');
    el.id = id;
    el.className = `toast ${type}`;
    el.setAttribute('role', 'status');
    try {
      const key = `${type}|${title}|${message}`;
      el.setAttribute('data-toast-key', key.slice(0, 160));
    } catch {}
    el.innerHTML = `
      <div class="toast-icon">${icons[type] || icons.info}</div>
      <div class="toast-content">
        ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
        ${message ? `<div class="toast-message">${escapeHtml(String(message))}</div>` : ''}
      </div>`;

    container.appendChild(el);

    // Auto-dismiss
    el._toastTimer = setTimeout(() => UI._dismissToast(el), duration);

    return id;
  },

  // Shared dismiss (also used to refresh duplicate toasts)
  _dismissToast(el) {
    try {
      el.style.opacity = '0';
      el.style.transform = 'translateX(100%)';
      el.style.transition = 'all 0.3s ease';
      setTimeout(() => el.remove(), 350);
    } catch { try { el.remove(); } catch {} }
  },

  // ── Loading Button ────────────────────────────────────────────
  setLoading(btnId, loading = true, loadingText) {
    const btn = typeof btnId === 'string' ? document.getElementById(btnId) : btnId;
    if (!btn) return;
    if (loading) {
      btn.classList.add('loading');
      btn.disabled = true;
      // Remember the original label so it can be restored — the button used
      // to stay on "Joining…" forever after a failed attempt.
      if (loadingText) {
        const textEl = btn.querySelector('.btn-text');
        if (textEl) {
          if (textEl.dataset.origText == null) textEl.dataset.origText = textEl.textContent || '';
          textEl.textContent = loadingText;
        }
      }
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
      const textEl = btn.querySelector('.btn-text');
      if (textEl && textEl.dataset.origText != null) {
        textEl.textContent = textEl.dataset.origText;
        delete textEl.dataset.origText;
      }
    }
  },

  // ── Modal ─────────────────────────────────────────────────────
  openModal(id) {
    const el = document.getElementById(id);
    if (el) { el.classList.remove('hidden'); el.focus?.(); }
  },

  closeModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  },

  // ── Progress Step ─────────────────────────────────────────────
  setStep(stepId, state) {
    const el = document.getElementById(stepId);
    if (!el) return;
    el.className = 'progress-step ' + state;
    const icon = el.querySelector('.step-icon');
    if (!icon) return;

    if (state === 'active') {
      icon.innerHTML = '<div class="spinner-sm animate-spin" aria-hidden="true"></div>';
    } else if (state === 'done') {
      icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
    } else if (state === 'error') {
      icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    } else {
      // restore original icon — store original as data attribute
      icon.textContent = icon.dataset.icon || '•';
    }
  },

  initStepIcons() {
    document.querySelectorAll('.progress-step .step-icon').forEach(icon => {
      icon.dataset.icon = icon.textContent;
    });
  },

  // ── Password fields: keep the browser's password manager away ──
  // On Android Chrome the saved-password sheet pops over the field and
  // the soft keyboard jumps away the moment the first character is typed.
  // Chrome ignores autocomplete="off" on password fields, so the field is
  // marked as a brand-new password, given a throw-away name, the usual
  // password managers are told to ignore it, and it stays readonly until
  // the user actually touches it. A focus watchdog grabs the focus back
  // if Chrome's autofill preview steals it.
  hardenPassword(input) {
    if (!input || input.dataset.pwHardened === '1') return input;
    input.dataset.pwHardened = '1';
    try {
      // "new-password" would ASK Chrome for its password generator
      // ("Suggest strong password" pops up over the box). "off" is
      // ignored by Chrome on password fields, so the only hint Chrome
      // actually respects is "one-time-code" — it then treats the field
      // as a plain code field and leaves it alone.
      input.setAttribute('autocomplete', 'one-time-code');
      input.setAttribute('autocapitalize', 'none');
      input.setAttribute('autocorrect', 'off');
      input.setAttribute('spellcheck', 'false');
      input.setAttribute('data-1p-ignore', 'true');
      input.setAttribute('data-lpignore', 'true');
      input.setAttribute('data-form-type', 'other');
      input.setAttribute('data-bwignore', 'true');
      // Chrome matches saved logins by name/id — a random name keeps it away.
      input.setAttribute('name', 'pw_' + Math.random().toString(36).slice(2, 10));
      // A "form" attribute pointing at a form that does not exist leaves the
      // field without a form owner. Chrome then cannot see a sign-up form
      // (room name + password) and never offers its password generator.
      // Every value is read from the element itself, so nothing breaks.
      input.setAttribute('form', 'pchat-no-form');
      // readonly until the first real touch: Chrome never offers a saved
      // password for a readonly field, and dropping the attribute on
      // touch keeps the soft keyboard open.
      input.setAttribute('readonly', '');
      const wake = () => {
        try { input.removeAttribute('readonly'); } catch {}
        input.removeEventListener('touchstart', wake);
        input.removeEventListener('pointerdown', wake);
        input.removeEventListener('keydown', wake);
      };
      input.addEventListener('touchstart', wake, { passive: true });
      input.addEventListener('pointerdown', wake);
      input.addEventListener('keydown', wake);
      input.addEventListener('focus', () => {
        // Once the user has touched the page the field may be filled in
        // by code (auto-focus) — then it must behave like a normal input.
        if (UI._userTouched) wake();
        // Chrome's autofill preview sometimes blurs the field (the
        // keyboard dies). Take the focus back — but never steal it from
        // another field the user tapped.
        setTimeout(() => {
          try {
            const ae = document.activeElement;
            if (ae === input) return;
            if (ae && ae !== document.body) return;
            input.focus({ preventScroll: true });
          } catch {}
        }, 350);
      });
    } catch {}
    return input;
  },

  // Apply the hardening to every password field of the page.
  hardenPasswords(root) {
    const scope = root || document;
    let list = [];
    try { list = Array.from(scope.querySelectorAll('input[type="password"]')); } catch {}
    list.forEach(el => UI.hardenPassword(el));
    return list.length;
  },

  // ── Show/Hide ─────────────────────────────────────────────────
  show(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = '';
  },

  hide(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  },

  // ── Scroll to bottom ──────────────────────────────────────────
  scrollToBottom(el, smooth = true) {
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  },

  // ── Relative time ─────────────────────────────────────────────
  relativeTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    if (diff < 60000)     return 'just now';
    if (diff < 3600000)   return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000)  return Math.floor(diff / 3600000) + 'h ago';
    return Math.floor(diff / 86400000) + 'd ago';
  },

  // ── Format time ───────────────────────────────────────────────
  formatTime(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  },

  formatDate(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
  },

  // ── Copy to clipboard ─────────────────────────────────────────
  async copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  },

  // ── Avatar initials ───────────────────────────────────────────
  getInitial(name) {
    return (name || '?').trim()[0].toUpperCase();
  },

  // ── Auto-resize textarea ──────────────────────────────────────
  autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 140) + 'px';
  },

  // ── Room Created Animation (APNG, centered, small) ────────────
  // Shows assets/icons/animation.apng centered for ~2.5s after a room
  // is created. Resolves once dismissed so callers can await it before
  // continuing (e.g. opening a share modal).
  playRoomCreatedAnimation(duration = 2500) {
    return new Promise((resolve) => {
      // Avoid stacking multiple overlays if triggered twice
      const prev = document.getElementById('room-created-anim');
      if (prev) prev.remove();

      const overlay = document.createElement('div');
      overlay.id = 'room-created-anim';
      overlay.setAttribute('role', 'status');
      overlay.style.cssText = [
        'position:fixed', 'inset:0', 'z-index:100000',
        'display:flex', 'align-items:center', 'justify-content:center',
        'background:rgba(9,13,22,0.82)',
        'backdrop-filter:blur(6px)',
        'opacity:0', 'transition:opacity .25s ease',
      ].join(';');

      const img = document.createElement('img');
      img.src = 'assets/icons/animation.apng';
      img.alt = 'Room created';
      img.style.cssText = [
        'width:120px', 'height:120px', 'object-fit:contain',
        'border-radius:20px',
      ].join(';');

      overlay.appendChild(img);
      document.body.appendChild(overlay);

      // Fade in on the next frame
      requestAnimationFrame(() => { overlay.style.opacity = '1'; });

      // Fade out & remove after the requested duration
      setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => { overlay.remove(); resolve(); }, 260);
      }, duration);
    });
  },
};

// ── Professional confirm dialog (replaces browser confirm()/alert()) ─
// Builds its own overlay on demand, so it works on every page with zero markup.
let _confirmResolver = null;
let _confirmCleanup = null;   // tears the PREVIOUS dialog down completely

function ensureConfirmModal() {
  let overlay = document.getElementById('ui-confirm-overlay');
  if (overlay) return overlay;
  overlay = document.createElement('div');
  overlay.id = 'ui-confirm-overlay';
  overlay.className = 'ui-confirm-overlay hidden';
  overlay.innerHTML = `
    <div class="ui-confirm-modal" role="alertdialog" aria-modal="true" aria-labelledby="ui-confirm-title" aria-describedby="ui-confirm-message">
      <div class="ui-confirm-icon" id="ui-confirm-icon"></div>
      <div class="ui-confirm-title" id="ui-confirm-title"></div>
      <div class="ui-confirm-message" id="ui-confirm-message"></div>
      <div class="ui-confirm-actions">
        <button type="button" class="btn btn-ghost" id="ui-confirm-cancel"></button>
        <button type="button" class="btn btn-primary" id="ui-confirm-ok"></button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  return overlay;
}

const ICON_WARN = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
const ICON_OUT = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>';

UI.confirmDialog = function ({ title = 'Are you sure?', message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false, icon = null } = {}) {
  return new Promise((resolve) => {
    try {
      // Settle any previous pending dialog as cancelled — and FULLY tear it
      // down. Resolving the promise alone left its keydown listener
      // registered forever, and because every dialog shares this one
      // overlay, the stale handler would hide the dialog that is open now.
      if (_confirmCleanup) { try { _confirmCleanup(); } catch {} _confirmCleanup = null; }
      if (_confirmResolver) { try { _confirmResolver(false); } catch {} _confirmResolver = null; }
      const overlay = ensureConfirmModal();
      const modal = overlay.querySelector('.ui-confirm-modal');
      modal.classList.toggle('danger', !!danger);
      overlay.querySelector('#ui-confirm-icon').innerHTML = icon || (danger ? ICON_WARN : ICON_OUT);
      overlay.querySelector('#ui-confirm-title').textContent = title;
      overlay.querySelector('#ui-confirm-message').textContent = message;
      const okBtn = overlay.querySelector('#ui-confirm-ok');
      const cancelBtn = overlay.querySelector('#ui-confirm-cancel');
      okBtn.textContent = confirmText;
      okBtn.className = danger ? 'btn btn-danger' : 'btn btn-primary';
      cancelBtn.textContent = cancelText;
      _confirmResolver = resolve;
      const done = (val) => {
        overlay.classList.add('hidden');
        overlay.removeEventListener('keydown', onKey);
        if (_confirmCleanup === cleanup) _confirmCleanup = null;
        if (_confirmResolver === resolve) _confirmResolver = null;
        resolve(val);
      };
      // The listener lives on the OVERLAY, not on document. A document-level
      // capture listener resolved the dialog for ANY Enter keypress — the
      // chat composer kept the focus, so pressing Enter to send a message
      // confirmed the dialog instead (and the message was swallowed).
      // Destructive dialogs (delete room, ban member) were confirmed by
      // accident that way.
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(false); }
        else if (e.key === 'Enter') { e.stopPropagation(); done(true); }
      };
      const cleanup = () => {
        overlay.removeEventListener('keydown', onKey);
        overlay.classList.add('hidden');
      };
      _confirmCleanup = cleanup;
      okBtn.onclick = () => done(true);
      cancelBtn.onclick = () => done(false);
      overlay.onclick = (e) => { if (e.target === overlay) done(false); };
      overlay.addEventListener('keydown', onKey);
      overlay.classList.remove('hidden');
      setTimeout(() => { try { (danger ? okBtn : cancelBtn).focus({ preventScroll: true }); } catch {} }, 30);
    } catch {
      resolve(false);
    }
  });
};

// ── One-time display-name prompt (logged-out users) ────────────
// Styled modal with a text input. Resolves the typed name or null on cancel.
UI.promptName = function ({ title = 'Your name?', message = 'Pick a display name for chat. Asked only once — saved on this device until you log in.', placeholder = 'e.g. Shepu', defaultValue = '' } = {}) {
  return new Promise((resolve) => {
    try {
      let overlay = document.getElementById('ui-name-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'ui-name-overlay';
        overlay.className = 'ui-confirm-overlay hidden';
        overlay.innerHTML = `
          <div class="ui-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="ui-name-title">
            <div class="ui-confirm-title" id="ui-name-title"></div>
            <div class="ui-confirm-message" id="ui-name-message" style="margin-bottom:0.9rem;"></div>
            <input type="text" id="ui-name-input" class="form-input" maxlength="30" autocomplete="off" style="width:100%;box-sizing:border-box;margin-bottom:1rem;" />
            <div class="ui-confirm-actions">
              <button type="button" class="btn btn-ghost" id="ui-name-cancel">Cancel</button>
              <button type="button" class="btn btn-primary" id="ui-name-ok">Continue</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
      }
      overlay.querySelector('#ui-name-title').textContent = title;
      overlay.querySelector('#ui-name-message').textContent = message;
      const input = overlay.querySelector('#ui-name-input');
      input.placeholder = placeholder;
      input.value = defaultValue || '';
      const okBtn = overlay.querySelector('#ui-name-ok');
      const cancelBtn = overlay.querySelector('#ui-name-cancel');
      const done = (val) => {
        overlay.classList.add('hidden');
        overlay.removeEventListener('keydown', onKey);
        resolve(val);
      };
      // Same rule as confirmDialog: the listener belongs to the overlay, so
      // an Enter typed in the chat composer can never submit this prompt.
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(null); }
        else if (e.key === 'Enter') { e.stopPropagation(); okBtn.click(); }
      };
      okBtn.onclick = () => {
        const v = (input.value || '').trim();
        done(v || null);
      };
      cancelBtn.onclick = () => done(null);
      overlay.onclick = (e) => { if (e.target === overlay) done(null); };
      overlay.addEventListener('keydown', onKey);
      overlay.classList.remove('hidden');
      setTimeout(() => { try { input.focus({ preventScroll: true }); } catch {} }, 30);
    } catch {
      resolve(null);
    }
  });
};

// ── Effective display name (one rule everywhere) ────────────────
// Logged-in      → Gmail/profile name (also refreshes the saved name).
// Logged-out     → saved name from the one-time prompt.
// First-time out → one-time prompt; persists until login.
// Resolves null when the user cancels the prompt.
UI.resolveDisplayName = async function (opts = {}) {
  try {
    const authed = (typeof Auth !== 'undefined' && Auth.isAuthenticated) ? Auth.isAuthenticated() : false;
    const profile = (typeof Auth !== 'undefined' && Auth.getUser) ? Auth.getUser() : null;
    if (authed) {
      const n = (profile?.name || '').trim() || (profile?.email?.split('@')[0] || '').trim();
      if (n) {
        try { localStorage.setItem('shepu_display_name', n); } catch {}
        return n;
      }
    }
    let saved = null;
    try { saved = localStorage.getItem('shepu_display_name'); } catch {}
    if (saved && saved.trim()) return saved.trim();
    if (authed) return 'Owner';
    const picked = await UI.promptName(opts);
    if (!picked) return null;
    try { localStorage.setItem('shepu_display_name', picked); } catch {}
    return picked;
  } catch { return null; }
};

// ── Effective profile picture (one rule everywhere) ───────────
// Priority: manually-set Settings photo → Google account photo → ''.
// Login NEVER overwrites a manually-set photo (see shepu_pic_custom).
UI.effectivePicture = function () {
  try {
    const custom = localStorage.getItem('shepu_profile_pic');
    if (custom && custom.trim()) return custom.trim();
    const u = (typeof Auth !== 'undefined' && Auth.getUser) ? Auth.getUser() : null;
    return (u && u.picture) || '';
  } catch { return ''; }
};

// Shrink an uploaded image to a tiny square avatar (96px JPEG) so it stays
// cheap in localStorage, relay payloads and sheets. Resolves dataURL.
UI.processAvatarFile = function (file) {
  return new Promise((resolve, reject) => {
    try {
      if (!file || !file.type.startsWith('image/')) {
        reject(new Error('Please choose an image file.'));
        return;
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const S = 96;
          const side = Math.min(img.width, img.height) || 1;
          const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
          const cv = document.createElement('canvas');
          cv.width = S; cv.height = S;
          cv.getContext('2d').drawImage(img, sx, sy, side, side, 0, 0, S, S);
          URL.revokeObjectURL(url);
          resolve(cv.toDataURL('image/jpeg', 0.72));
        } catch (e) { URL.revokeObjectURL(url); reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
      img.src = url;
    } catch (e) { reject(e); }
  });
};

// Make globally available
window.UI = UI;

// Has the user touched the page yet? Password fields stay readonly until
// they do — that is what keeps Chrome's password sheet from stealing the
// keyboard on a phone.
UI._userTouched = false;
try {
  const markTouched = () => { UI._userTouched = true; };
  document.addEventListener('pointerdown', markTouched, { capture: true, passive: true });
  document.addEventListener('touchstart', markTouched, { capture: true, passive: true });
  document.addEventListener('keydown', markTouched, { capture: true });
} catch { /* ignore */ }

// ── Utility ───────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

window.escapeHtml = escapeHtml;

// ── Auto-init progress step icons ────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  UI.initStepIcons();
  // Keep Chrome's / Google's password suggestions away from every
  // password field on the page (phone keyboards hate that sheet).
  try { UI.hardenPasswords(); } catch {}
});
