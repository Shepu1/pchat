/**
 * SHEPU ROOMS — shepu-actions.js
 * ------------------------------------------------------------------
 * Local, multilingual room-command layer for the in-chat Shepu-AI bot.
 *
 * Understands Bengali, Banglish and English requests such as:
 *   - "audio call deu", "রহিমকে ভিডিও কল দাও"
 *   - "Rahim ke remove koro", "ei member k kick koro"
 *   - "invite link deu", "আমন্ত্রণ লিংক দাও"
 *   - "password off koro", "room lock koro"
 *   - "room delete koro", "এই room টা মুছে ফেলো"
 *
 * Member removal and room deletion are owner-only and ask for a danger
 * confirmation. Other room commands run directly; the room server still
 * enforces owner permissions where required. The parser is deterministic
 * (with a small typo-tolerant local fallback) so it works even when the
 * online text model is unavailable.
 */

const ShepuActions = (() => {
  const BOT_ID = 'shepu_ai_bot';

  // Words that turn a sentence into a "how do I…?" question. Those must be
  // answered by the AI, not executed as a room command.
  const QUESTION_RE = /(\bhow\s+(?:do|to|can|does|would)\b|\bwhat\s+is\b|\bwhat\s+happens\b|\bexplain\b|\bmeaning\b|\bmane\s*ki\b|\bmatlab\b|\brules?\b|\bkivabe\b|\bkibhabe\b|\bkibabe\b|\bkibhave\b|\bkivhabe\b|\bkemon\s*kore\b|\bkemne\b|\bki\s*(?:vabe|bhabe|hoy|hobe)\b|\bniyom\b|\bkanun\b|কিভাবে|কীভাবে|কি\s*ভাবে|কেমন\s*করে|কেমনে|কি\s*(?:হয়|হবে)|কী\s*(?:হয়|হবে)|মানে\s*কি|নিয়ম|নীতিমালা|জানতে|বোঝাও|ব্যাখ্যা)/i;
  // Questions should go to the AI, not run a room action. "Who is here?"
  // is the one exception: it is a read-only member-list request.
  const QUESTION_START_RE = /^(?:who|what|why|when|where|which|how|is|are|am|do|does|did|can|could|should|would|will|may|tell\s+me|explain|কে|কি|কী|কেন|কোথায়|কখন|কিভাবে|কীভাবে)(?=\s|$)/i;
  const MEMBER_LIST_QUESTION_RE = /^(?:who\s+(?:is|are|'s)\s+(?:here|online)|ke\s+ke\s+ache|কে\s*কে\s*আছে)(?=\s|$)/i;
  // Polite request forms should still be treated as commands when they do
  // not ask how/why/what. Member removal and room deletion still require a
  // danger confirmation; the other actions rely on server-side owner checks.
  const REQUEST_START_RE = /^(?:please|pls|kindly|can|could|would|will|are\s+you\s+able\s+to|is\s+it\s+possible\s+to|ektu|একটু|দয়া\s*করে|প্লিজ)\b/i;
  // "remove koro na" / "call dio na" are negative requests. Password-off
  // phrases such as "password nai koro" are intentionally excluded.
  const NEGATED_ACTION_RE = /(?:\b(?:koro|kor|korte|korben|dao|deu|den|din|call|remove|delete|lock|unlock|invite|kick)\b.{0,24}\b(?:na|nai|nei|not|never)\b)|(?:\b(?:not|never|don'?t|do\s+not)\b.{0,24}\b(?:remove|call|delete|lock|unlock|invite|kick)\b)|(?:করো|কর|দাও|দিন|রিমুভ|ডিলিট|কল|লক|আনলক|ইনভাইট).{0,24}(?:না|নেই|নয়)/i;

  const STOP_WORDS = new Set([
    'a', 'an', 'the', 'to', 'from', 'for', 'of', 'on', 'in', 'at', 'do', 'de', 'please', 'pls',
    'ei', 'oi', 'this', 'that', 'eita', 'oita', 'member', 'members', 'user', 'users',
    'jon', 'manush', 'lok', 'person', 'people', 'somossa', 'problem', 'ta', 'take', 'tare',
    'ke', 're', 'ko', 'k', 'er', 'e', 'o', 'and', 'or', 'with', 'me', 'my', 'our',
    'ami', 'amake', 'amar', 'apni', 'apnar', 'tumi', 'tomar', 'tui', 'tor',
    'koro', 'kor', 'korun', 'kore', 'kro', 'krun', 'korte', 'karo', 'kar', 'dao', 'deu', 'den', 'din', 'dite', 'dibo',
    'chai', 'chahi', 'lagbe', 'start', 'chalu', 'chalao', 'bondho', 'bondhu', 'off',
    'remove', 'kick', 'hatao', 'hata', 'bad', 'ber', 'audio', 'voice', 'video', 'call', 'kol',
    'invite', 'invitation', 'link', 'url', 'share', 'copy', 'send', 'give',
    'password', 'passcode', 'lock', 'unlock', 'room', 'chat', 'group',
    'sobai', 'sabai', 'everyone', 'all', 'full', 'whole', 'purbo', 'puro',
    'bahar', 'out', 'sorate', 'soriye', 'biday', 'pathiye', 'pathao',
    'rakhte', 'rakhbo', 'rakhben', 'rakha', 'delete', 'deleted', 'erase',
    'destroy', 'muche', 'muchiye', 'sesh', 'nosto', 'get', 'rid', 'theke',
    'একটা', 'একটি', 'এই', 'ওই', 'সদস্য', 'সদস্যদের', 'মেম্বার', 'মেম্বারকে', 'ব্যক্তি',
    'কে', 'রে', 'এর', 'ও', 'এবং', 'আমি', 'আমাকে', 'আমার', 'আপনি', 'আপনার', 'তুমি', 'তোমার',
    'করো', 'কর', 'করুন', 'করে', 'দাও', 'দিন', 'দিতে', 'দিব', 'চাই', 'লাগবে',
    'শুরু', 'চালু', 'বন্ধ', 'রিমুভ', 'কিক', 'বাদ', 'বের', 'অডিও', 'ভয়েস', 'ভিডিও', 'কল',
    'আমন্ত্রণ', 'ইনভাইট', 'লিংক', 'লিঙ্ক', 'শেয়ার', 'কপি', 'পাঠাও', 'দাও',
    'পাসওয়ার্ড', 'পাসওয়ার্ড', 'লক', 'আনলক', 'রুম', 'চ্যাট', 'গ্রুপ', 'সবাই', 'পুরো',
    'বাহার', 'সরিয়ে', 'বিদায়', 'পাঠিয়ে', 'রাখতে', 'রাখব', 'রাখবেন', 'রাখা',
    'ডিলিট', 'মুছে', 'মুছিয়ে', 'শেষ', 'ধ্বংস', 'নষ্ট', 'থেকে', 'হইতে'
  ]);

  // Fuzzy fallback vocabulary. Exact patterns below are fast and predictable;
  // this layer catches small typos and less direct phrasing. It is local-only
  // and never asks an online model to decide whether to run a room action.
  const FUZZY = {
    room: ['room', 'rooms', 'rom', 'rum', 'chat', 'chatt', 'group', 'gruop', 'ghor', 'রুম', 'চ্যাট', 'গ্রুপ', 'ঘর'],
    member: ['member', 'members', 'user', 'users', 'person', 'people', 'manush', 'lok', 'jon', 'সদস্য', 'মেম্বার', 'মেম্বর', 'ব্যক্তি', 'লোক', 'জন', 'মানুষ'],
    remove: ['remove', 'removed', 'removing', 'kick', 'kik', 'hatao', 'hata', 'bad', 'ber', 'bahar', 'out', 'sor', 'sorao', 'sorate', 'biday', 'pathiye', 'pathao', 'get rid of', 'kick out', 'রিমুভ', 'রিমোভ', 'কিক', 'বাদ', 'বের', 'বাহার', 'সরাও', 'সরিয়ে', 'বিদায়', 'পাঠিয়ে'],
    delete: ['delete', 'deleted', 'erase', 'destroy', 'remove', 'muche', 'muchiye', 'sesh', 'nosto', 'biday', 'ডিলিট', 'মুছে', 'মুছিয়ে', 'শেষ', 'ধ্বংস', 'নষ্ট', 'বিদায়'],
    password: ['password', 'passwords', 'passcode', 'pass', 'পাসওয়ার্ড', 'পাসওয়ার্ড', 'গোপন', 'কোড'],
    passOff: ['off', 'remove', 'delete', 'disable', 'stop', 'bondho', 'bondhu', 'bond', 'band', 'bad', 'ber', 'nai', 'nei', 'no', 'without', 'chara', 'chhara', 'lagbe na', 'lagbe nai', 'lagbe nei', 'chai na', 'chai nei', 'ছাড়া', 'ছাড়া', 'বন্ধ', 'খুলে', 'সরিয়ে', 'রিমুভ', 'নিষ্ক্রিয়', 'লাগবে না', 'লাগেনা', 'চাই না'],
    passOn: ['on', 'enable', 'set', 'change', 'chalu', 'সেট', 'বদল', 'পরিবর্তন', 'চালু'],
    link: ['invite', 'invitation', 'link', 'links', 'lnk', 'url', 'share', 'join', 'আমন্ত্রণ', 'ইনভাইট', 'লিংক', 'লিঙ্ক', 'শেয়ার', 'যোগ'],
    linkVerb: ['deu', 'dao', 'den', 'din', 'de', 'dio', 'dite', 'chai', 'please', 'give', 'get', 'show', 'send', 'share', 'copy', 'fetch', 'pathao', 'pathan', 'pathiye', 'dekhaw', 'dekhao', 'daw', 'koro', 'kor', 'korun', 'koren', 'পাঠাও', 'দাও', 'দিন', 'কপি', 'শেয়ার', 'চাই', 'দেখাও', 'করো', 'কর'],
    call: ['call', 'calls', 'cal', 'caal', 'coll', 'kol', 'koll', 'audio', 'voice', 'video', 'phone', 'fon', 'dial', 'ring', 'কল', 'ফোন', 'ভিডিও', 'অডিও', 'ভয়েস', 'রিং', 'ডায়াল', 'kotha bol', 'কথা বল'],
    callVerb: ['deu', 'dao', 'den', 'din', 'dite', 'diyo', 'diben', 'koro', 'kor', 'korun', 'koren', 'start', 'chalu', 'chalao', 'chai', 'please', 'give', 'make', 'daw', 'bolo', 'bol', 'দাও', 'দিন', 'করো', 'কর', 'করুন', 'চালু', 'শুরু', 'দিতে', 'চাই', 'বলো', 'বল'],
    list: ['list', 'lists', 'lst', 'তালিকা', 'লিস্ট', 'dekhao', 'dekhaw', 'dekhan', 'দেখাও', 'দেখান'],
    lock: ['lock', 'lockk', 'lck', 'লক', 'তালা'],
    unlock: ['unlock', 'unlockk', 'open', 'খোল', 'আনলক']
  };

  const MEDIA_CONTEXT_RE = /(background|bg|watermark|logo|noise|photo|image|picture|ছবি|ইমেজ|লোগো|ব্যাকগ্রাউন্ড)/i;
  const CALL_TOPIC_RE = /(history|quality|log|logs|record|recording|setting|settings|option|button|feature|details|summary|about|status|problem|issue|support|help|price|cost|limit|center|office|interview|conference|contact|number|duty|game|gaming|movie|film|series|song|kemon|kivabe|kibhabe|how|what|why|when|where|which|who)/i;
  const ROOM_WORD_RE = /(\broom\b|\bchat\b|\bgroup\b|রুম|চ্যাট|গ্রুপ|ঘর)/i;
  const DELETE_WORD_RE = /(\bdelete\b|\bdeleted\b|\berase\b|\bdestroy\b|\bremove\b|muche|muchiye|sesh|nosto|biday|ডিলিট|মুছে|মুছিয়ে|শেষ|ধ্বংস|নষ্ট|বিদায়)/i;
  const MEMBER_WORD_RE = /(\bmember\b|\bmembers\b|\buser\b|\bperson\b|\bpeople\b|\bmanush\b|\blok\b|\bjon\b|সদস্য|মেম্বার|মেম্বর|ব্যক্তি|লোক|জন)/i;
  // Room links are shared only for a clear room/invite request. A generic
  // "send me the video link" must not leak the room invite URL.
  const LINK_EXPLICIT_RE = /(invite|invitation|join\s*link|room\s*link|share\s*link|room|group|chat|আমন্ত্রণ|ইনভাইট|রুম|গ্রুপ|চ্যাট)/i;
  const LINK_BARE_RE = /^(?:please\s+)?(?:share\s+)?(?:link|lnk|url)\s*(?:ta|ti)?\s*(?:diye\s+)?(?:deu|dao|den|din|de|dio|dite|pathao|pathan|pathiye|send|share|copy|show|give|dekhaw|dekhao|daw)\b/i;
  const LINK_OFFTOPIC_RE = /(video|youtube|website|webpage|article|post|photo|image|download|song|music|file|document|profile|comment|external|browser)/i;
  const LINK_DELETE_RE = /(remove|delete|deleted|bondho|off|বন্ধ|রিমুভ|ডিলিট)/i;

  // ── Theme (wallpaper) change ─────────────────────────────────────
  // Exact word matching on purpose: the typo-tolerant layer would let
  // "there" match "theme" (one edit apart).
  const THEME_WORD_RE = /(?:\bthemes?\b|\bwall\s*paper\b|\bwallpapers?\b|\bbackground\b|\bbg\b|\bskins?\b|থিম|ওয়াল\s*পেপার|ওয়ালপেপার|ব্যাকগ্রাউন্ড|পটভূমি|স্কিন)/i;
  const THEME_VERB_RE = /(?:\b(?:change|changed|changing|swap|set|update|apply|make|give|show|use|random|new|another|next)\b|\b(?:badal|badlo|badle|badali|baddal)\b|\b(?:koro|kor|kore|kora|kar|korte)\b|\b(?:deu|dao|den|din|dibo|dite|de)\b|বদলে|বদলাও|বদলানো|বদলাতে|পরিবর্তন|করো|কর|করে|করা|করতে|দাও|দিন|দিয়ে|সেট|একটা|একটি|অন্য)/i;
  // "theme 3", "theme number 3", "3rd theme", "theme no 3"
  const THEME_NUM_RE = /(?:\bthemes?\b|\bwall\s*paper\b|\bbackground\b|\bbg\b|\bskins?\b|থিম)[^0-9০-৯]{0,12}([0-9]{1,2})/i;
  const THEME_NUM_REV_RE = /\b([0-9]{1,2})(?:st|nd|rd|th)?\s*(?:number|no|num)?\s*(?:\bthemes?\b|\bwall\s*paper\b|\bbackground\b|\bskins?\b|থিম)/i;
  const THEME_WORD_NUMBERS = {
    '1': 1, 'one': 1, 'ek': 1, 'ekta': 1, 'ekti': 1, 'এক': 1, 'একটা': 1, 'একটি': 1, 'prothom': 1, 'প্রথম': 1,
    '2': 2, 'two': 2, 'dui': 2, 'duo': 2, 'দুই': 2, 'duito': 2, 'দ্বিতীয়': 2, 'dutiyo': 2,
    '3': 3, 'three': 3, 'tin': 3, 'tini': 3, 'তিন': 3, 'tinno': 3, 'তৃতীয়': 3, 'titiyo': 3,
    '4': 4, 'four': 4, 'char': 4, 'choy': 4, 'চার': 4, 'carto': 4, 'চতুর্থ': 4,
    '5': 5, 'five': 5, 'pach': 5, 'pachho': 5, 'পাঁচ': 5, 'pacho': 5, 'পঞ্চম': 5,
  };
  const BN_DIGITS = { '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4', '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9' };

  function _themeCount() {
    try {
      if (typeof RoomTheme !== 'undefined' && RoomTheme.count) return RoomTheme.count;
    } catch { /* fall through */ }
    return 5;
  }

  // Which theme did they ask for?
  // null  = no number mentioned ("pick one for me")
  // 1..N = the theme they want
  // out-of-range numbers are returned as-is so the bot can say "there are
  // only N themes" instead of silently picking a different one.
  function _extractThemeNumber(text) {
    let t = String(text == null ? '' : text).replace(/[০-৯]/g, d => (BN_DIGITS[d] || d));

    let m = t.match(THEME_NUM_RE) || t.match(THEME_NUM_REV_RE);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n)) return n;
    }

    // Written-out numbers: "theme three", "থিম তিন"
    const words = t.split(/\s+/);
    for (let i = 0; i < words.length; i++) {
      const w = String(words[i] || '').replace(/[^0-9a-zঀ-৿]/gi, '').toLowerCase();
      if (!w) continue;
      if (Object.prototype.hasOwnProperty.call(THEME_WORD_NUMBERS, w)) {
        // Only accept it when it is next to a theme word.
        const near = words.slice(Math.max(0, i - 3), i + 4).join(' ');
        if (THEME_WORD_RE.test(near)) return THEME_WORD_NUMBERS[w];
      }
    }
    return null;
  }

  // "which theme is this?", "কোন থিম?", "theme koto"
  // Deliberately tight: "what is a theme?" (a definition) must NOT be
  // treated as a question about the room's wallpaper.
  const THEME_QUERY_RE = /(?:\b(?:which|what|whats)\s+(?:current|now|active|room'?s?|room|chat)?\s*\bthemes?\b(?!\s+is\s+a\b)|\bcurrent\s+themes?\b|\bactive\s+themes?\b|\bthemes?\s+(?:koto|টা|টি|number|no)\b|কোন(?:টা|টি)?\s*থিম|থিম\s*(?:কত|কোনটা|কোনটি|নাম্বার)|(?:\broom\b|\bchat\b|রুম|চ্যাট)[^\n]{0,16}?\bthemes?\b|\bthemes?\b[^\n]{0,16}?(?:\broom\b|\bchat\b|রুম|চ্যাট))/i;

  // Does this message ask for a wallpaper change?
  function _themeIntent(text) {
    const t = String(text == null ? '' : text);
    if (!THEME_WORD_RE.test(t)) return false;
    // A real member whose name happens to be "theme" / "bg" wins — removing
    // that person must not be read as a wallpaper request.
    try { if (_mentionsExistingMember(t)) return false; } catch { /* ignore */ }
    // A theme word alone is not enough ("what is the theme of this app?"),
    // but a theme word with a number is.
    if (_extractThemeNumber(t) !== null) return true;
    if (THEME_VERB_RE.test(t)) return true;
    // "which theme is this?" → tell them, don't change anything.
    return THEME_QUERY_RE.test(t) ? 'query' : false;
  }

  function _norm(value) {
    return String(value == null ? '' : value)
      .toLowerCase()
      .normalize('NFC')
      .replace(/[।!?,.;:"'`~()[\]{}<>/\\|@#$%^&*+=_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function _tokens(text) {
    return String(text == null ? '' : text).trim().split(/\s+/).filter(Boolean);
  }

  // Small local Levenshtein helper for typo-tolerant intent words. Bengali
  // words are matched exactly; Latin/Banglish words get a tiny edit budget.
  function _editDistance(a, b) {
    a = String(a || '');
    b = String(b || '');
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    let prev = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[b.length];
  }

  function _adjacentSwap(a, b) {
    a = String(a || '');
    b = String(b || '');
    if (a.length !== b.length || a.length < 3) return false;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i < a.length - 1 &&
      a[i] === b[i + 1] &&
      a[i + 1] === b[i] &&
      a.slice(i + 2) === b.slice(i + 2);
  }

  function _fuzzyWord(text, word) {
    const t = String(text || '');
    const w = String(word || '');
    if (!w) return false;
    const toks = _tokens(t);
    if (/[^\x00-\x7F]/.test(w)) {
      return w.indexOf(' ') === -1 ? toks.includes(w) : t.includes(w);
    }
    if (w.length <= 4) return toks.includes(w);
    const max = w.length >= 8 ? 2 : 1;
    return toks.some(tok =>
      tok === w ||
      (tok.length >= 4 &&
        Math.abs(tok.length - w.length) <= max &&
        (_editDistance(tok, w) <= max || _adjacentSwap(tok, w)))
    );
  }

  function _fuzzyAny(text, words) {
    const t = String(text || '');
    return words.some(word => word.indexOf(' ') === -1 ? _fuzzyWord(t, word) : t.includes(word));
  }

  function _nameNorm(value) {
    return _norm(value).replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  function _langOf(text) {
    const raw = String(text || '');
    if (/[\u0980-\u09ff]/.test(raw)) return 'bn';
    // Only Banglish-specific markers, not shared English words like "call"
    // or "remove". This keeps English commands in English.
    if (/(\b(?:koro|kor|kore|korte|kro|krun|deu|dao|den|din|dite|chai|lagbe|bondho|bad|ber|ke|ko|re|ei|oi|tumi|apni|amar|apnar|hatao|hata)\b)/i.test(raw)) {
      return 'banglish';
    }
    return 'en';
  }

  function _pick(lang, bn, banglish, en) {
    if (lang === 'bn') return bn;
    if (lang === 'banglish') return banglish;
    return en;
  }

  function _looksLikeQuestion(text) {
    const t = String(text || '').trim();
    if (MEMBER_LIST_QUESTION_RE.test(t)) return false;
    if (REQUEST_START_RE.test(t) && !QUESTION_RE.test(t)) return false;
    return QUESTION_RE.test(t) || QUESTION_START_RE.test(t);
  }

  function _mentionsExistingMember(t) {
    try {
      const resolved = _resolveMember(t, {});
      return !!(resolved.member || (resolved.ambiguous && resolved.ambiguous.length));
    } catch { return false; }
  }

  function _hasMemberTargetMarker(t) {
    // "delete Rahim from the room" / "room theke Rahim ke delete" are
    // member actions, not whole-room deletion.
    if (/\b(?:from\s+(?:the|this|our|my|a)?\s*(?:room|chat|group)|(?:room|chat|group)\s+theke)\b|(?:রুম|চ্যাট|গ্রুপ)\s+থেকে/i.test(t)) {
      return true;
    }
    // A member target ("Rahim ke …", "রহিমকে …") means this is a kick.
    // "room ta ke delete" is still allowed because "ta" is a room modifier.
    const asciiObject = /(?:^|\s)([a-z0-9]+)\s+ke\b/i.exec(t);
    if (asciiObject && !/^(?:room|rooms|rom|rum|chat|chatt|group|gruop|ghor|ta|ti|eita|oita|ei|oi|this|the|my|our)$/i.test(asciiObject[1])) {
      return true;
    }
    const bnObject = /([\u0980-\u09ff]+)কে/.exec(t);
    if (bnObject && !/(?:রুম|চ্যাট|গ্রুপ|ঘর)/.test(bnObject[1])) return true;
    return false;
  }

  function _roomDeleteIntent(t) {
    if (MEDIA_CONTEXT_RE.test(t)) return false;
    if (!ROOM_WORD_RE.test(t) || !DELETE_WORD_RE.test(t)) return false;
    if (MEMBER_WORD_RE.test(t)) return false;
    if (_hasMemberTargetMarker(t)) return false;
    if (_mentionsExistingMember(t)) return false;
    if (/(password|passcode|pass\s*word|পাসওয়ার্ড|পাসওয়ার্ড|link|url|invite|invitation|লিংক|লিঙ্ক|আমন্ত্রণ|ইনভাইট)/i.test(t)) return false;
    return true;
  }

  function _indirectRemoveIntent(t) {
    if (MEDIA_CONTEXT_RE.test(t)) return false;
    const hasObject = /(?:\b(?:ke|re|tahake|take|tare|him|her|them)\b|member|user|person|people|manush|lok|jon|তাকে|একে|ওকে|সদস্য|মেম্বার|ব্যক্তি|লোক|জন|মানুষ|[\u0980-\u09ff]+কে)/i.test(t);
    if (!hasObject) return false;
    return /(?:rakhte|rakhbo|rakhben|rakha)\s+(?:chai\s*)?na\b|(?:pathiye|pathaben)\b|(?:bahar|ber|out)\s*(?:kore|koro|kor|koren|korun|dao|deu|dio|den|din|diben|de)\b|(?:sorate|sorao|sorabo|soriye|sorano|soran|soraben|soraye|sorai)\b|(?:dur\s*(?:koro|kore|kor|koren|dao|deu|den|din|diben|de))\b|(?:biday)\b|(?:rakha|rakhbo)\s+jabe\s+na\b|get\s+rid\s+of|kick\s+(?:him|her|them|out)|don'?t\s+want\s+(?:him|her|them)|রাখতে\s+চাই\s+না|রাখব\s+না|রাখবেন\s+না|পাঠিয়ে|বের\s+করে|বাহার\s+করে|সরিয়ে|সরান|সরাবেন|দূর|বিদায়|রাখা\s+যাবে\s+না/i.test(t);
  }

  function _detectFuzzy(t) {
    if (MEDIA_CONTEXT_RE.test(t)) return null;
    const hasPassword = _fuzzyAny(t, FUZZY.password);
    if (hasPassword && _fuzzyAny(t, FUZZY.passOff)) {
      return { type: 'password_off' };
    }
    if (hasPassword && _fuzzyAny(t, FUZZY.passOn)) {
      return { type: 'password_help' };
    }

    const hasRoom = _fuzzyAny(t, FUZZY.room);
    const hasMember = _fuzzyAny(t, FUZZY.member);
    const hasLink = _fuzzyAny(t, FUZZY.link);
    if (hasRoom && !hasMember && !hasLink && !_hasMemberTargetMarker(t) &&
        !_mentionsExistingMember(t) && _fuzzyAny(t, FUZZY.delete)) {
      return { type: 'room_delete' };
    }
    if (hasRoom && !_hasMemberTargetMarker(t) &&
        (/(?:ar\s+)?(?:dorkar|proyojon|lagbe)\s*(?:nei|nai|na)\b|দরকার\s*(?:নেই|না)|প্রয়োজন\s*(?:নেই|না)/i.test(t))) {
      return { type: 'room_delete' };
    }
    if (hasRoom && !hasMember && !hasLink && !_hasMemberTargetMarker(t) && !_mentionsExistingMember(t) &&
        (/(?:(?:bad|baad|uthaye|uthiye|soriye|soraye)\s+(?:diye|kore)\s+(?:dao|deu|den|din|dio|koro|kor|koren|diben|fel|felun)\b|(?:uthaye|soriye|soraye)\s+(?:dao|deu|den|din|dio|koro|kor|koren)\b|thakbe\s+na\b)/i.test(t))) {
      return { type: 'room_delete' };
    }

    const linkContext = LINK_EXPLICIT_RE.test(t) || LINK_BARE_RE.test(t);
    if (hasLink && linkContext && !LINK_OFFTOPIC_RE.test(t) && !LINK_DELETE_RE.test(t) &&
        _fuzzyAny(t, FUZZY.linkVerb)) {
      return { type: 'invite_link' };
    }

    const strongRemove = _fuzzyAny(t, [
      'remove', 'removed', 'removing', 'delete', 'deleted', 'erase', 'kick',
      'kik', 'hatao', 'hata', 'ber', 'sor', 'sorao', 'sorate', 'soran', 'soraben', 'soraye', 'sorai',
      'dur koro', 'dur kore', 'biday', 'pathiye', 'get rid of', 'kick out', 'thakbe na',
      'রিমুভ', 'রিমোভ', 'কিক', 'বাদ', 'বের', 'সরাও', 'সরিয়ে', 'সরান', 'সরাবেন', 'দূর', 'বিদায়', 'পাঠিয়ে', 'থাকবে না',
      'ডিলিট', 'মুছে', 'শেষ', 'ধ্বংস', 'নষ্ট'
    ]);
    const badRemove = /\bbad\s*(?:kore|diye|karo)?\s*(?:dao|deu|den|din|dio|koro|kor|koren)\b/i.test(t);
    if ((strongRemove || badRemove || _indirectRemoveIntent(t)) && !hasLink && !hasPassword) {
      return { type: 'remove_member' };
    }

    const hasCall = _fuzzyAny(t, FUZZY.call);
    const callObject = /(?:\b(?:ke|re|tahake|take|tare)\b|তাকে|একে|ওকে)/i.test(t);
    const callBare = !CALL_TOPIC_RE.test(t) &&
      /(?:^|\s)(?:call|cal|caal|coll|kol|koll)\s+\S+/i.test(t);
    if (hasCall && !hasLink && (_fuzzyAny(t, FUZZY.callVerb) || callBare || callObject)) {
      return { type: 'call', callType: /(video|ভিডিও)/i.test(t) ? 'video' : 'audio' };
    }

    if (_fuzzyAny(t, FUZZY.unlock) && hasRoom) return { type: 'room_unlock' };
    if (_fuzzyAny(t, FUZZY.lock) && hasRoom && !hasPassword) return { type: 'room_lock' };
    if (hasMember && _fuzzyAny(t, FUZZY.list)) return { type: 'member_list' };
    return null;
  }

  function detect(text) {
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    const t = _norm(raw);
    if (!t) return null;

    // Image requests must never be parsed as room commands. For example,
    // "draw a room delete button" contains both "room" and "delete".
    try {
      if (typeof Shepu !== 'undefined' && typeof Shepu.isImageRequest === 'function' && Shepu.isImageRequest(raw)) {
        return null;
      }
    } catch { /* fall through to the local guard */ }
    if (/(ছবি|ইমেজ|image|picture|photo|pic|chobi|draw|paint|sketch)/i.test(t) &&
        /(বানাও|আঁক|তৈরি|দাও|দেখাও|banao|banau|toiri|draw|paint|create|generate|make|show|chobi|image|picture|photo)/i.test(t)) {
      return null;
    }

    const lang = _langOf(raw);
    const action = (type, extra) => Object.assign({ type, lang, raw, text: t }, extra || {});

    // 0. Theme / wallpaper.
    //
    // Checked BEFORE the question guard: "which theme is this?" is a
    // question, but it is a question about THIS room — and the AI engine
    // has no idea which wallpaper the room is using. It is also checked
    // before the room actions so a theme request is never read as a
    // member removal, and after the image guard so "draw a background"
    // stays a picture request.
    const themeIntent = _themeIntent(raw);
    if (themeIntent) {
      if (themeIntent === 'query') return action('theme_info');
      return action('theme_change', { themeNumber: _extractThemeNumber(raw) });
    }

    if (_looksLikeQuestion(t)) return null;
    if (NEGATED_ACTION_RE.test(t)) return null;

    // 1. Password OFF / remove. This must run before the generic remove
    // parser so "password remove koro" never tries to kick a member.
    const hasPassword = /(password|passcode|pass\s*word|পাসওয়ার্ড|পাসওয়ার্ড|পাস\s*ওয়ার্ড)/i.test(t);
    const passwordOff = /(?:\b(?:off|remove(?:d)?|delete(?:d)?|disable(?:d)?|stop(?:ped)?|bondho|bondhu|bond|band|bad|ber|chara|chhara|nai|nei)\b|\bturn\s+off\b|\blagbe\s+(?:na|nai|nei)\b|\bchai\s+(?:na|nei)\b|বন্ধ|খুলে|সরিয়ে|রিমুভ|নিষ্ক্রিয়|ছাড়া|ছাড়া|লাগবে\s*না|লাগেনা|চাই\s*না)/i.test(t);
    if (hasPassword && passwordOff) {
      return action('password_off');
    }

    // 2. Password ON / change → explain the secure settings flow. Never ask
    // the user to type a room password into chat.
    if (hasPassword && /(on|enable|set|change|chalu|চালু|সেট|বদল|পরিবর্তন)/i.test(t)) {
      return action('password_help');
    }

    // 3. Delete the whole room. Check this before member removal so
    // "remove this room" cannot be mistaken for a kick command.
    const mediaContext = MEDIA_CONTEXT_RE.test(t);
    if (!mediaContext && _roomDeleteIntent(t)) {
      return action('room_delete');
    }

    // 4. Invite / room link.
    const hasLink = /(invite|invitation|join\s*link|room\s*link|share\s*link|link|url|আমন্ত্রণ|ইনভাইট|লিংক|লিঙ্ক)/i.test(t);
    const linkIntent = /(?:\b(?:deu|dao|den|din|de|dio|dite|chai|please|give|get|show|send|share|copy|fetch|pathao|pathan|pathiye|dekhaw|dekhao|daw)\b|পাঠাও|দাও|দিন|কপি|শেয়ার|চাই|দেখাও)/i.test(t);
    const linkBare = /^(?:please\s+)?(?:invite|room|join)\s+(?:link|url)$/i.test(t) || LINK_BARE_RE.test(t);
    const linkContext = LINK_EXPLICIT_RE.test(t) || LINK_BARE_RE.test(t);
    if (hasLink && (linkIntent || linkBare) && linkContext && !LINK_OFFTOPIC_RE.test(t)) {
      // "link remove koro" is not a link request.
      if (!/(remove|delete|bondho|off|বন্ধ|রিমুভ)/i.test(t) || /(invite|invitation|join\s*link|room\s*link)/i.test(t)) {
        return action('invite_link');
      }
    }

    // 5. Remove / kick a member. Check before call so "remove from call"
    // cannot accidentally start a new call.
    const hasRemove = /(remove|kick|hatao|hata\s*do|bad\s*(?:dao|deu|den|din|koro|kor)|ber\s*kore|বাদ\s*(?:দাও|দিন|কর)|রিমুভ|কিক|বের\s*কর|সরিয়ে\s*দাও|সরাও)/i.test(t);
    if (hasRemove && !mediaContext && !/(password|link|invite|পাসওয়ার্ড|পাসওয়ার্ড|লিংক|লিঙ্ক)/i.test(t)) {
      return action('remove_member');
    }

    // 6. Start an audio/video call.
    const hasCall = /(\bcall\b|\bkol\b|audio|voice|video|ফোন|কল|অডিও|ভয়েস|ভিডিও|কথা\s*বল)/i.test(t);
    const callIntent = /(deu|dao|den|din|dite|diyo|diben|koro|kor|korun|koren|start|chalu|chalao|chai|please|give|make|দাও|দিন|করো|কর|করুন|চালু|শুরু|দিতে|চাই)/i.test(t);
    const callBare = !CALL_TOPIC_RE.test(t) && (
      /^(?:please\s+)?(?:audio\s+|voice\s+|video\s+)?(?:call|kol)\s+\S+/i.test(t) ||
      /^(?:audio|voice|video)\s+(?:call|kol)$/i.test(t)
    );
    if (hasCall && !hasLink && (callIntent || callBare)) {
      const callType = /(video|ভিডিও)/i.test(t) ? 'video' : 'audio';
      return action('call', { callType });
    }

    // 7. Room lock / unlock.
    const hasLock = /(\block\b|\bunlock\b|লক|আনলক)/i.test(t);
    if (hasLock && !hasPassword && /(room|chat|group|রুম|চ্যাট|গ্রুপ|koro|kor|deu|dao|করো|কর|দাও|দিন)/i.test(t)) {
      return action(/unlock|আনলক/i.test(t) ? 'room_unlock' : 'room_lock');
    }

    // 8. Read-only member list.
    if (/(?:kar\s+kar\s+ache|koto\s+jon\s+ache|kon\s+kon\s+member|সদস্য\s+কারা|কে\s*কারা|কারা\s+আছে|কতজন)/i.test(t)) {
      return action('member_list');
    }
    if (/(?:who\s+are\s+(?:here|online)|who'?s\s+(?:here|online))/i.test(t)) {
      return action('member_list');
    }
    if (/(?:member|members|সদস্য|মেম্বার|মেম্বর).{0,20}(?:nam|name)\s*(?:bolo|dao|deu|den|din|de)/i.test(t)) {
      return action('member_list');
    }
    if (/(member|members|সদস্য|মেম্বার).{0,30}(list|list\s*(?:dao|deu|din)|dekhao|dekhan|তালিকা|লিস্ট|দেখাও|দেখান)|(?:who\s+is\s+(?:here|online)|ke\s+ke\s+ache|কে\s+কে\s+আছে)/i.test(t)) {
      return action('member_list');
    }

    // 9. Local typo-tolerant fallback for the same room actions.
    const fuzzy = _detectFuzzy(t);
    if (fuzzy) {
      return action(fuzzy.type, fuzzy.callType ? { callType: fuzzy.callType } : {});
    }
    return null;
  }

  function _extractTargetText(raw) {
    const tokens = _norm(raw).split(/\s+/).filter(Boolean);
    const kept = tokens.filter(tok => !STOP_WORDS.has(tok));
    return kept.join(' ').trim();
  }

  function _members() {
    try {
      if (typeof Chat !== 'undefined' && typeof Chat.getMembers === 'function') {
        const list = Chat.getMembers();
        return Array.isArray(list) ? list : [];
      }
    } catch { /* non-fatal */ }
    return [];
  }

  function _resolveMember(text, session) {
    const q = _nameNorm(text);
    if (!q) return { member: null, ambiguous: [] };
    const qTokens = q.split(/\s+/).filter(Boolean);
    const scored = [];
    for (const m of _members()) {
      if (!m || !m.memberId) continue;
      const name = _nameNorm(m.displayName);
      // 2-character names match far too much ("ali" inside "finally").
      if (!name || name.length < 3) continue;
      if (m.memberId === BOT_ID) continue;
      const tokens = name.split(/\s+/).filter(Boolean);
      // Word-boundary match — a plain substring test matched "Ali" inside
      // "finalize the plan" and removed the WRONG member.
      const hasToken = (t) => qTokens.includes(t);
      let score = 0;
      if (hasToken(name)) score = 4;
      else if (tokens.length > 1 && tokens.every(tok => tok.length >= 3 && hasToken(tok))) score = 3;
      else if (tokens[0] && tokens[0].length >= 3 && hasToken(tokens[0])) score = 2;
      else if (name.length >= 4 && tokens.length === 1) {
        // A single-word name may still be written inside a longer phrase
        // ("remove Rahim please") — accept it only as a whole word.
        const re = new RegExp('(?:^|\\s)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)');
        if (re.test(q)) score = 2;
      }
      if (score > 0) scored.push({ member: m, score });
    }
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) return { member: null, ambiguous: [] };
    const top = scored[0].score;
    const best = scored.filter(item => item.score === top);
    if (best.length > 1) {
      return { member: null, ambiguous: best.map(item => item.member) };
    }
    return { member: best[0].member, ambiguous: [] };
  }

  function _memberLabel(m) {
    return (m && (m.displayName || m.name)) || 'member';
  }

  // Bengali object case is a suffix ("রহিমকে"), while Banglish uses "-ke".
  function _objectLabel(name, lang) {
    const safe = String(name || 'member');
    if (lang === 'bn') return safe + 'কে';
    if (lang === 'banglish') return safe + '-ke';
    return safe;
  }

  function _memberListText(lang) {
    const list = _members();
    if (!list.length) {
      return _pick(lang,
        'এই মুহূর্তে room member list পাওয়া যাচ্ছে না।',
        'Ekhon room member list pawa jacche na.',
        'I could not read the room member list right now.');
    }
    const sorted = list.filter(m => m && m.memberId !== BOT_ID).sort((a, b) => {
      if (!!a.online !== !!b.online) return a.online ? -1 : 1;
      if ((a.role === 'owner') !== (b.role === 'owner')) return a.role === 'owner' ? -1 : 1;
      return String(a.displayName || '').localeCompare(String(b.displayName || ''));
    });
    const lines = sorted.slice(0, 40).map(m => {
      const state = m.online ? '🟢' : '⚪';
      const role = m.role === 'owner' ? ' (owner)' : '';
      return `${state} ${_memberLabel(m)}${role}`;
    });
    return _pick(lang,
      `Room members (${sorted.length}):\n${lines.join('\n')}`,
      `Room members (${sorted.length}):\n${lines.join('\n')}`,
      `Room members (${sorted.length}):\n${lines.join('\n')}`);
  }

  async function _confirm(opts) {
    if (typeof UI !== 'undefined' && typeof UI.confirmDialog === 'function') {
      try { return !!(await UI.confirmDialog(opts)); } catch { /* fall through */ }
    }
    try {
      return !!window.confirm(opts.message || opts.title || 'Continue?');
    } catch { return false; }
  }

  function _cancelText(lang) {
    return _pick(lang,
      'ঠিক আছে, বাতিল করেছি।',
      'Thik ache, cancel korechi.',
      'Okay, cancelled.');
  }

  function _notFoundText(lang, targetText) {
    const who = targetText ? `“${targetText}”` : '';
    return _pick(lang,
      `${who} নামের কোনো member পাইনি। সদস্যের পুরো নাম লিখুন।`,
      `${who} name-e kono member paini. Member-er puro nam likhun.`,
      `I could not find a member named ${who || 'that'}. Please give the full display name.`);
  }

  function _ambiguousText(lang, list) {
    const names = list.map(_memberLabel).join(', ');
    return _pick(lang,
      `একাধিক member মিলেছে: ${names}। পুরো নাম লিখুন।`,
      `Ekadhik member mileche: ${names}. Puro nam likhun.`,
      `More than one member matched: ${names}. Please give the full name.`);
  }

  function _selfText(lang) {
    return _pick(lang,
      'নিজের ওপর এই কাজটি করা যাবে না।',
      'Nijer upor ei kaj ta kora jabe na.',
      'I cannot do that to your own account.');
  }

  function _ownerOnlyText(lang, kind) {
    const labels = {
      remove: {
        bn: 'সদস্য remove',
        banglish: 'member remove',
        en: 'remove members',
      },
      delete: {
        bn: 'room delete',
        banglish: 'room delete',
        en: 'delete the room',
      },
      password: {
        bn: 'password বন্ধ',
        banglish: 'password bondho',
        en: 'turn off the password',
      },
      lock: {
        bn: 'room lock',
        banglish: 'room lock',
        en: 'lock the room',
      },
      unlock: {
        bn: 'room unlock',
        banglish: 'room unlock',
        en: 'unlock the room',
      },
    };
    const label = (labels[kind] && labels[kind][lang]) || kind;
    return _pick(lang,
      `শুধু room owner ${label} করতে পারেন।`,
      `Shudhu room owner ${label} korte paren.`,
      `Only the room owner can ${label}.`);
  }

  async function _runCall(action) {
    const lang = action.lang;
    const room = action._room || {};
    const session = action._session || {};
    const type = action.callType === 'video' ? 'video' : 'audio';
    const kind = type === 'video' ? 'Video call' : 'Audio call';
    const t = action.text || '';

    let target = null;
    const wantsRoom = /\b(?:room|everyone|all|sobai|sabai)\b|(?:পুরো|সবাই|সবার)/i.test(t);
    const wantsSelf = /\b(?:me|myself|amake|amar|nijer|nije)\b|(?:আমাকে|আমার|নিজে|নিজের)/i.test(t);
    const targetText = _extractTargetText(action.raw);
    const resolved = _resolveMember(action.raw, session);

    if (resolved.ambiguous.length) return { text: _ambiguousText(lang, resolved.ambiguous) };
    if (!wantsRoom) {
      if (resolved.member) target = resolved.member;
      else if (wantsSelf) return { text: _selfText(lang) };
      else if (targetText) return { text: _notFoundText(lang, targetText) };
    }

    if (target && target.memberId === session.memberId) return { text: _selfText(lang) };
    if (target && target.memberId === BOT_ID) {
      return { text: _pick(lang, 'বটকে call দেওয়া যাবে না।', 'Bot-ke call dewa jabe na.', 'I cannot call the bot.') };
    }

    const who = target ? _memberLabel(target) : null;
    const targetObj = target ? _objectLabel(who, lang) : '';

    if (typeof CallManager === 'undefined' || typeof CallManager.startCall !== 'function') {
      return { text: _pick(lang, 'Call service পাওয়া যাচ্ছে না।', 'Call service pawa jacche na.', 'The call service is not available.') };
    }

    try {
      const pending = target
        ? CallManager.startCall(type, target.memberId, who)
        : CallManager.startCall(type);
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch (e) {
      return { text: _pick(lang, 'Call শুরু করা যায়নি।', 'Call start kora jayni.', 'I could not start the call.') };
    }

    return {
      text: _pick(lang,
        `📞 ${kind} শুরু করা হচ্ছে${who ? ' — ' + targetObj : ''}।`,
        `📞 ${kind} start kora hocche${who ? ' — ' + targetObj : ''}.`,
        `📞 Starting ${kind.toLowerCase()}${who ? ' with ' + who : ''}.`)
    };
  }

  async function _runRemove(action) {
    const lang = action.lang;
    const room = action._room || {};
    const session = action._session || {};
    if (!session || session.role !== 'owner') {
      return { text: _ownerOnlyText(lang, 'remove') };
    }
    const targetText = _extractTargetText(action.raw);
    const resolved = _resolveMember(action.raw, session);
    if (resolved.ambiguous.length) return { text: _ambiguousText(lang, resolved.ambiguous) };
    const target = resolved.member;
    if (!target) {
      return {
        text: _pick(lang,
          targetText
            ? `${_notFoundText(lang, targetText)}\n\n${_memberListText(lang)}`
            : `কাকে remove করব? সদস্যের নাম লিখুন।\n\n${_memberListText(lang)}`,
          targetText
            ? `${_notFoundText(lang, targetText)}\n\n${_memberListText(lang)}`
            : `Kake remove korbo? Member-er nam likhun.\n\n${_memberListText(lang)}`,
          targetText
            ? `${_notFoundText(lang, targetText)}\n\n${_memberListText(lang)}`
            : `Who should I remove? Please give the member name.\n\n${_memberListText(lang)}`)
      };
    }
    if (target.memberId === session.memberId) return { text: _selfText(lang) };
    if (target.memberId === BOT_ID) {
      return { text: _pick(lang, 'বটকে remove করা যাবে না।', 'Bot-ke remove kora jabe na.', 'I cannot remove the bot.') };
    }
    if (target.role === 'owner') {
      return { text: _pick(lang, 'Room owner-কে remove করা যাবে না।', 'Room owner-ke remove kora jabe na.', 'The room owner cannot be removed.') };
    }

    const who = _memberLabel(target);
    const targetObj = _objectLabel(who, lang);
    if (!(await _confirm({
      title: _pick(lang, `${targetObj} remove করব?`, `${targetObj} remove korbo?`, `Remove ${who}?`),
      message: _pick(lang,
        `${targetObj} এই room থেকে বের করে দেওয়া হবে।`,
        `${targetObj} ei room theke ber kore dewa hobe.`,
        `${who} will be removed from this room.`),
      confirmText: _pick(lang, 'হ্যাঁ, remove করো', 'Hyan, remove koro', 'Remove'),
      cancelText: _pick(lang, 'বাতিল', 'Cancel', 'Cancel'),
      danger: true,
    }))) return { text: _cancelText(lang) };

    if (typeof RoomAPI === 'undefined' || typeof RoomAPI.roomOp !== 'function' || !room.deploymentUrl) {
      return { text: _pick(lang, 'Remove service পাওয়া যাচ্ছে না।', 'Remove service pawa jacche na.', 'The remove service is not available.') };
    }
    try {
      const res = await RoomAPI.roomOp(room.deploymentUrl, {
        memberId: session.memberId,
        sessionToken: session.sessionToken,
        op: 'remove_member',
        targetId: target.memberId,
      });
      if (!res || !res.success) throw new Error((res && res.error) || 'failed');
      if (typeof Chat !== 'undefined' && typeof Chat.dropMember === 'function') {
        try { Chat.dropMember(target.memberId); } catch { /* non-fatal */ }
      }
      return { text: _pick(lang,
        `✅ ${targetObj} room থেকে remove করা হয়েছে।`,
        `✅ ${targetObj} room theke remove kora hoyeche.`,
        `✅ ${who} has been removed from the room.`) };
    } catch (e) {
      return { text: _pick(lang,
        'Member remove করা যায়নি। অনুমতি বা সংযোগটি আবার দেখুন।',
        'Member remove kora jayni. Permission ba connection ta abar dekho.',
        'I could not remove that member. Please check your permission or connection.') };
    }
  }

  async function _runInvite(action) {
    const lang = action.lang;
    const room = action._room || {};
    let url = '';
    try {
      if (typeof Rooms !== 'undefined' && typeof Rooms.getRoomUrl === 'function' && room.id) {
        url = Rooms.getRoomUrl(room.id, room.deploymentUrl) || '';
      }
    } catch { /* handled below */ }
    if (!url) {
      return { text: _pick(lang, 'Invite link তৈরি করা যায়নি।', 'Invite link create kora jayni.', 'I could not build the invite link.') };
    }

    let copied = false;
    try {
      if (typeof UI !== 'undefined' && typeof UI.copyText === 'function') {
        // UI.copyText() RETURNS false when both the async clipboard and the
        // execCommand fallback fail — it does not throw. Ignoring the return
        // value made the bot claim "(copied)" while the clipboard was empty.
        copied = !!(await UI.copyText(url));
      }
    } catch { copied = false; }
    const note = room.passwordLocked
      ? _pick(lang, '\n\nRoom-টি password-protected; link খুলে password দিতে হবে।', '\n\nRoom ti password-protected; link khule password dite hobe.', '\n\nThis room is password-protected; the password is still required.')
      : '';
    return {
      text: _pick(lang,
        `🔗 Invite link${copied ? ' (কপি হয়েছে)' : ''}:\n${url}${note}`,
        `🔗 Invite link${copied ? ' (copy hoyeche)' : ''}:\n${url}${note}`,
        `🔗 Invite link${copied ? ' (copied)' : ''}:\n${url}${note}`)
    };
  }

  async function _runPasswordOff(action) {
    const lang = action.lang;
    const room = action._room || {};
    const session = action._session || {};
    if (!session || session.role !== 'owner') {
      return { text: _ownerOnlyText(lang, 'password') };
    }
    if (!room.passwordLocked) {
      return { text: _pick(lang, 'এই room-এ এখন password চালু নেই।', 'Ei room-e ekhon password chalu nei.', 'This room does not have a password enabled.') };
    }
    if (typeof RoomAPI === 'undefined' || typeof RoomAPI.roomOp !== 'function' || !room.deploymentUrl) {
      return { text: _pick(lang, 'Password service পাওয়া যাচ্ছে না।', 'Password service pawa jacche na.', 'The password service is not available.') };
    }
    try {
      const res = await RoomAPI.roomOp(room.deploymentUrl, {
        memberId: session.memberId,
        sessionToken: session.sessionToken,
        op: 'remove_password',
      });
      if (!res || !res.success) throw new Error('failed');
      room.passwordLocked = false;
      try { if (typeof Rooms !== 'undefined' && Rooms.updateRoom) Rooms.updateRoom(room.id, { passwordLocked: false }); } catch { /* non-fatal */ }
      try { if (typeof RoomPassword !== 'undefined' && RoomPassword.clearStored) RoomPassword.clearStored(room.id); } catch { /* non-fatal */ }
      try { if (typeof Encryption !== 'undefined' && Encryption.clearKey) Encryption.clearKey(); } catch { /* non-fatal */ }
      return {
        text: _pick(lang,
          '✅ Room password বন্ধ করা হয়েছে। নিরাপত্তার জন্য page reload হচ্ছে…',
          '✅ Room password bondho kora hoyeche. Security-er jonno page reload hocche…',
          '✅ The room password is off. Reloading the page for security…'),
        reload: true,
      };
    } catch (e) {
      return { text: _pick(lang,
        'Password বন্ধ করা যায়নি। Owner permission বা connection দেখুন।',
        'Password bondho kora jayni. Owner permission ba connection dekho.',
        'I could not turn off the password. Check owner permission or connection.') };
    }
  }

  async function _runLock(action, lock) {
    const lang = action.lang;
    const room = action._room || {};
    const session = action._session || {};
    if (!session || session.role !== 'owner') {
      return { text: _ownerOnlyText(lang, lock ? 'lock' : 'unlock') };
    }
    const already = lock ? room.status === 'locked' : room.status !== 'locked';
    if (already) {
      return { text: lock
        ? _pick(lang, 'Room আগে থেকেই locked আছে।', 'Room age thekei locked ache.', 'The room is already locked.')
        : _pick(lang, 'Room আগে থেকেই unlocked আছে।', 'Room age thekei unlocked ache.', 'The room is already unlocked.') };
    }
    if (typeof RoomAPI === 'undefined' || typeof RoomAPI.roomOp !== 'function' || !room.deploymentUrl) {
      return { text: _pick(lang, 'Room service পাওয়া যাচ্ছে না।', 'Room service pawa jacche na.', 'The room service is not available.') };
    }
    try {
      const res = await RoomAPI.roomOp(room.deploymentUrl, {
        memberId: session.memberId,
        sessionToken: session.sessionToken,
        op: lock ? 'lock' : 'unlock',
      });
      if (!res || !res.success) throw new Error('failed');
      room.status = lock ? 'locked' : 'active';
      try {
        if (typeof Rooms !== 'undefined' && typeof Rooms.updateRoom === 'function' && room.id) {
          Rooms.updateRoom(room.id, { status: room.status });
        }
      } catch { /* non-fatal */ }
      return { text: lock
        ? _pick(lang, '🔒 Room lock করা হয়েছে।', '🔒 Room lock kora hoyeche.', '🔒 The room is now locked.')
        : _pick(lang, '🔓 Room unlock করা হয়েছে।', '🔓 Room unlock kora hoyeche.', '🔓 The room is now unlocked.') };
    } catch (e) {
      return { text: _pick(lang,
        lock ? 'Room lock করা যায়নি।' : 'Room unlock করা যায়নি।',
        lock ? 'Room lock kora jayni.' : 'Room unlock kora jayni.',
        lock ? 'I could not lock the room.' : 'I could not unlock the room.') };
    }
  }

  async function _runDelete(action) {
    const lang = action.lang;
    const room = action._room || {};
    const session = action._session || {};
    if (!session || session.role !== 'owner') {
      return { text: _ownerOnlyText(lang, 'delete') };
    }
    if (room.status === 'deleted') {
      return { text: _pick(lang, 'Room টি আগেই delete করা হয়েছে।', 'Room ti agei delete kora hoyeche.', 'This room has already been deleted.') };
    }
    const name = room.name || 'this room';
    if (!(await _confirm({
      title: _pick(lang, 'Room delete করব?', 'Room delete korbo?', 'Delete this room?'),
      message: _pick(lang,
        `“${name}” permanently delete হয়ে যাবে। এই কাজটি ফিরিয়ে আনা যাবে না।`,
        `“${name}” permanently delete hoye jabe. Ei kaj ti fireye ana jabe na.`,
        `“${name}” will be permanently deleted. This cannot be undone.`),
      confirmText: _pick(lang, 'হ্যাঁ, delete করো', 'Hyan, delete koro', 'Delete room'),
      cancelText: _pick(lang, 'বাতিল', 'Cancel', 'Cancel'),
      danger: true,
    }))) return { text: _cancelText(lang) };

    if (typeof RoomAPI === 'undefined' || typeof RoomAPI.roomOp !== 'function' || !room.deploymentUrl) {
      return { text: _pick(lang, 'Room service পাওয়া যাচ্ছে না।', 'Room service pawa jacche na.', 'The room service is not available.') };
    }
    try {
      const res = await RoomAPI.roomOp(room.deploymentUrl, {
        memberId: session.memberId,
        sessionToken: session.sessionToken,
        op: 'delete',
      });
      if (!res || !res.success) throw new Error((res && res.error) || 'failed');
      return {
        text: _pick(lang,
          '✅ Room delete করা হয়েছে। Dashboard-এ নিয়ে যাচ্ছি…',
          '✅ Room delete kora hoyeche. Dashboard-e niye jacchi…',
          '✅ The room has been deleted. Taking you to the dashboard…'),
        redirect: 'index.html',
        cleanupRoom: room.id || '',
        clearSession: true,
      };
    } catch (e) {
      return { text: _pick(lang,
        'Room delete করা যায়নি। Owner permission বা connection দেখুন।',
        'Room delete kora jayni. Owner permission ba connection dekho.',
        'I could not delete the room. Check owner permission or connection.') };
    }
  }

  // ── Theme (wallpaper) change ────────────────────────────────────
  // Anyone can change the wallpaper through the header picker, so the bot
  // may do it too. Chat.setTheme() applies it locally, persists it and
  // relays it to the rest of the room.
  async function _runTheme(action) {
    const lang = action.lang;
    const count = _themeCount();

    const asked = parseInt(action.themeNumber, 10);
    if (Number.isFinite(asked) && asked !== null && (asked < 1 || asked > count)) {
      // They asked for a theme that does not exist — say so instead of
      // silently applying a different one.
      return { text: _pick(lang,
        `এই room-এ মাত্র ${count}টা থিম আছে (১-${count})।`,
        `Ei room-e matro ${count}ta theme ache (1-${count}).`,
        `This room has ${count} themes (1-${count}).`) };
    }

    let n = asked;
    if (!Number.isFinite(n) || n < 1 || n > count) {
      // No number given → pick one for them.
      try {
        n = (typeof RoomTheme !== 'undefined' && typeof RoomTheme.pick === 'function')
          ? RoomTheme.pick()
          : 1;
      } catch { n = 1; }
    }
    n = Math.max(1, Math.min(count, n || 1));

    if (typeof Chat === 'undefined' || typeof Chat.setTheme !== 'function') {
      return { text: _pick(lang,
        'এখন থিম বদলাতে পারছি না।',
        'Ekhon theme bodlate parchi na.',
        'I cannot change the theme right now.') };
    }
    try {
      await Chat.setTheme(n);
    } catch (e) {
      try { console.warn('[ShepuActions] theme change failed:', e); } catch {}
      return { text: _pick(lang,
        'থিম বদলানো গেল না।',
        'Theme bodlano gel na.',
        'The theme could not be changed.') };
    }
    return { text: _pick(lang,
      `🎨 থিম ${n} করে দিয়েছি।`,
      `🎨 Theme ${n} kore diyechi.`,
      `🎨 Theme ${n} applied.`) };
  }

  // ── Which theme are we using right now? ────────────────────────
  async function _runThemeInfo(action) {
    const lang = action.lang;
    const room = action._room || {};
    const count = _themeCount();
    let cur = parseInt(room.theme, 10);
    if (!Number.isFinite(cur) || cur < 1 || cur > count) {
      try {
        const s = (typeof Storage !== 'undefined' && Storage.getSession) ? Storage.getSession() : null;
        cur = parseInt(s && s.theme, 10);
      } catch { /* ignore */ }
    }
    if (!Number.isFinite(cur) || cur < 1 || cur > count) cur = 1;
    return { text: _pick(lang,
      `🎨 এখন থিম ${cur} চালু আছে। মোট ${count}টা থিম আছে।`,
      `🎨 Ekhon theme ${cur} chalu ache. Moto ${count}ta theme ache.`,
      `🎨 Theme ${cur} is active. There are ${count} themes in total.`) };
  }

  async function run(action, ctx) {
    if (!action || typeof action !== 'object') return null;
    const context = Object.assign({}, action, ctx || {});
    context._room = (ctx && ctx.room) || {};
    context._session = (ctx && ctx.session) || {};

    switch (action.type) {
      case 'call':            return _runCall(context);
      case 'remove_member':   return _runRemove(context);
      case 'room_delete':     return _runDelete(context);
      case 'invite_link':     return _runInvite(context);
      case 'theme_change':    return _runTheme(context);
      case 'theme_info':      return _runThemeInfo(context);
      case 'password_off':    return _runPasswordOff(context);
      case 'password_help':   return { text: _pick(action.lang,
        'Password চালু বা বদলাতে Settings → Room Password ব্যবহার করুন। নিরাপত্তার জন্য chat-এ password লিখবেন না।',
        'Password chalu ba bodlate Settings → Room Password use korun. Security-er jonno chat-e password likhben na.',
        'Use Settings → Room Password to enable or change the password. For safety, never type a room password into chat.') };
      case 'room_lock':       return _runLock(context, true);
      case 'room_unlock':     return _runLock(context, false);
      case 'member_list':     return { text: _memberListText(action.lang) };
      default:                return null;
    }
  }

  // Exposed for tests/debugging without executing anything.
  function parse(text) {
    return detect(text);
  }

  return { detect, parse, run };
})();

if (typeof window !== 'undefined') window.ShepuActions = ShepuActions;
else if (typeof globalThis !== 'undefined') globalThis.ShepuActions = ShepuActions;
