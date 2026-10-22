#!/usr/bin/env node
/**
 * Pchat — help content generator
 * =====================================================================
 * Scans the whole project and writes `js/help-data.js`.
 *
 * WHY THIS EXISTS
 * ---------------
 * A hand-written help page goes stale the moment a feature is added.
 * So the *facts* in the help page are extracted from the source code
 * itself: every button, every bot command, every API action, every
 * config value, every storage key, every sheet column and every asset
 * count is read straight out of the project.
 *
 * The *narrative* (what a sentence says about a feature) lives in the
 * DOC map below — and the generator REFUSES to run if the code contains
 * a feature that the DOC map does not mention. Add a bot command without
 * documenting it and this script fails.
 *
 * USAGE
 *   node tools/generate-help.js           # regenerate js/help-data.js
 *   node tools/generate-help.js --check   # fail if the committed file is stale
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'js', 'help-data.js');
const CHECK_ONLY = process.argv.includes('--check');

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readJson = (p) => JSON.parse(read(p));
const exists = (p) => fs.existsSync(path.join(ROOT, p));

/* ------------------------------------------------------------------ *
 * DOC map — the narrative for features the scanner can only describe.
 * The generator asserts that every code-level feature appears here.
 * ------------------------------------------------------------------ */
const DOC = {
  pages: {
    'index.html':     { title: 'Chats',        blurb: 'Your dashboard — every room you own and every room you have joined, plus the buttons to create or join one.' },
    'login.html':     { title: 'Sign in',      blurb: 'Sign in with Google, use an email name, or continue as a guest. Nothing here is required to use a quick room.' },
    'create.html':    { title: 'Create a room', blurb: 'Name your room, pick a wallpaper and a kind, and get a shareable link and QR code.' },
    'join.html':      { title: 'Join a room',  blurb: 'Open a shared link, choose a nickname, and enter. A room password is asked for here if the room needs one.' },
    'room.html':      { title: 'Chat room',    blurb: 'The room itself — messages, calls, the member list, the bot, the music player and the room settings.' },
    'owner.html':     { title: 'Owner panel',  blurb: 'Everything only the owner can do: statistics, moderation, renaming, locking, backups and link tools.' },
    'settings.html':  { title: 'Settings',     blurb: 'Your account, privacy tools, notifications, relay servers, and the way into the help and about pages.' },
    'privacy.html':   { title: 'Privacy Policy', blurb: 'Plain-language description of what the app stores on your device, what is saved in the room owner’s Drive, and what the public relay can see.' },
    'about.html':     { title: 'About',        blurb: 'What Pchat is, why it works the way it does, and what the project is built on.' },
    'help.html':      { title: 'Help',         blurb: 'Every feature of the app, in detail — this page, generated from the app itself.' },
  },

  /* Bot commands: action type → what it does + how to say it. */
  bot: {
    'theme_change': {
      title: 'Change the wallpaper',
      say:  ['theme 3', 'theme number 4', 'theme change koro', 'background badal dao', 'থিম ৩ করো'],
      blurb: 'Sets the room wallpaper for everybody. Give a number, or leave it out and the bot picks one.',
    },
    'theme_info': {
      title: 'Which wallpaper is on',
      say:  ['which theme is this', 'কোন থিম চালু আছে', 'theme koto'],
      blurb: 'Tells you the current wallpaper and how many exist.',
    },
    'call': {
      title: 'Start a call',
      say:  ['call Rahim', 'audio call koro', 'video call dao'],
      blurb: 'Starts an audio or video call. Name a member for a one-to-one call, or leave the name out to ring the whole room.',
    },
    'remove_member': {
      title: 'Remove a member',
      say:  ['remove Rahim ke', 'Rahim ke ber kore dao'],
      blurb: 'Removes someone from the room. The bot always asks for confirmation first.',
    },
    'member_list': {
      title: 'Who is in the room',
      say:  ['koto jon ache', 'member list dao'],
      blurb: 'Lists the members of the room.',
    },
    'invite_link': {
      title: 'Share the invite link',
      say:  ['invite link dao', 'room link share koro'],
      blurb: 'Puts the room link on your clipboard.',
    },
    'room_lock': {
      title: 'Lock the room',
      say:  ['room lock koro'],
      blurb: 'Makes the room read-only. Owner only.',
    },
    'room_unlock': {
      title: 'Unlock the room',
      say:  ['room unlock koro'],
      blurb: 'Lets the room accept messages again. Owner only.',
    },
    'room_delete': {
      title: 'Delete the room',
      say:  ['delete room'],
      blurb: 'Deletes the room. The bot asks for confirmation first.',
    },
    'password_off': {
      title: 'Turn the room password off',
      say:  ['password off koro'],
      blurb: 'Points you at Settings → Room Password. The bot will never ask you to type a password in chat.',
    },
    'password_help': {
      title: 'Set or change the room password',
      say:  ['password on koro', 'password change koro'],
      blurb: 'Explains where to set the room password.',
    },
  },

  /* Feature groups per screen — prose the scanner cannot derive. */
  groups: {
    room: [
      { title: 'Messages',      blurb: 'Send text, images, files and voice notes. Reply to a message, edit your own, delete it, or react to it with an emoji.' },
      { title: 'Reactions',     blurb: 'Tap a message to open the reaction picker. Reactions show who reacted, and update live for everyone.' },
      { title: 'Typing & seen', blurb: 'A typing indicator appears while somebody is composing, and your own messages turn blue once they have been seen.' },
      { title: 'Failed sends',  blurb: 'If a message cannot be delivered it stays in the feed marked as failed, with a Retry button. Nothing is ever lost silently.' },
      { title: 'Calls',         blurb: 'One-to-one or room-wide audio and video, with mute, camera, screen share, and a minimise button so you can keep chatting during a call.' },
      { title: 'Room radio',    blurb: 'One person presses play and the whole room hears the same track. Play, pause, skip, and set your own volume.' },
      { title: 'Members',       blurb: 'A live member list with online state, plus the room owner\'s controls for ban, remove, lock, disable and rename.' },
      { title: 'Wallpaper',     blurb: 'Five wallpapers. Changing one changes it for everybody in the room, on every device.' },
      { title: 'Emoji',         blurb: 'A 500-plus image set that replaces the system emoji, a public shortcode set, and a password-locked pack that stays encrypted on disk.' },
      { title: 'Room password', blurb: 'Sets a passphrase so new messages are encrypted on each device before they are sent.' },
      { title: 'Notifications', blurb: 'A bell in the header turns system notifications on or off. Notifications only appear when the room is not in front of you.' },
      { title: 'Assistant',     blurb: 'Mention @shepu-ai to ask a question, or give it a room command. Commands are understood on the device and never reach the AI provider.' },
    ],
    dashboard: [
      { title: 'Your rooms',    blurb: 'Every room you own and every room you have joined, with the last message preview and a quick call button.' },
      { title: 'Create',        blurb: 'Make a saved room (backed by your own Google Drive) or a quick room (no account needed).' },
      { title: 'Join',          blurb: 'Paste an invite code, or open a shared link.' },
      { title: 'Share',         blurb: 'Generate a QR code for a room, or copy a link. The QR is drawn in the page, so the link never leaves your device.' },
    ],
    owner: [
      { title: 'Statistics',    blurb: 'Member count, message count, creation date and how many people are online right now.' },
      { title: 'Members',       blurb: 'The full roster with roles and last-seen times, plus ban and remove.' },
      { title: 'Room controls', blurb: 'Rename, lock, disable, enable, clear the chat, or delete the room.' },
      { title: 'Backup',        blurb: 'Open the backing Google Sheet, export the whole conversation as CSV, or copy the endpoint URL.' },
      { title: 'Link tools',    blurb: 'Copy the invite link, regenerate it to revoke the old one, or show the QR.' },
    ],
    settings: [
      { title: 'Account',       blurb: 'Your Google sign-in, your display name, your profile picture, and the OAuth client setup if you host the app yourself.' },
      { title: 'Notifications', blurb: 'Ask the browser for permission and see whether notifications are on.' },
      { title: 'Relay',         blurb: 'Choose which public relay servers carry cross-device messages, test them, and see their live health. If chat only works on your own device, a relay is probably blocked on your network.' },
      { title: 'Privacy',       blurb: 'Where your data is stored, plus buttons to clear the message cache or wipe all local data.' },
      { title: 'Help',          blurb: 'Opens the help centre — every feature of the app, generated from the app itself.' },
      { title: 'About',         blurb: 'What the app is, how it is built, and what it is made of.' },
    ],
  },

  /* Keyboard shortcuts, verified against the code by the scanner. */
  shortcuts: [
    { keys: 'Enter',        where: 'Chat composer',   blurb: 'Send the message.' },
    { keys: 'Shift+Enter',  where: 'Chat composer',   blurb: 'Insert a line break instead of sending.' },
    { keys: 'Esc',          where: 'Anywhere',        blurb: 'Close the open dialog, modal or image viewer.' },
    { keys: '↑ / ↓',        where: 'Composer',        blurb: 'Move through the @shepu-ai suggestions. Enter accepts the highlighted one.' },
    { keys: 'Tab',          where: 'Composer',        blurb: 'Accept the highlighted suggestion.' },
    { keys: 'Long press',   where: 'Empty wallpaper', blurb: 'Open the wallpaper picker on a phone.' },
  ],

  /* The questions people actually ask. */
  troubleshooting: [
    { q: 'The join button does nothing', a: 'The link may have lost its ?ep= part. Ask the owner for a fresh link — a full link, not a shortened one.' },
    { q: 'It says "Invalid session"', a: 'The session expired or was revoked (the link was rotated, or you were removed). Open the link again to rejoin.' },
    { q: 'It says "Rate limit exceeded"', a: 'More than 30 messages a minute. Wait a minute and carry on — nothing was lost.' },
    { q: 'It says "Room is locked"', a: 'The owner made the room read-only. You can still read everything.' },
    { q: 'Messages stop arriving', a: 'Check the relay health in Settings → Relay. If every server is unreachable the network is blocking it; the app falls back to polling, which is slower.' },
    { q: 'Calls will not connect', a: 'A direct peer-to-peer path is blocked. Messages still work over the relay; calls need an open path.' },
    { q: 'The assistant never answers', a: 'The mention needs a space after it — write "@shepu-ai" then your question. Room commands also need to mention it.' },
    { q: 'The wallpaper will not change', a: 'The room may be locked, or the relay may be unreachable so the change cannot reach the other devices. Check the relay health.' },
    { q: 'Notifications do not appear on Android', a: 'Android needs the service worker to be activated. Open Settings → Notifications and allow them; the first tap registers it.' },
    { q: 'The phone layout looks out of date', a: 'The browser is using a cached stylesheet. The assets are versioned, so a single hard refresh picks up the current one.' },
    { q: 'A message says "Failed"', a: 'It could not be delivered. The bubble stays in the chat with a Retry button — tap it and it sends again. The text is never lost silently.' },
    { q: 'I forgot the room password', a: 'It cannot be recovered. The owner can set a new one, which invalidates the old link.' },
  ],
};

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */
const problems = [];
const fail = (msg) => problems.push(msg);

function evalInSandbox(files, expression, extra = {}) {
  const src = files.map(read).join('\n');
  const sandbox = Object.assign({
    window: {}, console, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: {}, document: { getElementById: () => null, addEventListener() {} },
    location: { search: '', origin: 'http://localhost', hostname: 'localhost', port: '', protocol: 'http:', pathname: '/' },
    crypto: { getRandomValues: (a) => a }, TextEncoder, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval, Date, Math, JSON, Promise, Array, Object, String, Number, Boolean, Intl,
  }, extra);
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src + '\n;globalThis.__out = (' + expression + ');', ctx, { timeout: 10000 });
  return ctx.__out;
}

/* ------------------------------------------------------------------ *
 * 1. Pages
 * ------------------------------------------------------------------ */
function scanPages() {
  const out = [];
  for (const file of fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort()) {
    const src = read(file);
    const title = (src.match(/<title>([^<]*)<\/title>/i) || [, file])[1]
      .replace(/[—–-]\s*Pchat shepu.*$/i, '').trim();
    const description = (src.match(/<meta name="description" content="([^"]*)"/i) || [, ''])[1].trim();
    const doc = DOC.pages[file] || {};
    out.push({
      file,
      title: doc.title || title,
      pageTitle: title,
      description,
      blurb: doc.blurb || description,
    });
  }
  // A page in the repo but not in the DOC map means somebody added a screen
  // and forgot to describe it.
  for (const p of out) {
    if (!DOC.pages[p.file]) fail(`New page "${p.file}" has no description in the DOC map of tools/generate-help.js`);
  }
  // …and a DOC entry for a page that no longer exists.
  for (const file of Object.keys(DOC.pages)) {
    if (!exists(file)) fail(`DOC map mentions "${file}" but that page no longer exists`);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 2. Interactive elements per page — the complete button inventory
 * ------------------------------------------------------------------ */
function scanControls() {
  const out = {};
  for (const file of fs.readdirSync(ROOT).filter((f) => f.endsWith('.html')).sort()) {
    const src = read(file);
    const list = [];
    const re = /<(button|a)\b([^>]*)>([\s\S]{0,300}?)<\/\1>/g;
    let m;
    while ((m = re.exec(src))) {
      const attrs = m[2], inner = m[3];
      const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
      if (!id) continue;
      const title = (attrs.match(/\btitle="([^"]+)"/) || [])[1];
      const aria = (attrs.match(/\baria-label="([^"]+)"/) || [])[1];
      const text = inner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      const label = (aria || title || text || '').trim();
      if (!label) continue;
      if (/^(Close|Cancel)$/i.test(label)) continue;   // trivial, and repeated
      list.push({ id, label: label.slice(0, 80) });
    }
    // de-duplicate by id, keep the first label
    const seen = new Set();
    out[file] = list.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 3. Settings sections
 * ------------------------------------------------------------------ */
function scanSettingsSections() {
  const src = read('settings.html');
  const nav = [...src.matchAll(/data-section="([a-z-]+)"[\s\S]{0,400}?class="item-label">([^<]+)</g)]
    .map((m) => ({ key: m[1], label: m[2].trim() }));
  const sections = [...src.matchAll(/<section class="settings-section[^"]*" id="section-([a-z-]+)">[\s\S]{0,400}?<h3[^>]*>([^<]+)</g)]
    .map((m) => ({ key: m[1], heading: m[2].trim() }));
  return nav.map((n) => {
    const s = sections.find((x) => x.key === n.key);
    return { key: n.key, label: n.label, heading: s ? s.heading : n.label };
  });
}

/* ------------------------------------------------------------------ *
 * 4. Bot commands — extracted from the code, cross-checked with DOC
 * ------------------------------------------------------------------ */
/* Balanced-paren argument extraction: action(cond ? 'a' : 'b') contains
 * parentheses inside the condition, so a simple regex would cut it short. */
function callArgs(src, callee) {
  const out = [];
  const re = new RegExp('\\b' + callee + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1, start = i;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

function scanBot() {
  const src = read('js/shepu-actions.js');
  // action('x') and action(cond ? 'x' : 'y') — take every string literal
  // that appears inside an action(...) call.
  const inCode = [...new Set(callArgs(src, 'action')
    .flatMap((a) => [...a.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])))];
  const inSwitch = [...new Set([...src.matchAll(/case '([a-z_]+)'/g)].map((m) => m[1]))]
    .filter((t) => t !== 'default');
  const implemented = inCode.filter((t) => inSwitch.includes(t));

  for (const t of implemented) {
    if (!DOC.bot[t]) fail(`Bot action "${t}" exists in js/shepu-actions.js but is not documented in the DOC map`);
  }
  for (const t of Object.keys(DOC.bot)) {
    if (!implemented.includes(t)) fail(`DOC map documents the bot action "${t}" but the code does not implement it`);
  }

  // The music commands live in the bot itself, not in the action layer.
  const botSrc = read('js/shepu-bot.js');
  const musicCmds = [...new Set([...botSrc.matchAll(/cmd === '([a-z]+)'/g)].map((m) => m[1]))];

  return {
    mention: '@shepu-ai',
    actions: implemented.map((t) => Object.assign({ type: t }, DOC.bot[t])),
    musicCommands: musicCmds,
    docs: DOC.bot,
  };
}

/* ------------------------------------------------------------------ *
 * 5. Backend API
 * ------------------------------------------------------------------ */
function scanApi() {
  const src = read('apps-script/Code.gs');
  // doGet and doPost have their own action lists — split the two blocks.
  const getBlock = (src.match(/function doGet\([^)]*\)\s*\{([\s\S]*?)\n\}/) || [, ''])[1];
  const postBlock = (src.match(/function doPost\([^)]*\)\s*\{([\s\S]*?)\n\}/) || [, ''])[1];
  const get = [...new Set([...getBlock.matchAll(/action === '([a-z_]+)'/g)].map((m) => m[1]))];
  const post = [...new Set([...postBlock.matchAll(/action === '([a-z_]+)'/g)].map((m) => m[1]))];
  const ops = [...new Set([...src.matchAll(/op === '([a-z_]+)'/g)].map((m) => m[1]))];
  const errors = [...new Set([...src.matchAll(/errorResponse\([^)]*?'([A-Z_]+)'\)/g)].map((m) => m[1]))];
  const limits = [...new Set([...src.matchAll(/checkRateLimit\('([a-z_]+)',\s*(\d+),\s*(\d+)\)/g)]
    .map((m) => `${m[1]}|${m[2]}|${m[3]}`))]
    .map((s) => { const [scope, limit, windowSec] = s.split('|'); return { scope, limit: +limit, windowSec: +windowSec }; });
  return { get, post, ops, errors, limits };
}

/* ------------------------------------------------------------------ *
 * 6. Config values
 * ------------------------------------------------------------------ */
function scanConfig() {
  const src = read('js/config.js');
  const out = [];
  const re = /^\s{2}([A-Z_][A-Z0-9_]*)\s*:\s*([^,\n]+?),?\s*(?:\/\/.*)?$/gm;
  let m;
  while ((m = re.exec(src))) {
    const key = m[1], raw = m[2].trim();
    if (/^function/.test(raw)) continue;
    let value = raw;
    if (value.endsWith(',')) value = value.slice(0, -1);
    out.push({ key, value });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 7. Storage keys
 * ------------------------------------------------------------------ */
function scanStorage() {
  // Scan EVERY module, not just storage.js — modules keep their own keys.
  const files = fs.readdirSync(path.join(ROOT, 'js'))
    .filter((f) => f.endsWith('.js') && !f.endsWith('.min.js'))
    .map((f) => 'js/' + f);
  const all = files.map(read).join('\n');
  const pick = (re) => [...new Set([...all.matchAll(re)].map((m) => m[1]))];

  // 1. Keys used directly: localStorage.getItem('shepu_rooms')
  const direct = pick(/(?:localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)\(\s*'([^']+)'/g);

  // 2. Keys held in a constant: const LS_KEY = 'shepu_relay_servers'
  const constKeys = new Map();
  for (const m of all.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*'(shepu_[a-z0-9_]+)'/g)) {
    constKeys.set(m[1], m[2]);
  }
  const viaConst = [];
  for (const m of all.matchAll(/(?:localStorage|sessionStorage)\.(?:setItem|getItem|removeItem)\(\s*([A-Za-z_$][\w$]*)/g)) {
    const k = constKeys.get(m[1]);
    if (k) viaConst.push(k);
  }

  // 3. Per-id key prefixes. These appear in three shapes:
  //      const K = 'shepu_mock_room_' + id
  //      const K = (id) => `shepu_pwk_${id}`
  //      localStorage.setItem('shepu_x_' + id, …)
  //    A literal that ends with "_" is always a prefix.
  const templated = pick(/'(shepu_[a-z0-9_]+_)'/g)
    .concat(pick(/`(shepu_[a-z0-9_]+)\$\{/g));

  const config = read('js/config.js');
  const cfgKeys = [...new Set([...config.matchAll(/LS_[A-Z_]+:\s*'([^']+)'/g)].map((m) => m[1]))];
  const idbName = (config.match(/IDB_NAME:\s*'([^']+)'/) || [, 'SHEPURooms'])[1];
  const idbVersion = (config.match(/IDB_VERSION:\s*(\d+)/) || [, '1'])[1];

  // Group the per-room prefixes by what they hold.
  const classify = (k) => {
    if (/mock_room/.test(k)) return 'rooms';
    if (/bot_session/.test(k)) return 'bot';
    if (/pw|password|passphrase/.test(k)) return 'roomPassword';
    if (/relay/.test(k)) return 'relay';
    return null;
  };
  const patterns = { rooms: [], bot: [], roomPassword: [], relay: [] };
  const patternSet = new Set();
  templated.forEach((k) => {
    const bucket = classify(k);
    if (bucket && !patternSet.has(k)) { patternSet.add(k); patterns[bucket].push(k); }
  });

  const fixed = [...new Set([...cfgKeys, ...direct, ...viaConst])]
    .filter((k) => !patternSet.has(k))
    .sort();

  const sessionAll = [...new Set([...direct, ...viaConst])];
  return {
    localStorage: fixed,
    localStoragePatterns: patterns,
    sessionStorage: [...new Set([
      ...sessionAll.filter((k) => /pw|password|passphrase/.test(k)),
      ...templated.filter((k) => /pw|password|passphrase/.test(k)),
    ])].sort(),
    indexeddb: { name: idbName, version: +idbVersion },
  };
}

/* ------------------------------------------------------------------ *
 * 8. Sheet tabs
 * ------------------------------------------------------------------ */
function scanSheets() {
  const src = read('js/sheets.js');
  const tabs = [];
  const re = /name:\s*CONFIG\.SHEETS\.([A-Z_]+),\s*\n\s*headers:\s*\[([^\]]*)\]/g;
  let m;
  while ((m = re.exec(src))) {
    tabs.push({
      key: m[1],
      name: m[1].toLowerCase(),
      columns: m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean),
    });
  }
  return tabs;
}

/* ------------------------------------------------------------------ *
 * 9. Assets
 * ------------------------------------------------------------------ */
function scanAssets() {
  const index = readJson('assets/emoji/index.json');
  const byCat = {};
  for (const e of index) byCat[e.category] = (byCat[e.category] || 0) + 1;

  const emojiSrc = read('js/custom-emoji.js');
  const order = [...new Set([...emojiSrc.matchAll(/'([a-z&]+)'/g)].map((m) => m[1]))]
    .filter((c) => byCat[c]);

  const themeFiles = fs.readdirSync(path.join(ROOT, 'assets/themes')).filter((f) => f.endsWith('.webp') && !f.includes('_and'));
  const music = fs.readdirSync(path.join(ROOT, 'assets/music')).filter((f) => /\.(mp3|m4a|ogg|wav)$/i.test(f));
  const sounds = fs.readdirSync(path.join(ROOT, 'assets/sounds')).filter((f) => /\.(mp3|m4a|ogg|wav)$/i.test(f));
  const icons = fs.readdirSync(path.join(ROOT, 'assets/icons')).filter((f) => /\.(png|webp|jpe?g|svg|apng)$/i.test(f));

  const specialDir = path.join(ROOT, 'assets/emoji/special');
  const specialZip = fs.readdirSync(specialDir).find((f) => f.endsWith('.zip'));
  let specialCount = 0;
  if (specialZip) {
    try {
      const buf = fs.readFileSync(path.join(specialDir, specialZip));
      specialCount = (buf.toString('latin1').match(/\.png/gi) || []).length;
    } catch { /* ignore */ }
  }
  const specialCodes = exists('assets/emoji/special/codes.json')
    ? Object.keys(readJson('assets/emoji/special/codes.json')).length : 0;

  const pchatMap = exists('assets/emoji/pchat/emoji-map.json')
    ? Object.keys(readJson('assets/emoji/pchat/emoji-map.json')).length : 0;

  return {
    emoji: { total: index.length, categories: order.map((c) => ({ name: c, count: byCat[c] })), pchat: pchatMap },
    special: { count: specialCodes, imagesInPack: specialCount },
    themes: themeFiles.length,
    music: music.length,
    sounds: sounds.length,
    icons: icons.length,
  };
}

/* ------------------------------------------------------------------ *
 * 10. Relay servers
 * ------------------------------------------------------------------ */
function scanRelay() {
  const src = read('js/ntfy-sync.js');
  const m = src.match(/const DEFAULT_SERVERS = \[([\s\S]*?)\]/);
  const servers = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  const payloadTypes = [...new Set([...src.matchAll(/payload\.type === '([a-z_]+)'/g)].map((x) => x[1]))];
  const maxBytes = (src.match(/const RELAY_MAX_BYTES = (\d+)/) || [, 4096])[1];
  return { servers, payloadTypes, maxBytes: +maxBytes };
}

/* ------------------------------------------------------------------ *
 * 11. Room kinds
 * ------------------------------------------------------------------ */
function scanRoomKinds() {
  const src = read('js/rooms.js');
  const kinds = [...new Set([...src.matchAll(/kind === '([a-z]+)'|kind === '([a-z]+)'/g)].map((m) => m[1] || m[2]))];
  const icons = (src.match(/QUICK_ROOM_ICONS: \[([\s\S]*?)\]/) || [, ''])[1].match(/'([^']+)'/g) || [];
  return { kinds: kinds.length ? kinds : ['saved', 'quick'], quickIcons: icons.length };
}

/* ------------------------------------------------------------------ *
 * 12. Encryption
 * ------------------------------------------------------------------ */
function scanEncryption() {
  const src = read('js/encryption.js');
  const iters = (src.match(/iterations:\s*(\d+)/) || [, 0])[1];
  const algo = (src.match(/name:\s*"(PBKDF2|AES-GCM)"/) || [, ''])[1];
  const saltDefault = (src.match(/saltString\s*=\s*"([^"]+)"/) || [, ''])[1];
  const inst = evalInSandbox(['js/encryption.js'], 'null');
  void inst;
  return { iterations: +iters, kdf: 'PBKDF2', cipher: 'AES-GCM', keyBits: 256, defaultSalt: saltDefault };
}

/* ------------------------------------------------------------------ *
 * Assemble
 * ------------------------------------------------------------------ */
const data = {
  generatedAt: new Date().toISOString(),
  app: {
    name: 'Pchat shepu',
    aka: 'SHEPU ROOMS',
    tagline: 'Fast & Private Messaging',
    version: '1.0',
  },
  pages: scanPages(),
  controls: scanControls(),
  settingsSections: scanSettingsSections(),
  bot: scanBot(),
  api: scanApi(),
  config: scanConfig(),
  storage: scanStorage(),
  sheets: scanSheets(),
  assets: scanAssets(),
  relay: scanRelay(),
  roomKinds: scanRoomKinds(),
  encryption: scanEncryption(),
  groups: DOC.groups,
  shortcuts: DOC.shortcuts,
  troubleshooting: DOC.troubleshooting,
};

/* ------------------------------------------------------------------ *
 * Report + write
 * ------------------------------------------------------------------ */
console.log('Pchat help generator');
console.log('─'.repeat(56));
console.log(`  pages           ${data.pages.length}`);
console.log(`  bot actions     ${data.bot.actions.length}`);
console.log(`  api actions     ${data.api.get.length + data.api.post.length} (get ${data.api.get.length}, post ${data.api.post.length})`);
console.log(`  room ops        ${data.api.ops.length}`);
console.log(`  config values   ${data.config.length}`);
console.log(`  storage keys    ${data.storage.localStorage.length + data.storage.sessionStorage.length}`);
console.log(`  sheet tabs      ${data.sheets.length}`);
console.log(`  emoji           ${data.assets.emoji.total} in ${data.assets.emoji.categories.length} categories`);
console.log(`  assets          ${data.assets.themes} themes, ${data.assets.music} tracks, ${data.assets.sounds} sounds`);
console.log(`  relay servers   ${data.relay.servers.length}`);

if (problems.length) {
  console.log('\n✗ The project changed in a way the help content does not describe yet:');
  for (const p of problems) console.log('   • ' + p);
  console.log('\n  Add the missing descriptions to the DOC map in tools/generate-help.js,');
  console.log('  then re-run:  node tools/generate-help.js');
  process.exit(1);
}

const body = `/**
 * Pchat — help content
 * =====================================================================
 * GENERATED FILE — DO NOT EDIT.
 * Produced by  tools/generate-help.js  from the project source.
 * Re-run that script after changing a feature; it refuses to write
 * until every change in the code is described.
 *
 * Generated: ${data.generatedAt}
 */
window.HelpData = ${JSON.stringify(data, null, 2)};
`;

if (CHECK_ONLY) {
  let current = '';
  try { current = fs.readFileSync(OUT, 'utf8'); } catch { /* missing */ }
  // The generation timestamp changes on every run — ignore it, otherwise
  // the file would never match and the check would be useless.
  const normalise = (s) => s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, '<timestamp>');
  if (normalise(current) !== normalise(body)) {
    console.log('\n✗ js/help-data.js is out of date. Run:  node tools/generate-help.js');
    process.exit(1);
  }
  console.log('\n✓ js/help-data.js is up to date.');
  process.exit(0);
}

fs.writeFileSync(OUT, body);
console.log(`\n✓ wrote ${path.relative(ROOT, OUT)} (${(body.length / 1024).toFixed(1)} KB)`);
