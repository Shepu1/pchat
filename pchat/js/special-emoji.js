/**
 * SHEPU ROOMS — special-emoji.js
 * Password-protected "Special" emoji set.
 *
 * - Normal mode (default): the built-in assets/emoji set, unchanged.
 * - Special mode: the search bar is replaced by a password input. The correct
 *   password decrypts assets/emoji/special/Sp.zip (AES-encrypted) in memory
 *   and its PNGs render in the same grid style as normal emojis.
 * - Wrong password → error, no images.
 * - Nothing sensitive is persisted: the password lives only in a local
 *   variable during unlock, images live as in-memory blob: URLs. Reloading
 *   the page locks the set again. The ZIP on disk stays encrypted.
 */

const SpecialEmoji = (() => {
  const ZIP_URL = 'assets/emoji/special/Sp.zip';

  let _mode = 'normal';       // 'normal' | 'special' (page session only)
  let _items = [];            // [{ name, url }] — blob URLs, memory only
  let _unlocked = false;
  let _unlocking = false;

  function getMode() { return _mode; }
  function setMode(m) {
    _mode = (m === 'special') ? 'special' : 'normal';
  }
  function isUnlocked() { return _unlocked && _items.length > 0; }
  function isBusy() { return _unlocking; }
  function getItems() { return _items.slice(); }

  // ── Inline shortcodes (send/render like a normal emoji) ───────
  // Clicking a special emoji inserts a short 5-gibberish-char code like
  // `:a7k2p:` as plain text (exactly like a unicode emoji char). The
  // renderer below swaps it for an inline <img> at emoji size.
  // Codes are hash-derived from the filename, so every device resolves the
  // same code for the same image. The older `:sp_<base>:` form (sent before
  // the short-code switch) still renders too.
  // When the pack is locked (or on a device that never unlocked it) the
  // code renders as a lock-shield placeholder instead of leaking the image.
  //
  // IMPORTANT: emojifyShortcodes must run AFTER linkify. It emits absolute
  // blob: URLs, and linkify would mistake the http:// inside them for a
  // link and shred the tag. (CustomEmoji is safe pre-linkify only because
  // its srcs are relative.)
  const SHORTCODE_NEW = ':[a-z][a-z0-9]{4}:';
  const SHORTCODE_LEGACY = ':sp_[A-Za-z0-9_-]{1,48}:';
  const SHORTCODE_RE = new RegExp('(?:' + SHORTCODE_LEGACY + '|' + SHORTCODE_NEW + ')', 'g');

  function _codeBase(filename) {
    const base = String(filename || '').split('/').pop().replace(/\.[^.]+$/, '');
    const clean = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    return clean || 'img';
  }

  // Deterministic 5-char gibberish from a seed (FNV-1a → a-z + base36).
  // Same filename → same code on every device, forever.
  function _gibberish(seed, attempt) {
    let h = 2166136261 >>> 0;
    const s = 'pchat-sp:' + String(seed) + '#' + (attempt || 0);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h >>>= 0;
    const A = 'abcdefghijklmnopqrstuvwxyz';
    const B = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let code = A[h % 26];
    h = Math.floor(h / 26);
    for (let i = 0; i < 4; i++) { code += B[h % 36]; h = Math.floor(h / 36); }
    return code;
  }

  function shortcodeFor(item) {
    if (!item) return '';
    const code = item.code || _codeBase(item.name);
    return code.includes('_') || code.length !== 5 ? `:sp_${code}:` : `:${code}:`;
  }

  function _findByCode(code) {
    const key = String(code || '').toLowerCase();
    // New form :xxxxx: — compare inner part against assigned codes.
    const inner = key.replace(/^:/, '').replace(/:$/, '');
    for (const it of _items) {
      if (it.code && it.code === inner) return it;
      if (`:sp_${_codeBase(it.name)}:` === key) return it; // legacy form
    }
    return null;
  }

  function urlForShortcode(code) {
    if (!isUnlocked()) return null;
    const it = _findByCode(code);
    return (it && it.url) || null;
  }

  function containsShortcode(text) {
    if (!text || typeof text !== 'string') return false;
    SHORTCODE_RE.lastIndex = 0;
    return SHORTCODE_RE.test(text);
  }

  // Strip every shortcode (both forms) — for emoji-only detection.
  function stripShortcodes(text) {
    if (!text || typeof text !== 'string') return text;
    SHORTCODE_RE.lastIndex = 0;
    return text.replace(SHORTCODE_RE, '');
  }

  // Count shortcodes (both forms) — for big-bubble sizing.
  function countShortcodes(text) {
    if (!text || typeof text !== 'string') return 0;
    const m = text.match(new RegExp(SHORTCODE_RE.source, 'g'));
    return m ? m.length : 0;
  }

  // Input must already be HTML-escaped (shortcode chars are escape-safe).
  // Runs AFTER linkify (see note above): blob: URLs would otherwise be
  // shredded by the link matcher. Shortcodes contain no URL prefix, so
  // linkify can never match them first.
  function emojifyShortcodes(escaped) {
    if (!escaped || typeof escaped !== 'string') return escaped || '';
    SHORTCODE_RE.lastIndex = 0;
    if (!SHORTCODE_RE.test(escaped)) return escaped;
    SHORTCODE_RE.lastIndex = 0;
    return escaped.replace(SHORTCODE_RE, (match) => {
      const url = urlForShortcode(match);
      if (url) {
        const label = match.replace(/"/g, '&quot;');
        return `<img src="${url}" alt="${label}" title="${label}" data-code="${match}" class="custom-emoji" loading="lazy" draggable="false" onerror="this.replaceWith(document.createTextNode(this.dataset.code))" />`;
      }
      const label = match.replace(/"/g, '&quot;');
      return `<span class="special-emoji-locked" title="Locked special emoji ${label}" role="img" aria-label="Locked special emoji"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><polyline points="9 11.5 11 13.5 15 9.5"></polyline></svg></span>`;
    });
  }

  // Natural sort so sp_2 comes before sp_10 (plain lexical would not).
  function _naturalName(a, b) {
    const ax = [], bx = [];
    String(a).replace(/(\d+)|(\D+)/g, (_, $1, $2) => { ax.push([$1 || 0, $2 || '']); });
    String(b).replace(/(\d+)|(\D+)/g, (_, $1, $2) => { bx.push([$1 || 0, $2 || '']); });
    while (ax.length && bx.length) {
      const [an, as] = ax.shift();
      const [bn, bs] = bx.shift();
      const nn = (+an) - (+bn);
      if (nn) return nn;
      if (as !== bs) return as < bs ? -1 : 1;
    }
    return ax.length - bx.length;
  }

  function _isImageEntry(filename) {
    if (!filename || filename.endsWith('/')) return false;
    if (filename.startsWith('__MACOSX/')) return false;
    return /\.(png|jpe?g|gif|webp)$/i.test(filename);
  }

  // Unlock with the user's password. Resolves { ok:true, count } or
  // { ok:false, error } — never throws. onProgress(frac, label) is optional.
  async function unlock(password, onProgress) {
    if (_unlocking) return { ok: false, error: 'Already unlocking — please wait.' };
    if (!password) return { ok: false, error: 'Please enter the password.' };
    if (typeof zip === 'undefined' || !zip.ZipReader) {
      return { ok: false, error: 'ZIP engine not loaded. Reload the page.' };
    }
    _unlocking = true;
    try { if (typeof zip.configure === 'function') zip.configure({ useWebWorkers: false }); } catch {}
    let reader = null;
    try {
      const prog = (f, label) => { try { onProgress && onProgress(f, label); } catch {} };
      prog(0.05, 'Loading pack…');
      const res = await fetch(ZIP_URL, { cache: 'force-cache' });
      if (!res.ok) throw new Error('Pack file not found on this server.');
      const blob = await res.blob();
      prog(0.2, 'Opening pack…');
      reader = new zip.ZipReader(new zip.BlobReader(blob));
      const entries = await reader.getEntries();
      const images = entries.filter(e => _isImageEntry(e.filename || ''));
      if (!images.length) throw new Error('No images found inside the pack.');
      const items = [];
      let done = 0;
      for (const entry of images) {
        let data;
        try {
          // NOTE: password is used here and dropped right after — never stored.
          data = await entry.getData(new zip.BlobWriter('image/png'), { password });
        } catch (err) {
          const msg = String((err && err.message) || err || '');
          if (/password/i.test(msg)) throw new Error('Wrong password. Try again.');
          throw new Error('Could not read images. Try again.');
        }
        const base = (entry.filename || 'image.png').split('/').pop();
        items.push({ name: base, blob: data });
        done++;
        prog(0.2 + (0.75 * done) / images.length, `Unlocking ${done}/${images.length}…`);
      }
      // Sort naturally, assign stable gibberish codes, mint blob URLs.
      // All in-memory only — nothing decrypted ever touches storage.
      items.sort((a, b) => _naturalName(a.name, b.name));
      _clearItems();
      const used = new Set();
      _items = items.map(it => {
        let url = '';
        try { url = URL.createObjectURL(it.blob); } catch {}
        const base = _codeBase(it.name);
        let attempt = 0, code = '';
        do { code = _gibberish(base, attempt++); } while (used.has(code) && attempt < 50);
        used.add(code);
        return { name: it.name, code, base, url, blob: it.blob, size: it.blob ? it.blob.size : 0 };
      }).filter(it => it.url);
      if (!_items.length) throw new Error('Could not read images. Try again.');
      _unlocked = true;
      prog(1, 'Unlocked');
      return { ok: true, count: _items.length };
    } catch (err) {
      return { ok: false, error: (err && err.message) || 'Unlock failed. Try again.' };
    } finally {
      password = null; // never retain the password
      try { if (reader) await reader.close(); } catch {}
      _unlocking = false;
    }
  }

  function _clearItems() {
    try { _items.forEach(it => { if (it.url) URL.revokeObjectURL(it.url); }); } catch {}
    _items = [];
    _unlocked = false;
  }

  // Lock again (e.g. never auto-called — kept for completeness).
  function lock() { _clearItems(); }

  return { getMode, setMode, isUnlocked, isBusy, getItems, unlock, lock,
    shortcodeFor, urlForShortcode, containsShortcode, emojifyShortcodes,
    stripShortcodes, countShortcodes };
})();

window.SpecialEmoji = SpecialEmoji;
