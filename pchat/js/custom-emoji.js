/**
 * SHEPU ROOMS — custom-emoji.js
 * Custom emoji set from assets/emoji (per-category emoji-map.json).
 * - Picker data: categories, search, unicode insertion.
 * - Renderer: replaces outside unicode emojis with custom images per mapping.
 * Stored messages stay unicode (compatible); display swaps to custom images.
 */

const CustomEmoji = (() => {
  const INDEX_URL = 'assets/emoji/index.json';
  const MAP_SUFFIX = 'emoji-map.json';
  // Known categories (folder names). 'All' is virtual.
  const CATEGORY_ORDER = [
    'face', 'animal', 'drinks', 'festival', 'fruit', 'love', 'medical',
    'music&games', 'nature', 'people', 'romantic', 'rood',
    'symbol', 'technology', 'vehicle', 'hand', 'pchat',
  ];

  // ── Pick order ────────────────────────────────────────────────
  // index.json is alphabetical by file name, which is not how anyone
  // looks for an emoji: it splits "happy" from "laughing", and sorts
  // lip_10 before lip_2. Each category is grouped by meaning here;
  // inside a group the order is natural (2 before 10). Anything that
  // matches no group stays at the end, alphabetically, so a newly
  // added emoji still shows up — just outside a themed group.
  // Labels are for readers; the picker renders one grid per category.
  const ORDER_GROUPS = {
    face: [
      ['Happy & laughing', /happy|grin|laugh|joy|\bsmiling|slightly[_ ]smiling|star[-_ ]?struck|partying|hugging|saluting|^relieved/],
      ['Love & kisses', /kiss|heart|blush/],
      ['Playful & silly', /wink|tongue|zany|smirk|upside|money|nerd|cool|cowboy|disguis|clown|peek|^face[_ ]with[_ ]hand[_ ]over[_ ]mouth|shush|lying|shak|zipper|savor/],
      ['Sad & crying', /cry|tear|sad|frown|disappoint|pensive|plead|downcast|persever|weary|exhal|melt|anxious|worried/],
      ['Angry & annoyed', /angry|steam|swear|unamused|eye[-_ ]roll|grimac/],
      ['Surprised & shocked', /astonish|scream|fear|surprised|mind|open[-_ ]mouth|hush|dizzy|woozy|spiral/],
      ['Confused & thinking', /think|confus|confound|monocle|diagonal|dotted|without[-_ ]mouth|expressionless|neutral/],
      ['Tired & unwell', /sleep|yawn|tired|thermometer|mask|bandage|nausea|sneez|drool/],
      ['Other characters', /skull|poop|ghost|moai|blackmoon|eyes/],
    ],
    animal: [
      ['Pets', /dog|cat|rabbit|teddy|panda|koala|fox|otter/],
      ['Wild', /bear|hedgehog|raccoon|monkey/],
      ['Birds & insects', /chick|owl|penguin|bee|butterfly|ladybug|spider|mosquito/],
      ['Sea', /dolphin|whale|shark|octopus|turtle/],
      ['Fantasy', /dragon|unicorn|tyrannosaurus/],
      ['Other', /frog|snake|paw/],
    ],
    drinks: [
      ['Hot drinks', /tea|teapot|coffee|espresso/],
      ['Juices & soft drinks', /juice|lemonade|smoothie|mocktail|soda|bubble|coconut/],
      ['Water & bottles', /water|bottle|milk/],
    ],
    festival: [
      ['Party', /party|confetti|balloon|celebration[-_ ]star|birthday/],
      ['Gifts', /gift|envelope/],
      ['Seasonal', /christmas|snowman|jack[-_ ]o|wreath/],
      ['Lights & sky', /lantern|firework/],
    ],
    fruit: [
      ['Fruit', /apple|banana|mango|orange|pineapple|watermelon|grapes|strawberry|coconut|avocado/],
      ['Vegetables', /tomato|carrot|corn|cucumber|broccoli|chili/],
    ],
    love: [
      ['Red hearts', /^0[1-9]_|^10_/],
      ['Colour hearts', /heart/],
      ['Love symbols', /letter|kiss|rose|couple|hands|ring|hug|devil/],
    ],
    medical: [
      ['Care', /first[-_ ]aid|bandage|cross|stethoscope|monitor|thermometer|syringe|medicine|ice[-_ ]pack|crutch|wheelchair/],
      ['Hygiene', /soap|sanitizer|mask|tooth/],
      ['Body', /brain/],
    ],
    'music&games': [
      ['Music', /musical|guitar|piano|drum|microphone|turntable/],
      ['Games', /controller|joystick|dice|chess|puzzle/],
      ['Art & film', /palette|paint|clapper|film|theatre/],
    ],
    nature: [
      ['Plants', /flower|daisy|tulip|leaf|herb|seed|clover|tree|cactus|mushroom/],
      ['Sky & weather', /sun|moon|star|cloud|rain|storm|thunder|tornado|rainbow|snow|umbrella/],
      ['Land & sea', /mountain|wave|flame/],
    ],
    people: [
      ['Family', /baby|family|parent|child|pregnant/],
      ['Everyday', /adult|waving|curly|glasses|elderly/],
      ['Actions', /dancing|running|meditating|wheelchair|speaking/],
      ['Reactions', /shrug|facepalm/],
    ],
    romantic: [
      ['Lips', /^lip_\d+|kiss/],
      ['Flirt', /desire|flustered|attract|smirk|wink|seductive|tongue|biting|whisper/],
      ['Romance', /heart|rose|lock|tied/],
    ],
    rood: [
      ['Meals', /bread|burger|sandwich|hot[-_ ]dog|pizza|fries|chicken|taco|ramen|rice|sushi|dumpling|salad|pan[_ ]with[_ ]egg|^egg/],
      ['Sweets & snacks', /cake|cupcake|chocolate|donut|cookie|croissant|ice[-_ ]cream|lollipop|candy|popcorn/],
      ['Extras', /cheese|honey/],
    ],
    symbol: [
      ['Marks & status', /check|cross|exclamation|question|hundred|impact|sparkles|star|prohibited|warning|stop|target|sos|beacon|recycl|sleep/],
      ['Locks & security', /lock|key|shield/],
      ['Mail & messages', /envelope|inbox|outbox|memo|paperclip|pushpin|bubble|bell|megaphone|email/],
      ['Money & magic', /money|wand/],
      ['Objects', /bulb|magnif|broom|bathtub|shower|toilet|wastebasket|chain|cap|crown/],
      ['Places', /pin|globe|arrow|flag/],
      ['Shapes', /circle|infinity/],
    ],
    technology: [
      ['Time', /clock|stopwatch|calendar|watch/],
      ['Phones & computers', /smartphone|tablet|laptop|monitor|keyboard|mouse/],
      ['Audio', /headphone|earbud|speaker|microphone/],
      ['Cameras', /camera/],
      ['Power & signal', /battery|plug|signal/],
      ['Fun', /controller|headset|robot/],
    ],
    vehicle: [
      ['Road', /car|taxi|bus|ambulance|motorcycle|bicycle|scooter|rikshaw|tractor/],
      ['Rail', /train/],
      ['Air', /airplane|helicopter|rocket/],
      ['Water', /ship|sailboat/],
    ],
    hand: [
      ['Pointing', /point|backhand/],
      ['Open hands', /raised_hand|raising_hands|open_hands|splayed|palm|back_of_hand/],
      ['Fists', /fist|biceps/],
      ['Thumbs', /thumbs/],
      ['OK & pinch', /ok_hand|pinch|call_me/],
      ['Signs', /victory|love_you|horns|vulcan|crossed|finger_heart|nail/],
      ['Clap & pray', /clapping|folded/],
      ['Rude', /middle/],
    ],
    pchat: [
      ['Food & culture', /tea|jalebi|jhal|pani|samosa|guava|lungi|gamcha/],
      ['Reactions', /face|brain|zipper|blown|noodle|split|smug|tooth|middle/],
      ['Hands', /hand/],
      ['Objects & status', /megaphone|sun|status|light|balloon/],
    ],
  };

  const NATURAL = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

  let _items = [];          // [{file, unicode, category, name, src}]
  let _byUnicode = new Map(); // unicode -> first item (for auto-replace)
  let _byCategory = new Map();
  let _regex = null;
  let _loaded = false;
  let _loadPromise = null;

  function prettyName(cat) {
    return cat.replace('&', ' & ').replace(/\s+/g, ' ')
      .split(' ').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
  }

  // ── Pchat shortcodes ──────────────────────────────────────────
  // The Pchat set (assets/emoji/pchat) has no Unicode emoji at all, so
  // every image gets a deterministic 5-character shortcode — exactly
  // like the password-locked "Special" set (`:a7k2p:`). The code is
  // plain text in the message, so it looks and behaves like every
  // other emoji; the renderer swaps it for the image on screen.
  // Same file name → same code on every device, forever.
  const CODE_LETTERS = 'abcdefghijklmnopqrstuvwxyz';
  const CODE_ALPHANUM = 'abcdefghijklmnopqrstuvwxyz0123456789';

  function pchatShortcode(file, attempt) {
    let h = 2166136261 >>> 0;
    const s = 'pchat-set:' + String(file) + '#' + (attempt || 0);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    h >>>= 0;
    let code = CODE_LETTERS[h % 26];
    h = Math.floor(h / 26);
    for (let i = 0; i < 4; i++) { code += CODE_ALPHANUM[h % 36]; h = Math.floor(h / 36); }
    return ':' + code + ':';
  }

  function safeSrc(category, file) {
    // Strict allowlist to avoid path injection from JSON data
    if (!/^[A-Za-z0-9 _&+.\-]+$/.test(category)) return null;
    if (!/^[A-Za-z0-9 _+.\-]+\.png$/.test(file)) return null;
    return 'assets/emoji/' + encodeURIComponent(category) + '/' + encodeURIComponent(file);
  }

  function groupIndex(category, file) {
    const groups = ORDER_GROUPS[category];
    if (!groups) return 0;
    const name = file.toLowerCase();
    for (let i = 0; i < groups.length; i++) {
      if (groups[i][1].test(name)) return i;
    }
    return groups.length;
  }

  function sortForDisplay() {
    for (const [category, items] of _byCategory) {
      if (!ORDER_GROUPS[category]) {
        items.sort((a, b) => NATURAL.compare(a.file, b.file));
        continue;
      }
      const rank = new Map();
      for (const it of items) rank.set(it, groupIndex(category, it.file));
      items.sort((a, b) =>
        (rank.get(a) - rank.get(b)) || NATURAL.compare(a.file, b.file));
    }
    // The flat list feeds "All" search results — keep it in the same
    // category-then-group order the picker shows.
    const ordered = [];
    for (const cat of CATEGORY_ORDER) {
      const arr = _byCategory.get(cat);
      if (arr) ordered.push(...arr);
    }
    const known = new Set(CATEGORY_ORDER);
    for (const [cat, arr] of _byCategory) {
      if (!known.has(cat)) ordered.push(...arr);
    }
    _items = ordered;
  }

  function ingest(items) {
    _items = [];
    _byUnicode = new Map();
    _byCategory = new Map();
    for (const e of items) {
      if (!e || typeof e.unicode !== 'string' || !e.unicode) continue;
      if (typeof e.file !== 'string' || typeof e.category !== 'string') continue;
      const src = safeSrc(e.category, e.file);
      if (!src) continue;
      const name = typeof e.name === 'string' && e.name
        ? e.name
        : e.file.replace(/\.png$/i, '').replace(/[_-]+/g, ' ');
      const item = { file: e.file, unicode: e.unicode, category: e.category, name, src };
      _items.push(item);
      // First occurrence wins for auto-replace (duplicates exist across categories)
      if (!_byUnicode.has(e.unicode)) _byUnicode.set(e.unicode, item);
      if (!_byCategory.has(e.category)) _byCategory.set(e.category, []);
      _byCategory.get(e.category).push(item);
    }
    sortForDisplay();
    // Longest unicode first so ZWJ/variant sequences match before prefixes
    const keys = [..._byUnicode.keys()].sort((a, b) => b.length - a.length);
    const esc = keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    _regex = esc.length ? new RegExp(esc.join('|'), 'gu') : null;
    _loaded = true;
  }

  async function loadFromIndex() {
    // NOTE: never force-cache — phones otherwise keep a stale set across deploys
    // (GitHub answers 304 when unchanged, so this stays cheap).
    const res = await fetch(INDEX_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('emoji index HTTP ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) throw new Error('emoji index empty');
    ingest(data);
  }

  async function loadFromMaps() {
    // Fallback when index.json is unavailable: fetch per-folder maps
    const out = [];
    for (const cat of CATEGORY_ORDER) {
      try {
        const url = 'assets/emoji/' + encodeURIComponent(cat) + '/' + MAP_SUFFIX;
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) continue;
        const map = await res.json();
        for (const [file, unicode] of Object.entries(map || {})) {
          out.push({ file, unicode, category: cat });
        }
      } catch { /* skip missing category */ }
    }
    if (!out.length) throw new Error('no emoji maps found');
    ingest(out);
  }

  function load() {
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
      try {
        await loadFromIndex();
      } catch (e) {
        console.warn('[CustomEmoji] index failed, trying per-folder maps:', e && e.message);
        await loadFromMaps();
      }
      return _items;
    })();
    return _loadPromise;
  }

  function categories() {
    const present = CATEGORY_ORDER.filter(c => _byCategory.has(c));
    // Include any extra categories found on disk (forward-compatible)
    for (const c of _byCategory.keys()) {
      if (!present.includes(c)) present.push(c);
    }
    return ['All', ...present];
  }

  function itemsByCategory(cat) {
    if (!cat || cat === 'All') return _items;
    return _byCategory.get(cat) || [];
  }

  function search(query, cat) {
    const q = (query || '').trim().toLowerCase();
    const pool = itemsByCategory(cat);
    if (!q) return pool;
    return pool.filter(it =>
      it.name.toLowerCase().includes(q) ||
      it.unicode.includes(q) ||
      it.category.toLowerCase().includes(q)
    );
  }

  function lookup(unicode) {
    return _byUnicode.get(unicode) || null;
  }

  // Online SVG chain for unicode outside the custom set (e.g. 💬 🔐 🥹):
  // 1st = OpenMoji (hand-crafted, high quality), 2nd = Twemoji (full coverage).
  // Offline/blocked/missing → onerror restores the original character.
  const OPENMOJI_BASE = 'https://cdn.jsdelivr.net/gh/hfg-gmuend/openmoji@14.0.0/color/svg/';
  const TWEMOJI_BASE  = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@v14.0.2/assets/svg/';

  function codepoints(unicode, upper) {
    // Lone variation selectors (❤️ ☕️ 1️⃣) are dropped by both sets unless
    // the run is a ZWJ chain (❤️‍🔥 keeps FE0F on both CDNs — verified).
    const hasZwj = unicode.includes('\u200D');
    const cps = [];
    for (const ch of unicode) {
      const cp = ch.codePointAt(0);
      if (!hasZwj && cp >= 0xFE00 && cp <= 0xFE0F) continue;
      const hex = cp.toString(16);
      cps.push(upper ? hex.toUpperCase() : hex);
    }
    return cps.length ? cps.join('-') : null;
  }

  function toOpenmojiUrl(unicode) {
    const seq = codepoints(unicode, true);
    return seq ? OPENMOJI_BASE + seq + '.svg' : null;
  }

  function toTwemojiUrl(unicode) {
    const seq = codepoints(unicode, false);
    return seq ? TWEMOJI_BASE + seq + '.svg' : null;
  }

  // Any emoji run: pictographs, flags (regional-indicator pairs), keycaps, ZWJ chains
  const TWEMOJI_RE = /(?:[\u{1F1E6}-\u{1F1FF}]{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji_Component}|\p{Emoji_Modifier})|\u20E3)*/gu;

  function twemojifyEscaped(escaped) {
    return escaped.replace(TWEMOJI_RE, (match) => {
      const primary = toOpenmojiUrl(match);
      const fallback = toTwemojiUrl(match);
      if (!primary) return match;
      const fbAttr = fallback ? ` data-fb="${fallback}"` : '';
      return `<img src="${primary}" alt=""${fbAttr} data-u="${match}" class="custom-emoji custom-emoji-tw" loading="lazy" draggable="false" referrerpolicy="no-referrer" onerror="var f=this.dataset.fb;if(f){this.dataset.fb='';this.src=f;}else{this.replaceWith(document.createTextNode(this.dataset.u));}" />`;
    });
  }

  // HTML entities for one emoji (no raw unicode → later passes can't re-match it)
  function toEntities(str) {
    let out = '';
    for (const ch of String(str)) {
      out += `&#x${ch.codePointAt(0).toString(16)};`;
    }
    return out;
  }

  // Replace unicode emojis in ESCAPED html/text with custom-set <img> tags.
  // Unmapped unicode stays as-is (chat rendering is custom-set only).
  // Input must already be HTML-escaped (unicode passes through escaping).
  function emojifyEscaped(escaped) {
    if (!escaped || typeof escaped !== 'string' || !_regex) return escaped || '';
    return escaped.replace(_regex, (match) => {
      const it = _byUnicode.get(match);
      if (!it) return match;
      const alt = toEntities(match);
      const label = it.name.replace(/"/g, '&quot;');
      return `<img src="${it.src}" alt="${alt}" title="${label}" class="custom-emoji" loading="lazy" draggable="false" />`;
    });
  }

  return {
    load,
    categories,
    prettyName,
    itemsByCategory,
    search,
    lookup,
    emojifyEscaped,
    twemojifyEscaped,
    pchatShortcode,
    isLoaded: () => _loaded,
    count: () => _items.length,
  };
})();

window.CustomEmoji = CustomEmoji;

// Room-name renderer for innerHTML (ROOM NAMES ONLY — never chat text):
// custom set first, then online SVG for the rest. Falls back to plain
// escaped text when the set isn't loaded yet (call CustomEmoji.load().then(rerender)).
function emoName(name) {
  const raw = name == null ? '' : String(name);
  try {
    const esc = (typeof escapeHtml === 'function') ? escapeHtml(raw) : escapeHtmlLocalFallback(raw);
    if (typeof CustomEmoji !== 'undefined' && CustomEmoji.isLoaded && CustomEmoji.isLoaded()) {
      return CustomEmoji.twemojifyEscaped(CustomEmoji.emojifyEscaped(esc));
    }
    return esc;
  } catch {
    // Never fall back to the RAW string: every caller assigns the result to
    // innerHTML, so an unescaped fallback would turn any emoji-renderer
    // hiccup into HTML injection.
    return escapeHtmlLocalFallback(raw);
  }
}

// Minimal escaper used when the global escapeHtml() is unavailable (ui.js
// not loaded yet) or when the emoji pipeline throws.
function escapeHtmlLocalFallback(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

window.emoName = emoName;

// Warm the set on every page (join/owner/create paint names after their
// own async fetches, by which time this local JSON is ready).
try {
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
      try { CustomEmoji.load().catch(() => {}); } catch {}
    });
  }
} catch {}
