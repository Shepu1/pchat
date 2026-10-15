/**
 * SHEPU ROOMS — shepu-bot.js
 * ------------------------------------------------------------------
 * In-chat Shepu-AI bot (v3.1 engine from ai/shepu.js).
 *
 * Features:
 *   1. Mention detection — when a message contains "@shepu-ai" followed by a
 *      question, the bot answers using Shepu.findAnswer() (identical replies
 *      to v3.1). The reply is sent as a normal chat message so EVERYONE in the
 *      room sees it (works for both Apps Script rooms and P2P instant rooms).
 *   2. Autocomplete — while typing "@" or "@sh…" the full name "@shepu-ai"
 *      appears as a suggestion popup above the input box.
 *
 * This module piggy-backs on the existing Chat module: it reuses Chat's
 * private message send path through the globally-exposed hooks below.
 */

const ShepuBot = (() => {
  const BOT_NAME    = 'Shepu-AI';
  const BOT_ID      = 'shepu_ai_bot';
  const MENTION_RE  = /@shepu-ai\b/i;
  const TRIGGER_RE  = /@shepu-ai\b\s*(.*)/is;   // capture the question after the mention

  let _room      = null;
  let _session   = null;
  let _input     = null;
  let _pop       = null;   // suggestion popup element
  let _items     = [];
  let _activeIdx = -1;

  // ── Init ──────────────────────────────────────────────────────
  function init(room, session, inputEl) {
    _room    = room;
    _session = session;
    _input   = inputEl || document.getElementById('chat-input');

    // Build the suggestion popup once, anchored above the input bar.
    _buildPopup();

    if (_input) {
      _input.addEventListener('input', _onInput);
      _input.addEventListener('keydown', _onKeydown);
      _input.addEventListener('blur', () => setTimeout(hidePopup, 150));
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
    let answer;
    try {
      answer = Shepu.findAnswer(question);
    } catch (e) {
      answer = 'দুঃখিত, উত্তর তৈরি করতে সমস্যা হচ্ছে।';
    }
    if (!answer) answer = 'আমি এই প্রশ্নের উত্তর খুঁজে পাচ্ছি না।';

    await sendBotMessage(answer);
    return answer;
  }

  // Send a message attributed to the bot, using the same transport as the
  // rest of the app so it reaches every participant.
  async function sendBotMessage(text) {
    if (!_room) return;

    const msgId     = 'm_' + Crypto.randomBase62(16);
    const nowTs     = new Date().toISOString();
    const botMsg = {
      id:             msgId,
      createdAt:      nowTs,
      senderId:       BOT_ID,
      senderName:     BOT_NAME,
      senderPicture:  '',
      messageType:    'text',
      message:        text,
      replyTo:        null,
      edited:         false,
      deleted:        false,
      _bot:           true,
    };

    // Render locally + broadcast to everyone (P2P) + persist (Apps Script).
    if (window.Chat && typeof Chat.appendMessages === 'function') {
      Chat.appendMessages([botMsg]);
    }

    try {
      if (typeof RoomAPI !== 'undefined' && _room.deploymentUrl &&
          !_room.deploymentUrl.startsWith('mock://')) {
        await RoomAPI.sendMessage(_room.deploymentUrl, {
          memberId:     _session.memberId,
          sessionToken: _session.sessionToken,
          displayName:  BOT_NAME,
          picture:      '',
          messageId:    msgId,
          message:      text,
          messageType:  'text',
          replyTo:      '',
        });
      }
      if (typeof P2PSync !== 'undefined' && P2PSync.broadcastMessage) {
        P2PSync.broadcastMessage(botMsg);
      }
    } catch (e) { /* best-effort; local render already happened */ }
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
    items.forEach((it, i) => {
      const row = document.createElement('div');
      row.className = 'shepu-suggest-item';
      if (it._mention) row.classList.add('mention');
      row.innerHTML = `<span class="shepu-suggest-label">${escapeAttr(it.label)}</span>` +
                      (it.desc ? `<span class="shepu-suggest-desc">${escapeAttr(it.desc)}</span>` : '');
      row.addEventListener('mouseenter', () => { _setActive(i); });
      row.addEventListener('click', () => _apply(i, replaceFromAt));
      _pop.appendChild(row);
    });
    _pop.classList.remove('hidden');
  }

  function showMentionSuggestion() {
    const items = [{ label: '@shepu-ai', desc: 'Shepu-AI bot', _mention: true, insert: '@shepu-ai ' }];
    _renderPopup(items, true);
  }

  function showQuestionSuggestions(questions, at) {
    const items = questions.map(q => ({ label: q, desc: '', _mention: false, insert: q }));
    _renderPopup(items, true);
  }

  function _setActive(i) {
    const rows = _pop.querySelectorAll('.shepu-suggest-item');
    rows.forEach(r => r.classList.remove('active'));
    if (i >= 0 && rows[i]) {
      rows[i].classList.add('active');
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
    sendBotMessage,
    isMention,
    extractQuestion,
    hidePopup,
  };
})();

window.ShepuBot = ShepuBot;
