/**
 * SHEPU ROOMS — ui.js
 * Toast notifications, modal helpers, DOM utilities
 */

const UI = {
  // ── Toast ─────────────────────────────────────────────────────
  toast(type = 'info', title = '', message = '', duration = 4000) {
    const container = document.getElementById('toast-container');
    if (!container) return;

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
    el.innerHTML = `
      <div class="toast-icon">${icons[type] || icons.info}</div>
      <div class="toast-content">
        ${title ? `<div class="toast-title">${escapeHtml(title)}</div>` : ''}
        ${message ? `<div class="toast-message">${escapeHtml(String(message))}</div>` : ''}
      </div>`;

    container.appendChild(el);

    // Auto-dismiss
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(100%)';
      el.style.transition = 'all 0.3s ease';
      setTimeout(() => el.remove(), 350);
    }, duration);

    return id;
  },

  // ── Toast alias (legacy showToast API) ────────────────────────
  // create-room.js historically calls UI.showToast(message, type).
  // Normalizes both (message,type) and (type,title,message) shapes.
  showToast(a, b, c) {
    if (typeof a === 'string' && typeof b === 'string' && !c) {
      // Heuristic: if first arg looks like a type, treat as toast(type, title)
      const types = ['success', 'error', 'warning', 'info'];
      if (types.includes(a)) return UI.toast(a, b, '');
      return UI.toast(b, '', a);
    }
    if (typeof a === 'string' && !b) return UI.toast('info', '', a);
    return UI.toast(a, b, c);
  },

  // Add missing helper used by chat.js
  formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = Number(bytes) || 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + ' ' + units[i];
  },

  // ── Error Field ───────────────────────────────────────────────
  showError(containerId, textId, message) {
    const container = document.getElementById(containerId);
    const text      = document.getElementById(textId);
    if (container) container.style.display = '';
    if (text)      text.textContent = message;
  },

  hideError(containerId) {
    const el = document.getElementById(containerId);
    if (el) el.style.display = 'none';
  },

  // ── Loading Button ────────────────────────────────────────────
  setLoading(btnId, loading = true, loadingText) {
    const btn = typeof btnId === 'string' ? document.getElementById(btnId) : btnId;
    if (!btn) return;
    if (loading) {
      btn.classList.add('loading');
      btn.disabled = true;
      if (loadingText) {
        const textEl = btn.querySelector('.btn-text');
        if (textEl) textEl.textContent = loadingText;
      }
    } else {
      btn.classList.remove('loading');
      btn.disabled = false;
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
      // Settle any previous pending dialog as cancelled
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
        document.removeEventListener('keydown', onKey, true);
        if (_confirmResolver === resolve) _confirmResolver = null;
        resolve(val);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(false); }
        else if (e.key === 'Enter') { e.stopPropagation(); done(true); }
      };
      okBtn.onclick = () => done(true);
      cancelBtn.onclick = () => done(false);
      overlay.onclick = (e) => { if (e.target === overlay) done(false); };
      document.addEventListener('keydown', onKey, true);
      overlay.classList.remove('hidden');
      setTimeout(() => { try { (danger ? okBtn : cancelBtn).focus({ preventScroll: true }); } catch {} }, 30);
    } catch {
      resolve(false);
    }
  });
};

// Make globally available
window.UI = UI;

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
});
