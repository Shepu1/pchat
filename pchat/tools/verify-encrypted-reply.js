#!/usr/bin/env node
/**
 * Verifies that an encrypted message shows its real text in a reply quote
 * instead of the "Encrypted message (locked)" placeholder.
 */
const fs = require('fs');
const vm = require('vm');

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n + (x ? '  → ' + x : ''))); };

const chatSrc = fs.readFileSync('js/chat.js', 'utf8');

// Pull a function out of chat.js, counting braces while skipping strings,
// template literals, regex literals and comments.
function extract(name) {
  const i = chatSrc.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let depth = 0, k = chatSrc.indexOf('{', i);
  const start = i;
  let inStr = null, inTpl = false, inCmt = null, prev = '';
  for (; k < chatSrc.length; k++) {
    const c = chatSrc[k], nx = chatSrc[k + 1];
    if (inCmt === '//') { if (c === '\n') inCmt = null; continue; }
    if (inCmt === '/*') { if (c === '*' && nx === '/') { inCmt = null; k++; } continue; }
    if (inStr) { if (c === '\\') { k++; continue; } if (c === inStr) inStr = null; continue; }
    if (inTpl) { if (c === '\\') { k++; continue; } if (c === '`') inTpl = false; continue; }
    if (c === '/' && nx === '/') { inCmt = '//'; k++; continue; }
    if (c === '/' && nx === '*') { inCmt = '/*'; k++; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inTpl = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return chatSrc.slice(start, k + 1); }
    prev = c;
  }
  throw new Error('unbalanced: ' + name);
}

const snippet = extract('_fillSnippet');
const display = extract('_displayText');

function makeEl() {
  return {
    _html: '', _text: '',
    set innerHTML(v) { this._html = String(v); this._text = ''; },
    get innerHTML() { return this._html; },
    set textContent(v) { this._text = String(v); this._html = ''; },
    get textContent() { return this._text; },
  };
}

async function run({ hasKey, ciphertext, plaintext, keyError }) {
  const el = makeEl();
  const sandbox = {
    console,
    Encryption: {
      isActive: () => hasKey,
      decrypt: (c) => {
        if (keyError) return Promise.reject(new Error('no key'));
        return Promise.resolve(plaintext);
      },
    },
    _escEmo: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[m])),
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(display + '\n' + snippet + '\n;globalThis.__f=_fillSnippet;', ctx);
  ctx.__f(el, { message: ciphertext, messageType: 'text' });
  // let the promise settle
  await new Promise(r => setTimeout(r, 20));
  return el;
}

(async () => {
  console.log('\n[1] encrypted reply quote shows the real text');
  let el = await run({ hasKey: true, ciphertext: 'enc:AAAA', plaintext: 'Hello, how are you?' });
  ck('decrypted text is rendered', el.innerHTML.includes('Hello, how are you?'), JSON.stringify(el.innerHTML));

  console.log('\n[2] plaintext messages are unchanged');
  el = await run({ hasKey: true, ciphertext: 'plain text here', plaintext: 'x' });
  ck('plain text rendered as-is', el.innerHTML.includes('plain text here'), JSON.stringify(el.innerHTML));

  console.log('\n[3] no key on this device');
  el = await run({ hasKey: false, ciphertext: 'enc:AAAA', plaintext: 'secret' });
  ck('shows the locked placeholder', el.textContent === 'Encrypted message (locked)', JSON.stringify(el.textContent));

  console.log('\n[4] decryption fails (wrong key)');
  el = await run({ hasKey: true, ciphertext: 'enc:AAAA', plaintext: "[Couldn't decrypt — ask the owner for the latest invite link or passphrase]", keyError: false });
  ck('shows the locked placeholder', el.textContent === 'Encrypted message (locked)', JSON.stringify(el.textContent));

  console.log('\n[5] decrypt throws');
  el = await run({ hasKey: true, ciphertext: 'enc:AAAA', plaintext: '', keyError: true });
  ck('shows the locked placeholder', el.textContent === 'Encrypted message (locked)', JSON.stringify(el.textContent));

  console.log('\n[6] an encrypted ATTACHMENT keeps its label after decrypting');
  el = await run({
    hasKey: true, ciphertext: 'enc:AAAA',
    plaintext: JSON.stringify({ dataUrl: 'data:audio/webm;base64,AA', fileName: 'note.webm', fileType: 'audio/webm' }),
  });
  ck('shows "Voice · note.webm"', /Voice.*note\.webm/.test(el.innerHTML), JSON.stringify(el.innerHTML));

  console.log('\n[7] the decrypted text is HTML-escaped');
  el = await run({ hasKey: true, ciphertext: 'enc:AAAA', plaintext: '<img src=x onerror=alert(1)>' });
  ck('no raw <img> in the output', !/<img/.test(el.innerHTML), JSON.stringify(el.innerHTML));
  ck('escaped &lt;img present', el.innerHTML.includes('&lt;img'), JSON.stringify(el.innerHTML));

  console.log('\n[8] the reply quote and the reply bar both use the helper');
  ck('reply quote uses _fillSnippet', /textEl\.className = 'reply-quote-text';[\s\S]{0,250}_fillSnippet\(textEl, replyRef\)/.test(chatSrc));
  ck('reply bar uses _fillSnippet', /_fillSnippet\(document\.getElementById\('reply-to-preview'\), msg\)/.test(chatSrc));
  ck('no sync _displayText left in the reply quote', !/_escEmo\(_displayText\(replyRef\)\)/.test(chatSrc));
  ck('no sync _displayText left in the reply bar', !/getElementById\('reply-to-preview'\)\.textContent = _displayText/.test(chatSrc));

  // ── The notification preview ───────────────────────────────────
  console.log('\n[9] notification preview');
  const notifySrc = fs.readFileSync('js/notify.js', 'utf8');
  ck('notification decrypts on demand', /body = await _previewOfEncrypted\(msg\)/.test(notifySrc));
  ck('no hardcoded locked notice left in the preview branch', !/if \(msg\.message\.startsWith\('enc:'\)\) body = 'Encrypted message \(locked\)'/.test(notifySrc));

  // run the helper for real
  const notifyHelper = (() => {
    const i = notifySrc.indexOf('async function _previewOfEncrypted(');
    const j = notifySrc.indexOf('{', i);
    let depth = 0, inStr = null, inTpl = false;
    for (let k = j; k < notifySrc.length; k++) {
      const c = notifySrc[k];
      if (inStr) { if (c === '\\') { k++; continue; } if (c === inStr) inStr = null; continue; }
      if (inTpl) { if (c === '\\') { k++; continue; } if (c === '`') inTpl = false; continue; }
      if (c === '"' || c === "'") { inStr = c; continue; }
      if (c === '`') { inTpl = true; continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return notifySrc.slice(i, k + 1); }
    }
    throw new Error('unbalanced');
  })();

  const preview = async (opts) => {
    const ctx = vm.createContext({
      console,
      Encryption: {
        isActive: () => opts.hasKey,
        decrypt: () => opts.keyError ? Promise.reject(new Error('x')) : Promise.resolve(opts.plaintext),
      },
    });
    vm.runInContext(notifyHelper + '\n;globalThis.__p=_previewOfEncrypted;', ctx);
    return await ctx.__p({ message: 'enc:AAAA' });
  };

  ck('key present → real text', (await preview({ hasKey: true, plaintext: 'Hi there' })) === 'Hi there');
  ck('no key → locked notice', (await preview({ hasKey: false, plaintext: 'Hi there' })) === 'Encrypted message (locked)');
  ck('decrypt throws → locked notice', (await preview({ hasKey: true, plaintext: '', keyError: true })) === 'Encrypted message (locked)');
  ck('long text is truncated', (await preview({ hasKey: true, plaintext: 'x'.repeat(200) })).length === 121);
  ck('attachment envelope → file name', (await preview({ hasKey: true, plaintext: JSON.stringify({ dataUrl: 'data:audio/webm;base64,A', fileName: 'n.webm' }) })) === 'n.webm');

  console.log(`\n${'='.repeat(58)}\n  ${pass} passed, ${fail} failed\n${'='.repeat(58)}`);
  process.exit(fail ? 1 : 0);
})();
