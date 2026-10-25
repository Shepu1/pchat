/**
 * SHEPU ROOMS — shepu-bot.js
 * ------------------------------------------------------------------
 * In-chat Shepu-AI bot (4.1 Ultra engine from ai/shepu.js).
 *
 * Features:
 *   1. Mention detection — when a message contains "@shepu-ai" followed by a
 *      question, the bot answers using Shepu.findAnswer(). The reply is sent
 *      as a normal chat message so EVERYONE in the room sees it (works for
 *      both Apps Script rooms and P2P instant rooms).
 *   2. Autocomplete — while typing "@" or "@sh…" the full name "@shepu-ai"
 *      appears as a suggestion popup above the input box.
 *   3. Image requests — "ছবি বানাও ..." / "draw ..." produce a keyless
 *      Shepu-AI image and are sent as an image message. Vague requests first
 *      get a short "what should I draw?" clarification.
 *   4. Official portrait — "তোমার ছবি" / "Shepu er chobi" uses the bundled
 *      ai/shepu-official.png instead of a third-party image call.
 *   5. Room commands — call / member remove / invite link / password / lock /
 *      room delete are recognized in Bengali, Banglish and English. Member
 *      removal and room deletion ask for a danger confirmation; the other
 *      commands run directly (with server-side owner checks).
 *
 * 4.1 Ultra never calls the Gemini API and never writes AI training/learning
 * data to Google Sheets. The bot's chat reply still uses the room's normal
 * message transport so it appears in room history like every other message
 * (that is ordinary Pchat chat persistence, not an AI/Sheets sync).
 */

const ShepuBot = (() => {
  const BOT_DISPLAY = 'Shepu-AI 4.1 Ultra';
  const BOT_PIC     = 'ai/pai.png';
  const BOT_ID      = 'shepu_ai_bot';
  // The bot's own backend identity (member id + session token). It used to
  // post with the HUMAN's credentials, so the Apps Script stored the
  // answer under the human's member id and name — after a reload the
  // answer showed up as the user's OWN message (right-aligned, "Sent"
  // tick, no author). The bot keeps its own member row instead.
  let _botSession  = null;
  const MENTION_RE  = /@shepu-ai\b/i;
  const TRIGGER_RE  = /@shepu-ai\b\s*(.*)/is;   // capture the question after the mention
  const MAX_HISTORY_MESSAGES = 8;

  let _room      = null;
  let _session   = null;
  let _input     = null;
  let _pop       = null;   // suggestion popup element
  let _items     = [];
  let _activeIdx = -1;

  // Per-room short context (bot Q&A only — never other members' messages).
  let _historyRoomId = null;
  let _history = [];
  let _inflight = new Set();
  let _activeResponses = 0;
  let _typingTimer = null;
  let _keyBound = false;   // guards against double-binding the key handler

  // ── Init ──────────────────────────────────────────────────────
  function init(room, session, inputEl) {
    _room    = room;
    _session = session;
    _input   = inputEl || document.getElementById('chat-input');

    // Reset the bot's local conversation context only when the room changes.
    const roomId = room && room.id ? String(room.id) : '';
    if (roomId !== _historyRoomId) {
      _historyRoomId = roomId;
      _history = [];
      if (typeof Shepu !== 'undefined' && typeof Shepu.resetContext === 'function') {
        try { Shepu.resetContext(); } catch (e) { /* non-fatal */ }
      }
    }

    // Build the suggestion popup once, anchored above the input bar.
    _buildPopup();

    if (_input) {
      _input.addEventListener('input', _onInput);
      _input.addEventListener('blur', () => setTimeout(hidePopup, 150));
      // The keydown handler MUST run before the chat module's own Enter
      // handler (chat.js binds its listener first, in Chat.init). Otherwise
      // Chat sends the message — and clears the input — before the popup
      // handler can apply the suggestion, so "@sh" was sent as plain text and
      // the popup stayed open. Capturing on the document runs first.
      if (!_keyBound) {
        _keyBound = true;
        document.addEventListener('keydown', (e) => {
          if (e.target !== _input) return;
          _onKeydown(e);
        }, true);
      }
    }

    // Load the knowledge base (non-blocking).
    if (typeof Shepu !== 'undefined') Shepu.init();
  }

  // ── Mention parsing ───────────────────────────────────────────
  // Returns the question text after "@shepu-ai", or null if not mentioned.
  function extractQuestion(text) {
    if (!text) return null;
    if (!MENTION_RE.test(text)) return null;
    const m = text.match(TRIGGER_RE);
    if (!m) return null;
    const q = (m[1] || '').trim();
    // If they wrote just "@shepu-ai" with nothing after, give a friendly nudge.
    return q.length ? q : 'who are you';
  }

  // Should this outgoing message trigger the bot?
  function isMention(text) {
    return !!text && MENTION_RE.test(text);
  }

  // ── Answer + broadcast ────────────────────────────────────────
  // Generates the answer and sends it as a chat message that everyone sees.
  async function respond(question, opts) {
    opts = opts || {};
    if (typeof Shepu === 'undefined') {
      return 'Shepu-AI engine not loaded.';
    }

    const q = String(question == null ? '' : question).trim();
    if (!q) return '';

    // Avoid duplicate replies when the same event reaches us twice.
    const inflightKey = q.toLowerCase();
    if (_inflight.has(inflightKey)) return '';
    _inflight.add(inflightKey);
    _activeResponses++;
    _startTyping();

    try {
      // 0. Music command ("gan chalu" / "gan bondho" / "gan chenge") — the
      // radio is a room feature, so answer with a short confirmation
      // instead of a generic AI answer.
      if (typeof RoomMusic !== 'undefined' && typeof RoomMusic.detectCommand === 'function') {
        let cmd = null;
        try { cmd = RoomMusic.detectCommand(q); } catch (e) { cmd = null; }
        if (cmd) {
          const bengali = /[\u0980-\u09ff]/.test(q);
          let reply = '';
          if (cmd === 'play') {
            try { if (typeof RoomMusic.play === 'function') RoomMusic.play(); } catch (e) { /* non-fatal */ }
            reply = bengali
              ? 'গান চালু করেছি 🎵'
              : 'gan chalu koreci 🎵';
          } else if (cmd === 'stop') {
            try { if (typeof RoomMusic.stop === 'function') RoomMusic.stop(); } catch (e) { /* non-fatal */ }
            reply = bengali
              ? 'গান বন্ধ করেছি ⏹'
              : 'gan bondho koreci ⏹';
          } else if (cmd === 'next') {
            try { if (typeof RoomMusic.next === 'function') RoomMusic.next(); } catch (e) { /* non-fatal */ }
            reply = bengali
              ? 'গান পরিবর্তন করেছি 🎶'
              : 'gan chenge koreci 🎶';
          }
          if (reply) {
            const safeReply = _hideProvider(reply);
            await sendBotMessage(safeReply);
            _remember(q, safeReply);
            return safeReply;
          }
        }
      }

      // 0.5. Room command? The multilingual local parser handles call / remove
      // member / invite link / password / lock / delete requests before the
      // image or text engines. Remove and delete ask for confirmation.
      if (typeof ShepuActions !== 'undefined' && typeof ShepuActions.detect === 'function') {
        let action = null;
        try { action = ShepuActions.detect(q); } catch (e) { action = null; }
        if (action) {
          const result = await ShepuActions.run(action, { room: _room, session: _session });
          if (result && result.text) {
            const safeResult = _hideProvider(result.text);
            let sendError = null;
            try { await sendBotMessage(safeResult); } catch (e) { sendError = e; }
            _remember(q, safeResult);
            if (result.reload) {
              setTimeout(() => {
                try { window.location.reload(); } catch (e) { /* non-fatal */ }
              }, 1300);
            }
            if (result.redirect) {
              setTimeout(() => {
                try {
                  if (result.cleanupRoom && typeof Rooms !== 'undefined' && typeof Rooms.removeRoom === 'function') {
                    Rooms.removeRoom(result.cleanupRoom);
                  }
                } catch (e) { /* continue to redirect */ }
                try {
                  if (result.clearSession && typeof Storage !== 'undefined') {
                    if (typeof Storage.clearSession === 'function') Storage.clearSession();
                    if (typeof Storage.clearCurrentRoom === 'function') Storage.clearCurrentRoom();
                  }
                } catch (e) { /* continue to redirect */ }
                try { window.location.href = result.redirect; } catch (e) { /* non-fatal */ }
              }, 1800);
            }
            // The server may refuse a reply after deleting the room. The
            // local cleanup/redirect above must still happen in that case.
            if (sendError && !result.redirect) throw sendError;
            return safeResult;
          }
        }
      }

      // 1. Image request → local official portrait or a keyless image URL.
      // Vague "ছবি বানাও" requests are clarified first so the prompt is
      // useful before anything is generated.
      if (typeof Shepu.isImageRequest === 'function' &&
          typeof Shepu.generateImage === 'function' &&
          Shepu.isImageRequest(q)) {
        let asksForPrompt = false;
        try {
          asksForPrompt = typeof Shepu.needsImagePrompt === 'function' && Shepu.needsImagePrompt(q);
        } catch (e) { asksForPrompt = false; }

        if (asksForPrompt) {
          const ask = 'কী ছবি বানাতে চান? একটু বিবরণ দিন — যেমন “সূর্যাস্তের সময় নদীর পাশে একটি বিড়াল” অথবা “একটি সাইবারপাঙ্ক শহরের ছবি”। 🎨';
          await sendBotMessage(ask);
          _remember(q, ask);
          return ask;
        }

        // Show the 4.1 canvas dots/percentage card immediately while the
        // prompt is enhanced and the keyless image URL is prepared. The
        // official portrait skips this and uses its own timed loader.
        let isOfficial = false;
        try {
          isOfficial = typeof Shepu.isOfficialPortraitRequest === 'function' &&
            Shepu.isOfficialPortraitRequest(q);
        } catch (e) { isOfficial = false; }
        let genId = null;
        try {
          if (!isOfficial && window.Chat && typeof Chat.beginImageGeneration === 'function') {
            genId = Chat.beginImageGeneration();
          }
        } catch (e) { genId = null; }

        let image = null;
        try {
          image = await Shepu.generateImage(q, {
            userName: _session && _session.displayName ? _session.displayName : ''
          });
        } catch (e) {
          image = null; // fall through to a text answer
        }
        if (genId && window.Chat && typeof Chat.endImageGeneration === 'function') {
          Chat.endImageGeneration(genId);
        }
        if (image && image.url) {
          // The image loader already communicates work in progress. Keep the
          // final generated-image message clean instead of persisting a
          // status sentence below the image.
          const caption = _hideProvider(image.caption || '');
          await sendBotMessage(caption, {
            imageUrl: image.url,
            fallbackUrl: image.fallbackUrl || '',
            official: !!image.official
          });
          _remember(q, '[Generated image: ' + (image.prompt || '') + ']');
          return caption;
        }

        // Image intent but no usable URL (prompt translation failed or the
        // image service is unavailable). Keep it an image-flow reply instead
        // of falling through to an unrelated text answer.
        const failMsg = 'ছবিটি তৈরি করা যায়নি। একটু সহজভাবে বিবরণ দিয়ে আবার @shepu-ai লিখে চেষ্টা করুন। 🎨';
        await sendBotMessage(failMsg);
        _remember(q, failMsg);
        return failMsg;
      }

      // 2. Normal text answer. findAnswer() is async in 4.1 Ultra because it
      // may use the keyless Shepu-AI text fallback after local matching.
      let answer;
      try {
        answer = await Shepu.findAnswer(q, {
          history: _history.slice(),
          userName: _session && _session.displayName ? _session.displayName : ''
        });
      } catch (e) {
        answer = 'দুঃখিত, উত্তর তৈরি করতে সমস্যা হচ্ছে।';
      }
      if (!answer) answer = 'আমি এই প্রশ্নের উত্তর খুঁজে পাচ্ছি না।';
      answer = _hideProvider(String(answer));

      await sendBotMessage(answer);
      _remember(q, answer);
      return answer;
    } catch (e) {
      // The chat's mention trigger does not await this promise; never leave
      // an unhandled rejection behind if rendering/transport fails.
      console.warn('[ShepuBot] Reply failed:', e && e.message ? e.message : e);
      return '';
    } finally {
      _inflight.delete(inflightKey);
      _activeResponses = Math.max(0, _activeResponses - 1);
      if (_activeResponses === 0) _stopTyping();
    }
  }

  function _remember(userText, botText) {
    _history.push({ role: 'user', content: String(userText || '') });
    _history.push({ role: 'assistant', content: String(botText || '') });
    if (_history.length > MAX_HISTORY_MESSAGES) {
      _history = _history.slice(-MAX_HISTORY_MESSAGES);
    }
  }

  // Local-only typing indicator. Chat.handleTypingEvent() auto-hides after
  // 6s, so refresh it while a slow Shepu-AI request is in flight.
  function _startTyping() {
    _paintTyping(true);
    if (_typingTimer) clearInterval(_typingTimer);
    _typingTimer = setInterval(() => {
      if (_activeResponses > 0) _paintTyping(true);
    }, 2000);
  }

  function _stopTyping() {
    if (_typingTimer) {
      clearInterval(_typingTimer);
      _typingTimer = null;
    }
    _paintTyping(false);
  }

  function _paintTyping(isTyping) {
    if (typeof window === 'undefined' || !window.Chat ||
        typeof Chat.handleTypingEvent !== 'function') return;
    try {
      Chat.handleTypingEvent({
        memberId: BOT_ID,
        displayName: BOT_DISPLAY,
        isTyping: !!isTyping
      });
    } catch (e) { /* non-fatal */ }
  }

  // Last line of defence: no bot reply should ever expose an internal
  // provider name, even if a local/API answer accidentally contains one.
  function _hideProvider(value) {
    return String(value == null ? '' : value)
      .replace(/\b(?:text|image)\.pollinations\.ai\b/gi, 'Shepu-AI')
      .replace(/\bpollinations(?:\s*ai|\.ai)?\b/gi, 'Shepu-AI');
  }

  // Send a message attributed to the bot, using the same transport as the
  // rest of the app so it reaches every participant.
  async function sendBotMessage(text, opts) {
    if (!_room) return;
    opts = opts || {};

    const safeText = _hideProvider(text);
    const imageUrl = opts.imageUrl ? String(opts.imageUrl) : '';
    const messageType = imageUrl ? 'image' : 'text';
    // Image messages use the same JSON attachment shape as normal Pchat
    // uploads. Chat's renderer allowlists either the exact bundled official
    // portrait path or the Shepu-AI image host before rendering.
    const isOfficial = imageUrl === 'ai/shepu-official.png';
    const fallbackUrl = (!isOfficial && typeof opts.fallbackUrl === 'string' &&
      /^https:\/\/image\.pollinations\.ai\/prompt\/[^\s"'<>]+$/i.test(opts.fallbackUrl))
      ? opts.fallbackUrl : '';
    let wireMessage;
    if (imageUrl) {
      const payload = {
        fileType: isOfficial ? 'image/png' : 'image/jpeg',
        dataUrl: imageUrl,
        fileName: isOfficial ? 'shepu-official.png' : 'shepu-ai.jpg',
        text: safeText,
        provider: isOfficial ? 'shepu-official' : 'shepu-ai-image'
      };
      if (fallbackUrl) payload.fallbackUrl = fallbackUrl;
      wireMessage = JSON.stringify(payload);
    } else {
      wireMessage = safeText;
    }

    const msgId     = 'm_' + Crypto.randomBase62(16);
    const nowTs     = new Date().toISOString();
    const botMsg = {
      id:             msgId,
      createdAt:      nowTs,
      senderId:       BOT_ID,
      senderName:     BOT_DISPLAY,
      senderPicture:  BOT_PIC,
      messageType:    messageType,
      message:        wireMessage,
      replyTo:        null,
      edited:         false,
      deleted:        false,
      _bot:           true,
    };

    // Render locally + broadcast to everyone (P2P) + persist (Apps Script).
    if (window.Chat && typeof Chat.appendMessages === 'function') {
      Chat.appendMessages([botMsg]);
    }

    // Persist to the Apps Script backend — independently of the P2P mesh.
    // These used to share one try block, so a failing server call skipped
    // the P2P broadcast and the bot's answer never reached the other
    // members at all.
    try {
      if (typeof RoomAPI !== 'undefined' && _room.deploymentUrl &&
          !_room.deploymentUrl.startsWith('mock://')) {
        // Post with the BOT's own credentials, so the Sheet stores the
        // answer under "Shepu-AI" and not under the human who asked.
        const botSess = await _ensureBotSession();
        const send = async (sess) => RoomAPI.sendMessage(_room.deploymentUrl, {
          memberId:     sess.memberId,
          sessionToken: sess.sessionToken,
          displayName:  BOT_DISPLAY,
          picture:      BOT_PIC,
          messageId:    msgId,
          message:      wireMessage,
          messageType:  messageType,
          replyTo:      '',
        });
        let res;
        try {
          res = await send(botSess || { memberId: BOT_ID, sessionToken: '' });
        } catch (e) { res = null; }
        // The cached token can go stale (room recreated, token rotated) —
        // join again once and retry.
        if (!res || !res.success) {
          const fresh = await _ensureBotSession(true);
          if (fresh) {
            try { res = await send(fresh); } catch (e) { res = null; }
          }
        }
      }
    } catch (e) { /* server down — still broadcast over P2P */ }

    try {
      if (typeof P2PSync !== 'undefined' && P2PSync.broadcastMessage) {
        P2PSync.broadcastMessage(botMsg);
      }
    } catch (e) { /* best-effort; local render already happened */ }
  }

  // ── The bot's own backend identity ─────────────────────────────
  // Joins the room once with the bot's display name so the backend stores
  // its answers under "Shepu-AI" instead of the human who asked. The
  // credentials are cached per room.
  async function _ensureBotSession(forceFresh = false) {
    const roomId = (_room && _room.id) || '';
    if (!roomId) return null;
    if (_botSession && !forceFresh) return _botSession;

    const cacheKey = 'shepu_bot_session_' + roomId;
    if (!forceFresh) {
      try {
        const raw = localStorage.getItem(cacheKey);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved && saved.memberId && saved.sessionToken) {
            _botSession = saved;
            return _botSession;
          }
        }
      } catch { /* fall through and join */ }
    }

    if (typeof RoomAPI === 'undefined' || !RoomAPI.join) return null;
    try {
      const res = await RoomAPI.join(_room.deploymentUrl, {
        displayName: BOT_DISPLAY,
        memberId: BOT_ID,
        picture: BOT_PIC,
      });
      if (res && res.success && res.memberId && res.sessionToken) {
        _botSession = { memberId: res.memberId, sessionToken: res.sessionToken };
        try { localStorage.setItem(cacheKey, JSON.stringify(_botSession)); } catch {}
        return _botSession;
      }
    } catch { /* the live P2P copy still works without a backend session */ }
    return null;
  }

  // ── Suggestion popup (autocomplete @shepu-ai) ──────────────────
  function _buildPopup() {
    _pop = document.getElementById('shepu-suggest');
    if (!_pop) {
      _pop = document.createElement('div');
      _pop.id = 'shepu-suggest';
      _pop.className = 'shepu-suggest hidden';
      // Anchor it right above the input bar.
      const bar = document.getElementById('chat-input-bar');
      if (bar) bar.appendChild(_pop);
      else document.body.appendChild(_pop);
    }
    _pop.addEventListener('mousedown', (e) => {
      // Prevent the textarea blur from firing before the click lands.
      e.preventDefault();
    });
  }

  // When typing "@" or "@sh…" show the full "@shepu-ai" suggestion.
  function _onInput() {
    const val = _input.value;
    const pos = _input.selectionStart;

    // Find the "@…" token immediately before the caret.
    const upto = val.slice(0, pos);
    const at = upto.lastIndexOf('@');
    const spaceBefore = upto.slice(0, at).match(/(^|\s)$/);

    if (at === -1 || !spaceBefore) { hidePopup(); return; }

    const token = upto.slice(at + 1).toLowerCase(); // text after '@'
    // The bot mention is "@shepu-ai". Show suggestion while the token is a
    // prefix of "shepu-ai" (i.e. "", "s", "sh", "she"… up to "shepu-ai").
    const target = 'shepu-ai';
    const isPrefix = target.startsWith(token) && token.length <= target.length;

    if (isPrefix) {
      showMentionSuggestion();
    } else {
      // Otherwise, optionally suggest known questions starting with the token.
      const qs = (typeof Shepu !== 'undefined') ? Shepu.suggest(token, 5) : [];
      if (qs.length && token.length >= 2) showQuestionSuggestions(qs, at);
      else hidePopup();
    }
  }

  function _renderPopup(items, replaceFromAt) {
    _items = items;
    _activeIdx = -1;
    _pop.innerHTML = '';
    _pop.setAttribute('role', 'presentation');

    // Small header so the popup reads as a bot card rather than a bare row.
    const head = document.createElement('div');
    head.className = 'shepu-suggest-head';
    const anyMention = items.some(it => it._mention);
    head.innerHTML = `
      <span class="shepu-suggest-head-title">${anyMention ? 'Mention' : 'Ask'}</span>
      <span class="shepu-suggest-head-pill">${escapeAttr(BOT_DISPLAY)}</span>
    `;
    _pop.appendChild(head);

    const list = document.createElement('div');
    list.className = 'shepu-suggest-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Shepu-AI suggestions');
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'shepu-suggest-item';
      if (it._mention) row.classList.add('mention');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      row.innerHTML = `
        <span class="shepu-suggest-avatar" aria-hidden="true">
          <img src="${escapeAttr(BOT_PIC)}" alt="" />
        </span>
        <span class="shepu-suggest-text">
          <span class="shepu-suggest-label">${escapeAttr(it.title)}</span>
          ${it.sub ? `<span class="shepu-suggest-desc">${escapeAttr(it.sub)}</span>` : ''}
        </span>
        <span class="shepu-suggest-enter" aria-hidden="true">↵</span>
      `;
      row.addEventListener('mouseenter', () => { _setActive(i); });
      row.addEventListener('click', () => _apply(i, replaceFromAt));
      list.appendChild(row);
    });
    _pop.appendChild(list);

    // Select the first row by default. With no row selected, Enter merely
    // closed the popup and sent the raw text ("@sh") to the room — the
    // autocomplete looked like it worked but never applied anything.
    try { _setActive(0); } catch { /* no rows */ }
    _pop.classList.remove('hidden');
    // Fade the bottom edge only when more rows are scrolled out of view, so a
    // half-cut row never sits at the bottom of the popup. This is measured
    // after the popup is visible, while it still has a layout box.
    list.classList.toggle('scrollable', list.scrollHeight > list.clientHeight + 1);
  }

  function showMentionSuggestion() {
    const items = [{
      title: 'Shepu-AI',
      sub: '@shepu-ai · Mention to start a chat',
      _mention: true,
      insert: '@shepu-ai ',
    }];
    _renderPopup(items, true);
  }

  function showQuestionSuggestions(questions, at) {
    // Prefix the bot mention: previously clicking a suggested question
    // replaced the "@…" prefix with bare question text, so the message was
    // never addressed to @shepu-ai and the bot never answered.
    const items = questions.map(q => {
      const label = /^@shepu-ai\b/i.test(q) ? q : '@shepu-ai ' + q;
      return {
        title: label.replace(/^@shepu-ai\s*/i, ''),
        sub: '',
        _mention: false,
        insert: label,
      };
    });
    _renderPopup(items, true);
  }

  function _setActive(i) {
    const rows = _pop.querySelectorAll('.shepu-suggest-item');
    rows.forEach(r => {
      r.classList.remove('active');
      r.setAttribute('aria-selected', 'false');
    });
    if (i >= 0 && rows[i]) {
      rows[i].classList.add('active');
      rows[i].setAttribute('aria-selected', 'true');
      _activeIdx = i;
    } else {
      _activeIdx = -1;
    }
  }

  function _apply(i, replaceFromAt) {
    const it = _items[i];
    if (!it) return;
    const val = _input.value;
    const pos = _input.selectionStart;
    const upto = val.slice(0, pos);
    const at = upto.lastIndexOf('@');
    if (at === -1) return;

    // Replace from the '@' to the caret with the chosen insert text.
    const insert = it.insert;
    _input.value = val.slice(0, at) + insert + val.slice(pos);
    const newPos = at + insert.length;
    _input.setSelectionRange(newPos, newPos);
    _input.focus();
    _input.dispatchEvent(new Event('input'));
    hidePopup();
  }

  function _onKeydown(e) {
    if (_pop.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _setActive((_activeIdx + 1) % _items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _setActive((_activeIdx - 1 + _items.length) % _items.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      if (_activeIdx >= 0) {
        e.preventDefault();
        e.stopPropagation();
        _apply(_activeIdx, true);
      } else {
        hidePopup();
      }
    } else if (e.key === 'Escape') {
      hidePopup();
    }
  }

  function hidePopup() {
    if (_pop) _pop.classList.add('hidden');
    _items = [];
    _activeIdx = -1;
  }

  // ── Tiny helper to avoid breaking attributes ───────────────────
  function escapeAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    init,
    respond,
    isMention,
    extractQuestion,
    BOT_ID,
    BOT_DISPLAY,
  };
})();

window.ShepuBot = ShepuBot;
