/**
 * SHEPU ROOMS — chat.js
 * Renders messages, handles send/edit/delete/reply, context menu,
 * optimistic UI, and member sidebar. Called from app.js after session is ready.
 */

const Chat = (() => {
  // ── State ─────────────────────────────────────────────────────
  let _room          = null;   // { id, name, description, deploymentUrl, ... }
  let _session       = null;   // { memberId, sessionToken, displayName, role }
  let _messages      = [];     // Rendered message objects (newest last)
  let _contextTarget = null;   // The message the context menu is open on
  let _replyTo       = null;   // { id, senderName, message } currently replying to
  let _editTarget    = null;   // { id } being edited
  let _atBottom      = true;   // Whether the feed is scrolled to bottom
  let _pendingIds    = new Set(); // Optimistic message IDs
  let _pendingAttachment = null; // { name, size, type, dataUrl }
  let _voiceSendResolver = null;  // send() waiting for the voice attachment
  // reactions: Map<msgId, Map<emoji, Set<memberId>>>
  const _reactions   = new Map();
  const _memberMap   = new Map();

  // A data: URL that may be rendered/downloaded. Everything is allowed
  // except the media types that can execute script when opened.
  const SAFE_DATA_URL_RE = /^data:(?!(?:text\/html|application\/xhtml\+xml|image\/svg\+xml)\b)[a-z0-9][a-z0-9!#$&^_+.-]*\/[a-z0-9][a-z0-9!#$&^_+.-]*[^,]*,/i;

  // ── DOM refs ──────────────────────────────────────────────────
  let feed, input, sendBtn, contextMenu, replyBar, typingEl, scrollBtn;

  // ── Init ──────────────────────────────────────────────────────
  function init(room, session) {
    _room    = room;
    _session = session;

    feed       = document.getElementById('chat-feed');
    input      = document.getElementById('chat-input');
    sendBtn    = document.getElementById('send-btn');
    contextMenu= document.getElementById('msg-context-menu');
    replyBar   = document.getElementById('reply-bar');
    typingEl   = document.getElementById('typing-indicator');
    scrollBtn  = document.getElementById('scroll-to-bottom-btn');

    _bindInput();
    _bindContextMenu();
    _bindModals();
    _bindTheme();
    _bindScroll();
    _bindHeaderMenu();
    _bindSidebar();
    _bindAttachments();
    _bindVoice();
    _bindEmojis();
    _bindEncryption();
    _bindNotifications();
    // Seed the member directory with self so the roster is never empty —
    // real presence/beacons refine it afterwards.
    try {
      if (_session && _session.memberId) {
        mergeMembers([{
          memberId: _session.memberId,
          displayName: _session.displayName || 'You',
          picture: _session.picture || '',
          role: _session.role || 'member',
          status: 'online',
          lastSeen: Date.now(),
        }], { touch: true });
      }
    } catch {}
    _soundsArmedAt = Date.now() + 3000;

    // Synced Room Radio / Music Player
    if (typeof RoomMusic !== 'undefined') {
      RoomMusic.init({
        roomId: _room.id,
        memberId: _session.memberId,
        displayName: _session.displayName,
      });
    }

    // Owner controls
    if (_session.role === 'owner') {
      const ownerActions = document.getElementById('owner-quick-actions');
      if (ownerActions) ownerActions.style.display = '';
      const ownerLink = document.getElementById('owner-panel-link');
      if (ownerLink) ownerLink.href = `owner.html?r=${_room.id}`;
      const menuOwner = document.getElementById('menu-owner-panel');
      if (menuOwner) menuOwner.style.display = '';
      const sepOwner  = document.getElementById('sep-owner');
      if (sepOwner)  sepOwner.style.display = '';
    }

    const lockBtn = document.getElementById('lock-room-btn');
    if (lockBtn) {
      lockBtn.addEventListener('click', () => ownerOp(_room.status === 'locked' ? 'unlock' : 'lock'));
    }

    // Shepu-AI in-chat bot (@shepu-ai mentions + autocomplete)
    if (typeof ShepuBot !== 'undefined') {
      ShepuBot.init(_room, _session, input);
    }
  }

  // ── Google Sheets Live Sync ──────────────────────────────────
  const _sheetSavedIds = new Set();

  async function _saveMessageToSheet(msg) {
    if (!_room || !_room.spreadsheetId || !msg || !msg.id) return;
    if (_sheetSavedIds.has(msg.id)) return;
    // ONLY the owner's device writes to the Sheet (owner's Drive/token).
    // Guests never touch it — no Google login, no per-user API toggles.
    if (!_session || _session.role !== 'owner') return;
    if (typeof Auth === 'undefined' || !Auth.isAuthenticated() || typeof Sheets === 'undefined') return;

    _sheetSavedIds.add(msg.id);
    try {
      const row = [
        msg.id,
        msg.createdAt || msg.timestamp || new Date().toISOString(),
        msg.senderId || '',
        msg.senderName || 'Member',
        msg.messageType || 'text',
        typeof msg.message === 'string' ? msg.message : JSON.stringify(msg.message || ''),
        msg.replyTo || '',
        msg.edited ? 'TRUE' : 'FALSE',
        msg.deleted ? 'TRUE' : 'FALSE',
      ];
      await Sheets.appendRows(_room.spreadsheetId, 'messages', [row]);
      console.log('[GoogleSheet] Live saved message row:', msg.id);
    } catch (err) {
      console.warn('[GoogleSheet] Error writing row to spreadsheet:', err.message);
      _sheetSavedIds.delete(msg.id);
    }
  }

  async function loadSheetMessages() {
    if (!_room || !_room.spreadsheetId) return [];
    if (typeof Auth === 'undefined' || !Auth.isAuthenticated() || typeof Sheets === 'undefined') return [];

    try {
      const rows = await Sheets.readValues(_room.spreadsheetId, 'messages!A2:I');
      if (!rows || !rows.length) return [];
      const msgs = rows.map(r => ({
        id:          r[0],
        createdAt:   r[1] || '',
        timestamp:   r[1] || '',
        senderId:    r[2] || '',
        senderName:  r[3] || 'Member',
        messageType: r[4] || 'text',
        message:     r[5] || '',
        replyTo:     r[6] || null,
        edited:      r[7] === 'TRUE',
        deleted:     r[8] === 'TRUE',
      })).filter(m => m.id);

      msgs.forEach(m => _sheetSavedIds.add(m.id));
      return msgs;
    } catch (err) {
      console.warn('[GoogleSheet] Could not read from sheet:', err.message);
      return [];
    }
  }

  // Sounds arm a few seconds after init so history backfill stays silent
  let _soundsArmedAt = 0;

  // ── Music voice command ("gan bajau" / "play music") ──────────
  // Any member can put the room radio on air by asking for it in chat.
  function _maybeMusicCommand(text) {
    if (!text) return false;
    try {
      if (typeof RoomMusic === 'undefined' || typeof RoomMusic.maybePlayFromMessage !== 'function') return false;
      return !!RoomMusic.maybePlayFromMessage(text);
    } catch (e) { return false; }
  }

  function _maybeMusicCommandFromMsg(msg) {
    if (!msg || msg.deleted) return false;
    if (msg.messageType && msg.messageType !== 'text') return false;
    // The bot's own replies must NEVER be read as music commands. Its answer
    // to "next song" is literally "gan chenge koreci 🎶", and the detector
    // read that as a "next" command: the asking client skipped TWO tracks,
    // and every other client advanced once and re-broadcast its own play,
    // so the room radio lost sync. The same applied to any AI answer that
    // happened to contain a music word ("you can play music by typing…").
    if (msg._bot === true) return false;
    if (msg.senderId && String(msg.senderId).indexOf('shepu_ai') === 0) return false;
    try {
      if (typeof ShepuBot !== 'undefined' && ShepuBot.BOT_DISPLAY &&
          msg.senderName && String(msg.senderName) === String(ShepuBot.BOT_DISPLAY)) return false;
    } catch { /* the bot module may not be loaded on this page */ }
    const raw = typeof msg.message === 'string' ? msg.message : '';
    if (!raw) return false;
    if (raw.startsWith('enc:')) {
      // Passphrase rooms encrypt the body — decrypt, then look for the intent.
      try {
        if (typeof Encryption !== 'undefined' && typeof Encryption.decrypt === 'function') {
          Encryption.decrypt(raw)
            .then(pt => { try { _maybeMusicCommand(pt); } catch (e) { /* non-fatal */ } })
            .catch(() => {});
        }
      } catch (e) { /* non-fatal */ }
      return false;
    }
    return _maybeMusicCommand(raw);
  }

  // ── Render messages from sync ─────────────────────────────────
  function appendMessages(msgs) {
    if (!msgs || !msgs.length) return;

    // Defense-in-depth: _optimistic is sender-local only. Old/buggy peers
    // may still broadcast it on the wire — strip it for anyone else's
    // message so sound + notification pipelines treat it as a real message.
    // (Own unconfirmed optimistic rows are matched by DOM id below anyway.)
    try {
      if (_session && _session.memberId) {
        msgs.forEach(m => {
          if (m && m._optimistic && m.senderId && m.senderId !== _session.memberId) {
            delete m._optimistic;
          }
        });
      }
    } catch { /* ignore */ }

    // Handle seen events & reaction events & music events separately
    const seenEvents     = msgs.filter(m => m._seenEvent);
    const reactionEvents = msgs.filter(m => m._reactionEvent);
    const musicEvents    = msgs.filter(m => m._musicEvent);
    const realMsgs       = msgs.filter(m => !m._seenEvent && !m._reactionEvent && !m._musicEvent);

    seenEvents.forEach(evt => {
      if (evt.seenBy !== _session.memberId) {
        _markMessagesSeen(evt.messageIds || [], evt.seenBy);
      }
    });

    reactionEvents.forEach(evt => {
      _applyReactionEvent(evt);
    });

    musicEvents.forEach(evt => {
      if (window.RoomMusic && typeof RoomMusic.handleSyncEvent === 'function') {
        RoomMusic.handleSyncEvent(evt.payload);
      }
    });

    if (!realMsgs.length) return;

    // Strict chronological sort
    const sortedMsgs = [...realMsgs].sort((a, b) => {
      const ta = new Date(a.createdAt || a.timestamp || 0).getTime();
      const tb = new Date(b.createdAt || b.timestamp || 0).getTime();
      return ta - tb;
    });

    let scrolledToBottom = _atBottom;
    let addedCount = 0;
    // The messages that were ACTUALLY rendered in this batch. Only these may
    // trigger a notification — the old code iterated the whole batch, so
    // opening a room fired one notification per cached history message.
    const newlyAdded = [];

    // Snapshot the state we had BEFORE this batch, for the "did the
    // renderable content actually change?" comparison below.
    const prevById = new Map(_messages.map(m => [m.id, m]));

    // Merge the batch into the local state FIRST.
    //
    // _makeMessageEl() resolves a reply's quoted parent through the
    // module-level _messages array. With the old order (merge AFTER the
    // render loop) the parents were not in there yet, so every reply that
    // was loaded together with the history rendered WITHOUT its quoted
    // snippet — and the element is never re-rendered afterwards.
    _messages = [..._messages, ...sortedMsgs.filter(m => !_messages.find(x => x.id === m.id))];
    _messages.sort((a, b) => new Date(a.createdAt || a.timestamp || 0) - new Date(b.createdAt || b.timestamp || 0));

    sortedMsgs.forEach(msg => {
      if (msg.senderId && msg.senderName) {
        _memberMap.set(msg.senderId, msg.senderName);
      }

      // 1. If already confirmed in DOM — silently update only when the
      // renderable content actually changed. Re-rendering an identical media
      // message (sync/polling repeats) used to restart its 4.1 loader and
      // could leave the official portrait stuck behind the animation.
      if (document.getElementById(`msg-${msg.id}`)) {
        const prev = prevById.get(msg.id);
        const unchanged = prev &&
          prev.message === msg.message &&
          (prev.messageType || 'text') === (msg.messageType || 'text') &&
          !!prev.deleted === !!msg.deleted &&
          !!prev.edited === !!msg.edited;
        if (!unchanged) _updateMessageEl(msg);
        return;
      }

      // 2. If optimistic placeholder exists in DOM — confirm in place without bounce
      const optimistic = document.getElementById(`opt-${msg.id}`);
      if (optimistic) {
        optimistic.id = `msg-${msg.id}`;
        optimistic.classList.remove('msg-optimistic');
        _pendingIds.delete(msg.id);
        _updateMessageEl(msg);
        _renderReactions(msg.id);
        return;
      }

      // 3. New message — build element and append in chronological order
      const msgEl = _makeMessageEl(msg);
      _insertMessageInOrder(msgEl, msg.createdAt || msg.timestamp);
      _renderReactions(msg.id);
      addedCount++;
      newlyAdded.push(msg);
    });

    // (The batch was merged into _messages BEFORE the render loop above so
    // that reply quotes could resolve their parent.)

    // Guarantee local persistence for all incoming messages across reloads
    if (sortedMsgs.length && _room?.id) {
      if (typeof IDBStorage !== 'undefined') {
        IDBStorage.putMessages(sortedMsgs.map(m => ({ ...m, roomId: _room.id }))).catch(() => {});
      }
      if (typeof Storage !== 'undefined' && Storage.saveRoomMessages) {
        Storage.saveRoomMessages(_room.id, sortedMsgs);
      }
    }

    // ── Sheet backup (Saved rooms): the owner's device logs EVERY message
    // it sees (own sends + guests via P2P/ntfy) to the room's Google Sheet.
    // Fire-and-forget — never blocks UI; _sheetSavedIds dedupes replays.
    if (sortedMsgs.length && _room?.spreadsheetId && _session?.role === 'owner') {
      sortedMsgs.forEach(m => {
        if (m && m.id && !m.deleted && !m._optimistic && !m._seenEvent && !m._reactionEvent && !m._musicEvent) {
          try {
            const r = _saveMessageToSheet(m);
            if (r && typeof r.catch === 'function') r.catch(() => {});
          } catch {}
        }
      });
    }

    // Fire background notifications for genuinely new incoming messages
    // (never for my own messages — Notify also guards this internally).
    // Only the messages that were rendered in THIS batch may notify.
    if (addedCount > 0 && typeof Notify !== 'undefined') {
      newlyAdded.forEach(m => {
        if (!m.deleted && (!m._optimistic) && m.senderId && _session && m.senderId !== _session.memberId) {
          try { Notify.notifyMessage(m); } catch {}
        }
      });
    }

    // ── Sound effects ───────────────────────────────────────────
    // emoji.mp3        → any incoming message containing an emoji (never own)
    // notification.mp3 → any OTHER incoming message (never own), whether the
    //                    chat is in the foreground or background.
    // Cooldowns inside RoomSounds prevent spam; history older than 2 min
    // never beeps so room-open backfill stays silent.
    if (addedCount > 0 && Date.now() > _soundsArmedAt && typeof RoomSounds !== 'undefined') {
      const incoming = sortedMsgs.filter(m =>
        !m.deleted && !m._optimistic && m.senderId && _session && m.senderId !== _session.memberId
      );
      const fresh = incoming.filter(m => {
        const t = new Date(m.createdAt || m.timestamp || 0).getTime();
        return Number.isFinite(t) && (Date.now() - t < 120000);
      });
      if (fresh.length) {
        const hasEmoji = fresh.some(m =>
          m.messageType !== 'image' && m.messageType !== 'file' &&
          (_containsEmoji(m.message) ||
            (typeof SpecialEmoji !== 'undefined' && SpecialEmoji.containsShortcode &&
              SpecialEmoji.containsShortcode(m.message)))
        );
        if (hasEmoji) {
          RoomSounds.playEmoji();
        } else {
          RoomSounds.playNotification();
        }
      }
    }

    // Update empty state and scroll smoothly only if user was already at bottom
    if (addedCount > 0) {
      _checkEmpty();
      if (scrolledToBottom) {
        feed.scrollTop = feed.scrollHeight;
        _broadcastSeenForVisible();
      } else if (scrollBtn) {
        scrollBtn.classList.remove('hidden');
      }
    }

    // ── Music voice command ──────────────────────────────────────
    // "gan bajau" / "play some music" puts the room radio on air. Only
    // genuinely new messages count — replayed history must never start
    // music by itself when a room opens.
    if (addedCount > 0) {
      sortedMsgs.forEach(m => {
        if (!m || m.deleted || m._optimistic) return;
        const ts = new Date(m.createdAt || m.timestamp || 0).getTime();
        if (!Number.isFinite(ts) || Date.now() - ts > 120000) return;
        _maybeMusicCommandFromMsg(m);
      });
    }
  }

  // ── Mark messages as seen (blue ticks) ───────────────────────
  function _markMessagesSeen(messageIds, seenBy) {
    if (!messageIds || !messageIds.length) return;
    messageIds.forEach(id => {
      const el = document.getElementById(`msg-${id}`) || document.getElementById(`opt-${id}`);
      if (!el) return;
      // Only update ticks on MY own messages (others saw them)
      if (el.dataset.senderId !== _session.memberId) return;
      const status = el.querySelector('.msg-status');
      if (!status) return;
      // Blue double-check = seen
      status.innerHTML = `<svg class="tick-icon" width="16" height="10" viewBox="0 0 16 10" fill="none">
        <polyline points="1,5 4,8 9,1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        <polyline points="6,5 9,8 15,1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>`;
      status.title = `Seen by ${seenBy || 'someone'}`;
      status.classList.remove('sent', 'sending');
      status.classList.add('seen');
    });
  }

  // ── Broadcast seen for currently visible messages ─────────────
  let _seenBroadcastDebounce = null;
  const _seenSentIds = new Set(); // already-reported msg ids (avoid replay)
  function _broadcastSeenForVisible() {
    clearTimeout(_seenBroadcastDebounce);
    _seenBroadcastDebounce = setTimeout(() => {
      if (!feed || !_messages.length) return;
      // Only report messages that are actually inside the feed viewport.
      // Previously every loaded message (including months of history the
      // user never scrolled to) was marked as seen.
      const fr = feed.getBoundingClientRect();
      if (!fr || !(fr.height > 0)) return;
      const visibleIds = [];
      _messages.forEach(m => {
        if (!m.id || m.deleted || !m.senderId) return;
        if (m.senderId === _session.memberId) return;
        if (_seenSentIds.has(m.id)) return;
        const el = document.getElementById(`msg-${m.id}`) || document.getElementById(`opt-${m.id}`);
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (!r || (r.width === 0 && r.height === 0)) return;
        const visible = r.bottom > fr.top && r.top < fr.bottom &&
                        r.right > fr.left && r.left < fr.right;
        if (visible) visibleIds.push(m.id);
      });
      if (!visibleIds.length) return;
      visibleIds.forEach(id => _seenSentIds.add(id));
      if (typeof P2PSync !== 'undefined' && P2PSync.broadcastSeen) {
        P2PSync.broadcastSeen(_session.memberId, visibleIds);
      }
    }, 600);
  }

  // ── Reactions ─────────────────────────────────────────────────
  // Quick reactions come from the custom set only (mapped via CustomEmoji).
  const _QUICK_REACTIONS = ['❤️','😂','😲','😭','😡','😍','😊','👋'];
  let _activeReactionPicker = null;

  function _openReactionPicker(e, msg, col) {
    // Close any already-open picker
    if (_activeReactionPicker) {
      _activeReactionPicker.remove();
      _activeReactionPicker = null;
    }

    const picker = document.createElement('div');
    picker.className = 'quick-reactions-popover';
    picker.setAttribute('role', 'toolbar');
    picker.setAttribute('aria-label', 'Quick reactions');

    _QUICK_REACTIONS.forEach(emoji => {
      const btn = document.createElement('button');
      btn.className = 'quick-rxn-btn';
      btn.type = 'button';
      btn.innerHTML = _reactionHtml(emoji);
      btn.title = emoji;
      // Highlight if already reacted
      const myReacted = (_reactions.get(msg.id)?.get(emoji) || new Set()).has(_session.memberId);
      if (myReacted) btn.classList.add('quick-rxn-active');
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        _toggleReaction(msg.id, emoji);
        picker.remove();
        _activeReactionPicker = null;
      });
      picker.appendChild(btn);
    });

    // Position above the col
    col.style.position = 'relative';
    col.appendChild(picker);
    _activeReactionPicker = picker;

    // Close on outside click
    const closeOnOutside = (ev) => {
      if (!picker.contains(ev.target)) {
        picker.remove();
        _activeReactionPicker = null;
        document.removeEventListener('click', closeOnOutside, true);
      }
    };
    setTimeout(() => document.addEventListener('click', closeOnOutside, true), 10);
  }

  function _toggleReaction(msgId, emoji) {
    if (!_reactions.has(msgId)) _reactions.set(msgId, new Map());
    const msgMap = _reactions.get(msgId);
    if (!msgMap.has(emoji)) msgMap.set(emoji, new Set());
    const memberSet = msgMap.get(emoji);

    const alreadyReacted = memberSet.has(_session.memberId);
    if (alreadyReacted) {
      memberSet.delete(_session.memberId);
      if (memberSet.size === 0) msgMap.delete(emoji);
    } else {
      memberSet.add(_session.memberId);
    }

    _renderReactions(msgId);

    // Broadcast via P2P
    if (typeof P2PSync !== 'undefined' && P2PSync.broadcastReaction) {
      P2PSync.broadcastReaction({
        msgId,
        emoji,
        memberId: _session.memberId,
        memberName: _session.displayName,
        action: alreadyReacted ? 'remove' : 'add',
      });
    }
  }

  function _applyReactionEvent(evt) {
    const { msgId, emoji, memberId, memberName, action } = evt;
    if (!msgId || !emoji || !memberId) return;
    if (memberName) _memberMap.set(memberId, memberName);
    if (!_reactions.has(msgId)) _reactions.set(msgId, new Map());
    const msgMap = _reactions.get(msgId);
    if (!msgMap.has(emoji)) msgMap.set(emoji, new Set());
    const memberSet = msgMap.get(emoji);
    if (action === 'remove') {
      memberSet.delete(memberId);
      if (memberSet.size === 0) msgMap.delete(emoji);
    } else {
      memberSet.add(memberId);
    }
    _renderReactions(msgId);
  }

  function _renderReactions(msgId) {
    const row = document.getElementById(`reactions-${msgId}`);
    if (!row) return;
    row.innerHTML = '';

    const msgMap = _reactions.get(msgId);
    if (!msgMap || msgMap.size === 0) return;

    msgMap.forEach((memberSet, emoji) => {
      if (memberSet.size === 0) return;
      const pill = document.createElement('button');
      pill.className = 'reaction-pill';
      pill.type = 'button';
      const iMine = memberSet.has(_session.memberId);
      if (iMine) pill.classList.add('reacted');

      // Tooltip with names (up to 3)
      const names = [...memberSet].map(id => {
        if (id === _session.memberId) return 'You';
        return _memberMap.get(id) || 'Member';
      }).slice(0, 3).join(', ');
      pill.title = `${emoji} ${names}${memberSet.size > 3 ? ` +${memberSet.size - 3} more` : ''}`;

      pill.innerHTML = `<span class="rxn-emoji">${_reactionHtml(emoji)}</span><span class="rxn-count">${memberSet.size}</span>`;
      pill.addEventListener('click', () => _toggleReaction(msgId, emoji));
      row.appendChild(pill);
    });

    // Pop-in animation for new reactions
    row.querySelectorAll('.reaction-pill').forEach((pill, i) => {
      pill.style.animationDelay = `${i * 30}ms`;
    });
  }

  function _insertMessageInOrder(msgEl, msgTime) {
    const rows = feed.querySelectorAll('.msg-row');
    if (!rows.length) {
      feed.appendChild(msgEl);
      return;
    }

    const targetTs = new Date(msgTime || 0).getTime();
    const lastRow = rows[rows.length - 1];
    const lastRowTs = new Date(lastRow.dataset.ts || 0).getTime();

    // If target timestamp is missing, invalid, or newer than / equal to last row -> append directly to bottom!
    if (isNaN(targetTs) || isNaN(lastRowTs) || targetTs >= lastRowTs) {
      feed.appendChild(msgEl);
      return;
    }

    // Historical placement: locate where this older message belongs
    let inserted = false;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const rowTs = new Date(row.dataset.ts || 0).getTime();
      if (!isNaN(rowTs) && rowTs <= targetTs) {
        row.after(msgEl);
        inserted = true;
        break;
      }
    }

    if (!inserted) {
      rows[0].before(msgEl);
    }
  }


  function _getLastRenderedDate() {
    const dividers = feed.querySelectorAll('.date-divider');
    if (!dividers.length) return '';
    return dividers[dividers.length - 1].dataset.date || '';
  }

  // ── Update existing message (edit/delete) ─────────────────────
  function _updateMessageEl(msg) {
    const el = document.getElementById(`msg-${msg.id}`);
    if (!el) return;

    const textEl = el.querySelector('.msg-text');
    if (!textEl) return;

    if (msg.deleted) {
      textEl.innerHTML = '<em style="color:var(--muted);">This message was deleted.</em>';
      el.querySelector('.msg-edited')?.remove();
      const actions = el.querySelector('.msg-bubble-actions');
      if (actions) actions.style.display = 'none';
    } else {
      let displayContent = msg.message;
    if (typeof Encryption !== 'undefined' && typeof displayContent === 'string' && displayContent.startsWith('enc:')) {
      // Async decrypt on demand
      Encryption.decrypt(displayContent).then(pt => {
        if (textEl && pt !== displayContent) {
          _renderBubbleContent(textEl, pt, msg.messageType, msg.id);
        }
      });
      textEl.innerHTML = '<span style="color:var(--text-3);font-size:0.8rem;display:inline-flex;align-items:center;gap:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> Decrypting…</span>';
    } else {
      _renderBubbleContent(textEl, displayContent, msg.messageType, msg.id);
    }
      if (msg.edited) {
        let editedLabel = el.querySelector('.msg-edited');
        if (!editedLabel) {
          editedLabel = document.createElement('span');
          editedLabel.className = 'msg-edited';
          editedLabel.textContent = 'edited';
          textEl.parentElement.appendChild(editedLabel);
        }
      }
    }
    // update local state
    const idx = _messages.findIndex(m => m.id === msg.id);
    if (idx >= 0) _messages[idx] = { ..._messages[idx], ...msg };
  }

  // ── Build a message element ───────────────────────────────────
  function _makeMessageEl(msg) {
    const isMe      = msg.senderId === _session.memberId;
    const isDeleted = msg.deleted;
    const isOwner   = _session.role === 'owner';
    const canEdit   = isMe && !isDeleted;
    const canDelete = (isMe || isOwner) && !isDeleted;

    const wrapper = document.createElement('div');
    wrapper.className = `msg-row ${isMe ? 'own msg-mine' : 'other'}`;
    wrapper.id = `msg-${msg.id}`;
    wrapper.dataset.msgId   = msg.id;
    wrapper.dataset.senderId= msg.senderId;
    wrapper.dataset.ts      = msg.createdAt || msg.timestamp || new Date().toISOString();

    // Avatar
    if (!isMe) {
      const av = document.createElement('div');
      av.className = 'msg-avatar';
      av.setAttribute('aria-hidden', 'true');
      // Avatar images: uploads (data:image), remote https pics, or bundled
      // relative assets (e.g. the Shepu-AI bot's ai/pai.png). Anything else
      // (e.g. javascript:/data:text URLs) falls back to initials.
      const _sp = (typeof msg.senderPicture === 'string') ? msg.senderPicture.trim() : '';
      const senderPic = (/^(data:image\/|https?:\/\/|ai\/|assets\/)/i.test(_sp)) ? _sp : '';
      if (senderPic) {
        const img = document.createElement('img');
        img.alt = msg.senderName || '';
        img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;';
        img.src = senderPic;
        img.onerror = () => { av.textContent = UI.getInitial(msg.senderName); };
        av.appendChild(img);
      } else {
        av.textContent = UI.getInitial(msg.senderName);
      }
      wrapper.appendChild(av);
    }

    const col = document.createElement('div');
    col.className = 'msg-col';

    // Sender name
    if (!isMe) {
      const name = document.createElement('div');
      name.className = 'msg-sender-name';
      name.textContent = escapeHtml(msg.senderName || 'Unknown');
      col.appendChild(name);
    }

    // Reply quote
    if (msg.replyTo) {
      const replyRef = _messages.find(m => m.id === msg.replyTo);
      if (replyRef) {
        const quote = document.createElement('div');
        quote.className = 'msg-reply-quote';
        quote.innerHTML = `<span class="reply-quote-name">${_escEmo(replyRef.senderName || '')}</span>
          <span class="reply-quote-text">${_escEmo(_displayText(replyRef))}</span>`;
        col.appendChild(quote);
      }
    }

    // Detect emoji-only messages
    const rawText = (msg.messageType === 'text' && !isDeleted && typeof msg.message === 'string') ? msg.message.trim() : '';
    const isEmojiMsg = rawText && _isEmojiOnly(rawText);
    const emojiCount = isEmojiMsg ? _countEmojis(rawText) : 0;
    // Special-emoji shortcodes count toward the big-bubble sizing too
    let spCount = 0;
    try {
      if (isEmojiMsg && typeof SpecialEmoji !== 'undefined' && SpecialEmoji.countShortcodes) {
        spCount = SpecialEmoji.countShortcodes(rawText) || 0;
      }
    } catch {}

    // Bubble
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    if (isEmojiMsg) {
      bubble.classList.add('msg-bubble-emoji');
      // Use grapheme-aware count; if Intl.Segmenter returns 0 (edge case), estimate from text length
      const effectiveCount = (emojiCount + spCount) > 0 ? (emojiCount + spCount) : Math.max(1, Math.ceil(rawText.length / 2));
      if (effectiveCount === 1)      bubble.classList.add('emoji-xl');
      else if (effectiveCount <= 3)  bubble.classList.add('emoji-lg');
      else if (effectiveCount <= 6)  bubble.classList.add('emoji-md');
      else if (effectiveCount <= 12) bubble.classList.add('emoji-sm');
      else                           bubble.classList.add('emoji-xs');
    }
    bubble.setAttribute('role', 'article');

    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    if (isDeleted) {
      textEl.innerHTML = '<em style="color:var(--muted);">This message was deleted.</em>';
    } else {
      let displayContent = msg.message;
    if (typeof Encryption !== 'undefined' && typeof displayContent === 'string' && displayContent.startsWith('enc:')) {
      // Async decrypt on demand
      Encryption.decrypt(displayContent).then(pt => {
        if (textEl && pt !== displayContent) {
          _renderBubbleContent(textEl, pt, msg.messageType, msg.id);
        }
      });
      textEl.innerHTML = '<span style="color:var(--text-3);font-size:0.8rem;display:inline-flex;align-items:center;gap:4px;"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg> Decrypting…</span>';
    } else {
      _renderBubbleContent(textEl, displayContent, msg.messageType, msg.id);
    }
    }
    bubble.appendChild(textEl);
    _paintMediaBubble(textEl); // initial render happens pre-attach, so paint here

    if (msg.edited && !isDeleted) {
      const editedLabel = document.createElement('span');
      editedLabel.className = 'msg-edited';
      editedLabel.textContent = 'edited';
      bubble.appendChild(editedLabel);
    }

    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.innerHTML = `<span class="msg-time" title="${escapeHtml(msg.createdAt || '')}">${escapeHtml(UI.formatTime(msg.createdAt))}</span>`;
    if (isMe && !isDeleted) {
      // Double checkmark (sent) — WhatsApp style
      meta.innerHTML += `<span class="msg-status sent" aria-label="Sent" title="Sent">
        <svg class="tick-icon" width="16" height="10" viewBox="0 0 16 10" fill="none">
          <polyline points="1,5 4,8 9,1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <polyline points="6,5 9,8 15,1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </span>`;
    }
    bubble.appendChild(meta);

    // Actions (hover) — React | Copy | Reply | More
    if (!isDeleted) {
      const actions = document.createElement('div');
      actions.className = 'msg-bubble-actions';
      actions.setAttribute('aria-label', 'Message actions');

      // React button
      const reactBtn = document.createElement('button');
      reactBtn.className = 'msg-action-btn';
      reactBtn.title = 'React';
      reactBtn.setAttribute('aria-label', 'React');
      reactBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>';
      reactBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _openReactionPicker(e, msg, col);
      });
      actions.appendChild(reactBtn);

      // Copy button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'msg-action-btn';
      copyBtn.title = 'Copy';
      copyBtn.setAttribute('aria-label', 'Copy message');
      copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await UI.copyText(await _copyableText(msg.message));
        copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        setTimeout(() => {
          copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
        }, 1500);
      });
      actions.appendChild(copyBtn);

      // Reply button
      const replyBtn = document.createElement('button');
      replyBtn.className = 'msg-action-btn';
      replyBtn.title = 'Reply';
      replyBtn.setAttribute('aria-label', 'Reply');
      replyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>';
      replyBtn.addEventListener('click', () => startReply(msg));
      actions.appendChild(replyBtn);

      // More options
      const menuBtn = document.createElement('button');
      menuBtn.className = 'msg-action-btn';
      menuBtn.title = 'More options';
      menuBtn.setAttribute('aria-label', 'More options');
      menuBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="1.5"></circle><circle cx="19" cy="12" r="1.5"></circle><circle cx="5" cy="12" r="1.5"></circle></svg>';
      // stopPropagation: the document-level "click outside closes the menu"
      // listener (_bindContextMenu) must not see this click, otherwise it
      // closes the menu in the same tick it was opened.
      menuBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openContextMenu(e, msg);
      });
      actions.appendChild(menuBtn);

      col.appendChild(actions);
    }

    // Reactions row — AFTER bubble
    col.appendChild(bubble);
    const reactionsRow = document.createElement('div');
    reactionsRow.className = 'msg-reactions-row';
    reactionsRow.id = `reactions-${msg.id}`;
    col.appendChild(reactionsRow);

    wrapper.appendChild(col);

    // Desktop double-click → like (mirrors mobile double-tap)
    wrapper.addEventListener('dblclick', (e) => {
      e.preventDefault();
      doubleTapLike();
    });

    // Context menu events
    wrapper.addEventListener('contextmenu', (e) => {
      // Skip the synthetic menu some browsers fire right after a long-press
      // (the quick reaction picker is already open in that case).
      if (wrapper.dataset.lp === '1') {
        wrapper.dataset.lp = '';
        e.preventDefault();
        return;
      }
      e.preventDefault();
      openContextMenu(e, msg);
    });

    // ── Mobile shortcuts ──────────────────────────────────────
    // • Long-press (no move) → quick reaction picker
    // • Swipe right → reply to this message
    let longPressTimer = null;
    let swipeX = 0, swipeY = 0, swipePull = 0;
    let swipeHint = null;
    let lastTapAt = 0, lastTapX = 0, lastTapY = 0;

    const buzz = (pattern) => {
      try { if (navigator.vibrate) navigator.vibrate(pattern); } catch {}
    };

    // Big floating heart on double-tap like (Messenger-style)
    const heartBurst = () => {
      try {
        let inner = '❤️';
        try {
          if (typeof CustomEmoji !== 'undefined' && CustomEmoji.isLoaded && CustomEmoji.isLoaded()) {
            const it = CustomEmoji.lookup('❤️');
            if (it) inner = `<img src="${it.src}" alt="❤️" width="72" height="72" draggable="false" style="width:72px;height:72px;object-fit:contain;pointer-events:none;" />`;
          }
        } catch {}
        const el = document.createElement('div');
        el.setAttribute('aria-hidden', 'true');
        el.style.cssText = 'position:absolute;left:50%;top:50%;z-index:5;pointer-events:none;transform:translate(-50%,-50%);';
        el.innerHTML = inner;
        col.style.position = 'relative';
        col.appendChild(el);
        const target = el.firstElementChild || el;
        if (target.animate) {
          target.animate(
            [{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.25)', opacity: 1, offset: 0.35 }, { transform: 'scale(1)', opacity: 1, offset: 0.6 }, { transform: 'scale(1.1) translateY(-18px)', opacity: 0 }],
            { duration: 750, easing: 'cubic-bezier(0.16,1,0.3,1)' }
          ).onfinish = () => el.remove();
          setTimeout(() => el.remove(), 900);
        } else {
          setTimeout(() => el.remove(), 700);
        }
      } catch {}
    };

    const doubleTapLike = () => {
      if (msg.deleted) return;
      _toggleReaction(msg.id, '❤️');
      buzz(15);
      heartBurst();
    };

    const showSwipeHint = (pull) => {
      if (!swipeHint) {
        swipeHint = document.createElement('div');
        swipeHint.setAttribute('aria-hidden', 'true');
        swipeHint.style.cssText = [
          'position:absolute', 'left:-34px', 'top:50%',
          'transform:translateY(-50%)',
          'width:26px', 'height:26px', 'border-radius:50%',
          'background:var(--accent-dim)', 'color:var(--accent-2)',
          'display:grid', 'place-items:center',
          'opacity:0', 'transition:opacity 0.12s ease',
          'pointer-events:none',
        ].join(';');
        swipeHint.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path></svg>';
        col.style.position = 'relative';
        col.appendChild(swipeHint);
      }
      swipeHint.style.opacity = pull > 24 ? '1' : '0';
    };

    wrapper.addEventListener('touchstart', (ev) => {
      const t = ev.touches[0];
      swipeX = t.clientX; swipeY = t.clientY; swipePull = 0;
      if (msg.deleted) return;
      longPressTimer = setTimeout(() => {
        buzz(10);
        wrapper.dataset.lp = '1'; // suppress the follow-up synthetic contextmenu
        setTimeout(() => { if (wrapper.dataset.lp === '1') wrapper.dataset.lp = ''; }, 900);
        _openReactionPicker({}, msg, col);
      }, 450);
    }, { passive: true });

    wrapper.addEventListener('touchmove', (ev) => {
      const t = ev.touches[0];
      if (!t) return;
      const dx = t.clientX - swipeX;
      const dy = t.clientY - swipeY;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        clearTimeout(longPressTimer); // moved → not a long-press
      }
      if (!msg.deleted && dx > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) {
        swipePull = Math.min(dx, 90);
        col.style.transition = 'none';
        col.style.transform = `translateX(${swipePull}px)`;
        showSwipeHint(swipePull);
      }
    }, { passive: true });

    const endTouch = (ev) => {
      clearTimeout(longPressTimer);
      const t = ev.changedTouches && ev.changedTouches[0];
      const dx = t ? t.clientX - swipeX : 999;
      const dy = t ? t.clientY - swipeY : 999;
      const quickTap = Math.abs(dx) < 12 && Math.abs(dy) < 12;
      if (swipePull > 0) {
        col.style.transition = 'transform 0.18s ease';
        col.style.transform = '';
        if (swipeHint) swipeHint.style.opacity = '0';
        if (!msg.deleted && dx > 55 && Math.abs(dy) < 60) {
          startReply(msg);
          buzz(8);
        }
        swipePull = 0;
      } else if (quickTap && !msg.deleted) {
        const now = Date.now();
        const dist = Math.hypot((t ? t.clientX : 0) - lastTapX, (t ? t.clientY : 0) - lastTapY);
        if (now - lastTapAt < 300 && dist < 32) {
          lastTapAt = 0; // consume so triple-tap starts fresh
          doubleTapLike();
        } else {
          lastTapAt = now;
          lastTapX = t ? t.clientX : 0;
          lastTapY = t ? t.clientY : 0;
        }
      }
    };
    wrapper.addEventListener('touchend', endTouch);
    wrapper.addEventListener('touchcancel', () => {
      clearTimeout(longPressTimer);
      col.style.transition = 'transform 0.18s ease';
      col.style.transform = '';
      if (swipeHint) swipeHint.style.opacity = '0';
      swipePull = 0;
    });

    return wrapper;
  }

  function _makeDateDivider(ts) {
    const div = document.createElement('div');
    div.className = 'date-divider';
    div.dataset.date = ts ? new Date(ts).toDateString() : '';
    div.innerHTML = `<span>${UI.formatDate(ts)}</span>`;
    return div;
  }

  function _checkEmpty() {
    const emptyEl = document.getElementById('chat-empty');
    if (!emptyEl) return;
    const hasMessages = feed.querySelectorAll('.msg-row').length > 0;
    emptyEl.style.display = hasMessages ? 'none' : '';
  }

  // ── Emoji detection helpers ───────────────────────────────────
  function _stripSpecialCodes(text) {
    try {
      if (typeof SpecialEmoji !== 'undefined' && SpecialEmoji.stripShortcodes) {
        return SpecialEmoji.stripShortcodes(text);
      }
    } catch {}
    return String(text || '').replace(/:sp_[A-Za-z0-9_-]{1,48}:/g, '');
  }
  function _isEmojiOnly(text) {
    if (!text || !text.trim()) return false;
    // Strip ALL emoji-related code points, then check if any real text remains
    const stripped = _stripSpecialCodes(text).trim()
      // Keycap sequences (1️⃣ = U+0031 U+FE0F U+20E3) must go FIRST — the base
      // character only means something together with the combining keycap.
      // Stripping plain digits separately turned "2024" into an empty string
      // and rendered the message as a giant emoji bubble.
      .replace(/[0-9#*][\uFE00-\uFE0F]?\u20E3/g, '')
      .replace(/\p{Emoji_Presentation}/gu, '')      // standard emoji (colored)
      .replace(/\p{Extended_Pictographic}/gu, '')    // extended pictographic
      .replace(/[\uFE00-\uFE0F]/g, '')               // variation selectors
      .replace(/\u200D/g, '')                         // zero-width joiner (ZWJ)
      .replace(/\u20E3/g, '')                         // stray combining keycap
      .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')        // regional indicators (flags)
      .replace(/\s/g, '');                            // whitespace
    return stripped.length === 0;
  }

  // True if the text contains ANY emoji (system or custom-mapped).
  // Used for the emoji sound effect: "keu emoji dile play korbe".
  function _containsEmoji(text) {
    if (!text || typeof text !== 'string') return false;
    try {
      return /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(text);
    } catch {
      return false;
    }
  }

  function _countEmojis(text) {
    if (!text) return 0;
    // Intl.Segmenter gives accurate grapheme cluster count (handles ZWJ/flags)
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      try {
        const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        return [...seg.segment(text.trim())].filter(s =>
          /\p{Emoji_Presentation}|\p{Extended_Pictographic}/u.test(s.segment)
        ).length;
      } catch {}
    }
    // Fallback: rough count (may over-count ZWJ sequences)
    const m = text.match(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu);
    return m ? m.length : 0;
  }

  // ── Text rendering (custom emoji + linkify) ───────────────────
  // Outside unicode emojis are auto-replaced with the custom set
  // (assets/emoji maps) so the whole chat renders consistently.
  function _renderText(text) {
    if (!text) return '';
    let t = escapeHtml(text);
    // Swap unicode emojis for custom images BEFORE linkify so inserted
    // <img> tags (relative src) are never mistaken for links.
    try {
      if (typeof CustomEmoji !== 'undefined' && CustomEmoji.isLoaded && CustomEmoji.isLoaded()) {
        t = CustomEmoji.emojifyEscaped(t);
      }
    } catch { /* fall back to plain text */ }
    // Linkify URLs
    t = t.replace(/(https?:\/\/[^\s<>"]+)/gi,
      '<a href="$1" target="_blank" rel="noopener noreferrer" class="msg-link">$1</a>');
    // Special-emoji shortcodes → inline <img>. MUST run after linkify:
    // the pass emits absolute blob: URLs and linkify would shred them.
    // (Shortcodes themselves contain no URL prefix, so linkify never
    // matches them first.)
    try {
      if (typeof SpecialEmoji !== 'undefined' && SpecialEmoji.emojifyShortcodes) {
        t = SpecialEmoji.emojifyShortcodes(t);
      }
    } catch { /* leave shortcodes as text */ }
    // Line breaks
    t = t.replace(/\n/g, '<br>');
    return t;
  }

  // Escape + custom-emoji swap for short inline snippets (names, quotes)
  function _escEmo(text) {
    const e = escapeHtml(text || '');
    try {
      if (typeof CustomEmoji !== 'undefined' && CustomEmoji.isLoaded && CustomEmoji.isLoaded()) {
        const c = CustomEmoji.emojifyEscaped(e);
        if (typeof SpecialEmoji !== 'undefined' && SpecialEmoji.emojifyShortcodes) {
          return SpecialEmoji.emojifyShortcodes(c);
        }
        return c;
      }
    } catch {}
    try {
      if (typeof SpecialEmoji !== 'undefined' && SpecialEmoji.emojifyShortcodes) {
        return SpecialEmoji.emojifyShortcodes(e);
      }
    } catch {}
    return e;
  }

  // Render a single reaction emoji (custom image when mapped)
  function _reactionHtml(emoji) {
    try {
      if (typeof CustomEmoji !== 'undefined' && CustomEmoji.isLoaded && CustomEmoji.isLoaded()) {
        const it = CustomEmoji.lookup(emoji);
        if (it) {
          const alt = String(emoji).replace(/"/g, '&quot;');
          // eager + fixed size + text fallback: buttons never render blank
          return `<img src="${it.src}" alt="${alt}" title="${alt}" width="22" height="22" class="custom-emoji custom-emoji-sm" loading="eager" draggable="false" onerror="this.replaceWith(document.createTextNode(this.alt))" />`;
        }
      }
    } catch {}
    return escapeHtml(emoji);
  }

  // ── Copy helper: always copy READABLE text ───────────────────
  // Raw msg.message may be enc: ciphertext (encrypted rooms) or a JSON
  // attachment wrapper. Copying it raw pastes gibberish — decrypt first,
  // then unwrap attachments.
  async function _copyableText(message) {
    let t = typeof message === 'string' ? message : '';
    if (t.startsWith('enc:')) {
      try {
        if (typeof Encryption !== 'undefined') t = await Encryption.decrypt(t);
      } catch {}
    }
    if (t.startsWith('{')) {
      try {
        const parsed = JSON.parse(t);
        t = parsed.text || parsed.fileName || t;
      } catch {}
    }
    return t;
  }

  // ── Input handling ────────────────────────────────────────────
  function _bindInput() {
    const charCounter = document.getElementById('chat-char-counter');
    const MAX = 4000;

    function _updateSendState() {
      const hasText = (input.value && input.value.trim().length > 0) || _pendingAttachment !== null;
      const len = input.value ? input.value.length : 0;
      if (sendBtn) {
        sendBtn.setAttribute('data-empty', hasText ? 'false' : 'true');
      }
      if (charCounter) {
        charCounter.textContent = `${len} / ${MAX}`;
        charCounter.classList.remove('warn', 'danger');
        if (len >= MAX * 0.9) charCounter.classList.add('danger');
        else if (len >= MAX * 0.75) charCounter.classList.add('warn');
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    ['input', 'keyup', 'change', 'compositionend', 'paste'].forEach(ev => {
      input.addEventListener(ev, () => {
        UI.autoResize(input);
        _updateSendState();
        _notifyTyping();
      });
    });

    sendBtn.addEventListener('click', () => sendMessage());
    // When the keyboard slides up, make sure the input + latest messages stay visible
    input.addEventListener('focus', () => {
      setTimeout(() => {
        if (feed) {
          feed.scrollTop = feed.scrollHeight;
          _atBottom = true;
          if (scrollBtn) scrollBtn.classList.add('hidden');
        }
      }, 350);
    });
    _updateSendState(); // init
  }

  // ── Typing indicator broadcast (throttled) ─────────────────────
  let _typingThrottle = 0;
  let _typingStopTimer = null;
  function _notifyTyping() {
    if (typeof P2PSync === 'undefined' || !P2PSync.broadcastTyping) return;
    const now = Date.now();
    if (now - _typingThrottle > 1500) {
      _typingThrottle = now;
      P2PSync.broadcastTyping(true);
    }
    // Auto-send "stopped typing" 2.5s after the last keystroke
    clearTimeout(_typingStopTimer);
    _typingStopTimer = setTimeout(() => {
      if (typeof P2PSync !== 'undefined' && P2PSync.broadcastTyping) {
        P2PSync.broadcastTyping(false);
      }
    }, 2500);
  }

  // ── Typing indicator display ───────────────────────────────────
  const _typingMembers = new Map(); // memberId -> displayName
  let _typingHideTimer = null;
  function handleTypingEvent({ memberId, displayName, isTyping }) {
    if (!memberId || memberId === _session?.memberId) return;
    if (isTyping) {
      _typingMembers.set(memberId, displayName || 'Someone');
    } else {
      _typingMembers.delete(memberId);
    }
    _renderTyping();
  }

  function _renderTyping() {
    if (!typingEl) return;
    const typingText = document.getElementById('typing-text');
    if (_typingMembers.size === 0) {
      typingEl.classList.add('hidden');
      return;
    }
    const names = Array.from(_typingMembers.values());
    let label;
    if (names.length === 1) label = `${names[0]} is typing…`;
    else if (names.length === 2) label = `${names[0]} and ${names[1]} are typing…`;
    else label = `${names.length} people are typing…`;
    if (typingText) typingText.textContent = label;
    typingEl.classList.remove('hidden');

    // Safety auto-hide (in case a "stopped" event is lost)
    clearTimeout(_typingHideTimer);
    _typingHideTimer = setTimeout(() => {
      _typingMembers.clear();
      typingEl.classList.add('hidden');
    }, 6000);
  }

  // ── Send message ──────────────────────────────────────────────
  // Flood guard: max 1 send/sec per device (humans never notice, scripts die).
  let _lastSendAt = 0;
  // Plain http:// (non-localhost) has no WebCrypto: nothing can be encrypted
  // and the relay sees plaintext. The first send of each tab asks for
  // EXPLICIT consent (LAN testing keeps working); the ack lives in
  // sessionStorage, so every fresh tab warns again. Receiving always works.
  // The evil being killed is *silent* plaintext — never the testing itself.
  const INSECURE_ACK_KEY = 'shepu_insecure_ack';
  function _insecureHttp() {
    try {
      const proto = window.location.protocol || '';
      const host = window.location.hostname || '';
      const local = host === 'localhost' || host === '127.0.0.1' || host === '' || proto === 'file:';
      return proto === 'http:' && !local;
    } catch { return false; }
  }
  function _insecureAcked() {
    try { return sessionStorage.getItem(INSECURE_ACK_KEY) === '1'; }
    catch { return false; }
  }

  // Pending outbound payload used by the Retry button: rebuilds the exact
  // wire message (including attachment JSON / ciphertext) instead of just
  // resending the caption as a brand-new plain text message.
  let _retryPayload = null;

  async function sendMessage() {
    if (_recorder) { await _stopVoiceRecording(true); return; }
    const retry = _retryPayload;
    if (_insecureHttp() && !_insecureAcked()) {
      let go = false;
      try {
        go = await UI.confirmDialog({
          title: 'Insecure Connection',
          message: 'This page is on plain http:// — encryption is impossible here, so messages travel as PLAINTEXT. Fine for LAN testing, unsafe for real chats. For real use, open the https:// link (GitHub Pages / Vercel). Send anyway?',
          confirmText: 'Send Anyway',
          danger: true,
        });
      } catch { go = false; }
      if (!go) {
        // Keep the payload: clearing it here threw the queued message away.
        _retryPayload = retry;
        return;
      }
      try { sessionStorage.setItem(INSECURE_ACK_KEY, '1'); } catch {}
    }
    _retryPayload = null;
    const nowSend = Date.now();
    if (!retry && nowSend - _lastSendAt < 1000) {
      UI.toast('info', 'Too Fast', 'Wait a second before sending again.');
      return;
    }
    if (!retry) _lastSendAt = nowSend;
    const text = retry ? (retry.text || '') : input.value.trim();
    const hasAttachment = retry ? (retry.messageType && retry.messageType !== 'text') : !!_pendingAttachment;
    if ((!text && !hasAttachment) || text.length > CONFIG.MAX_MESSAGE_LENGTH) return;

    const msgId     = retry ? retry.id : 'm_' + Crypto.randomBase62(16);
    const replyToId = retry ? (retry.replyToId || null) : (_replyTo?.id || null);
    let finalMessage = retry ? retry.message : text;
    let msgType = retry ? (retry.messageType || 'text') : 'text';

    if (!retry && _pendingAttachment) {
      const at = _pendingAttachment;
      msgType = at.type.startsWith('image/') ? 'image'
              : at.type.startsWith('audio/') ? 'audio' : 'file';
      finalMessage = JSON.stringify({
        text: text,
        fileName: at.name,
        fileType: at.type,
        fileSize: at.size,
        dataUrl:  at.dataUrl,
        durationSec: at.durationSec || 0,
        kind: at.kind || 'file',
      });
      // Clear so the next message doesn't re-attach the same file
      _pendingAttachment = null;
      document.getElementById('attachment-preview-bar')?.classList.add('hidden');
      const _fi = document.getElementById('attach-file-input');
      if (_fi) _fi.value = '';
    }

    // Encrypt new messages ONLY in explicit passphrase mode.
    // The automatic invite-link key is decrypt-only so guests never get blocked.
    // Retried payloads are already in their final wire form.
    if (!retry && typeof Encryption !== 'undefined' && Encryption.shouldEncrypt && Encryption.shouldEncrypt()) {
      let encrypted = null;
      try {
        encrypted = await Encryption.encrypt(finalMessage);
      } catch (err) {
        // Abort the send: the alternative is shipping plaintext into a room the
        // user believes is end-to-end encrypted.
        UI.toast('error', 'Encryption failed', (err && err.message) || 'Message was not sent — it would have travelled unencrypted.');
        return;
      }
      if (typeof encrypted !== 'string' || !encrypted.startsWith('enc:')) {
        UI.toast('error', 'Encryption failed', 'Message was not sent — it would have travelled unencrypted.');
        return;
      }
      finalMessage = encrypted;
    }

    const nowTs     = retry ? (retry.timestamp || new Date().toISOString()) : new Date().toISOString();

    // Optimistic UI
    // UI shows plaintext immediately; wire/persistence uses finalMessage
    // (encrypted only in explicit passphrase mode) so all sides stay consistent.
    const optimisticMsg = {
      id:             msgId,
      createdAt:      nowTs,
      timestamp:      nowTs,
      senderId:       _session.memberId,
      senderName:     _session.displayName,
      senderPicture:  _session.picture || '',
      messageType:    msgType,
      // Non-text attachments render instantly from the built payload.
      // On retry, reuse the originally displayed (decrypted/decoded) text.
      message:        retry ? (retry.displayMessage || finalMessage) : (msgType === 'text' ? text : finalMessage),
      replyTo:        replyToId,
      edited:         false,
      deleted:        false,
      _optimistic:    true,
    };
    const wireMsg = { ...optimisticMsg, message: finalMessage };
    // _optimistic is sender-local UI state — it must NEVER go on the wire.
    // Otherwise receivers treat a real human message as "optimistic" and
    // skip both sound (RoomSounds) and background notification (Notify),
    // while bot messages (no such flag) still beep. That is exactly the
    // "bot বাজে, মানুষ বাজে না" bug in Chrome/Firefox/Brave P2P rooms.
    delete wireMsg._optimistic;

    _pendingIds.add(msgId);
    _appendOptimistic(optimisticMsg);
    // "gan bajau" / "play music" → put the room radio on air (own message).
    // Fires on the send gesture so it works even if the transport is slow.
    if (msgType === 'text' && !retry) _maybeMusicCommand(text);
    input.value = '';
    UI.autoResize(input);
    // Stop typing indicator now that the message is sent
    if (typeof P2PSync !== 'undefined' && P2PSync.broadcastTyping) {
      P2PSync.broadcastTyping(false);
      clearTimeout(_typingStopTimer);
    }
    // reset send btn + counter after send
    if (sendBtn) sendBtn.setAttribute('data-empty', 'true');
    const cc = document.getElementById('chat-char-counter');
    if (cc) { cc.textContent = '0 / 4000'; cc.classList.remove('warn','danger'); }
    cancelReply();
    feed.scrollTop = feed.scrollHeight;

    try {
      const res = await RoomAPI.sendMessage(_room.deploymentUrl, {
        memberId:     _session.memberId,
        sessionToken: _session.sessionToken,
        displayName:  _session.displayName || 'Member',
        picture:      _session.picture || '',
        messageId:    msgId,
        message:      finalMessage,
        messageType:  msgType,
        replyTo:      replyToId,
      });

      if (!res.success) {
        throw new Error(res.error || 'Send failed');
      }

      // Mark sent
      _markOptimisticSent(msgId, optimisticMsg);
      _saveMessageToSheet(wireMsg);
      if (typeof P2PSync !== 'undefined' && P2PSync.broadcastMessage) {
        P2PSync.broadcastMessage(wireMsg);
      } else if (typeof NtfySync !== 'undefined' && NtfySync.publish) {
        NtfySync.publish({ type: 'message', msg: wireMsg }).catch(() => {});
      }

      // Guarantee local storage persistence for sender (encrypted at rest)
      if (_room?.id) {
        if (typeof IDBStorage !== 'undefined') {
          IDBStorage.putMessages([{ ...wireMsg, roomId: _room.id }]).catch(() => {});
        }
        if (typeof Storage !== 'undefined' && Storage.saveRoomMessages) {
          Storage.saveRoomMessages(_room.id, [wireMsg]);
        }
      }

      // ── Shepu-AI mention trigger ──────────────────────────────
      // If the sender mentioned @shepu-ai, generate a bot reply so everyone
      // in the room sees it. Only the sender triggers this (avoiding duplicate
      // replies from each peer); the reply is broadcast/persisted like a normal
      // message.
      if (typeof ShepuBot !== 'undefined' && ShepuBot.isMention(text)) {
        const question = ShepuBot.extractQuestion(text);
        if (question) {
          setTimeout(() => {
            try {
              const pending = ShepuBot.respond(question);
              if (pending && typeof pending.catch === 'function') pending.catch(() => {});
            } catch (e) { /* never break the send path for a bot reply */ }
          }, 400);
        }
      }

    } catch (err) {
      // Mark failed
      _markOptimisticFailed(msgId, err.message);

      // Queue for retry with the exact wire payload so attachments
      // (file JSON, voice notes, images) survive the retry instead of
      // being reduced to a bare caption.
      //
      // Queue EVERY failure, not only network errors: the Retry button looks
      // the message up in this queue and used to DELETE the bubble (and the
      // user's text) whenever the failure was not a network error.
      try {
        Storage.addPendingMessage(_room.id, {
          id: msgId,
          text,
          replyToId,
          timestamp: nowTs,
          message: finalMessage,
          messageType: msgType,
          displayMessage: optimisticMsg.message,
        });
      } catch { /* storage full — the bubble stays, Retry just cannot restore it */ }
    }
  }

  function _appendOptimistic(msg) {
    const el = _makeMessageEl(msg);
    el.id = `opt-${msg.id}`;
    el.classList.add('msg-optimistic');
    const status = el.querySelector('.msg-status');
    if (status) {
      // Clock icon — sending state
      status.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>`;
      status.title = 'Sending…';
      status.classList.add('sending');
    }
    feed.appendChild(el);
    _checkEmpty();
  }

  function _markOptimisticSent(msgId, msgObj) {
    const el = document.getElementById(`opt-${msgId}`) || document.getElementById(`msg-${msgId}`);
    if (el) {
      el.id = `msg-${msgId}`;
      const status = el.querySelector('.msg-status');
      if (status) {
        // Double-check WhatsApp style — sent
        status.innerHTML = `<svg class="tick-icon" width="16" height="10" viewBox="0 0 16 10" fill="none">
          <polyline points="1,5 4,8 9,1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          <polyline points="6,5 9,8 15,1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>`;
        status.title = 'Sent';
        status.classList.remove('sending');
        status.classList.add('sent');
      }
      el.classList.remove('msg-optimistic');
    }
    _pendingIds.delete(msgId);
    if (msgObj) {
      const exists = _messages.find(m => m.id === msgId);
      if (!exists) {
        _messages.push(msgObj);
      }
    }
  }

  function _markOptimisticFailed(msgId, reason) {
    const el = document.getElementById(`opt-${msgId}`);
    if (!el) return;

    el.classList.add('msg-failed');
    const meta = el.querySelector('.msg-meta');
    if (meta) {
      // Show WHY it failed — the reason was accepted but never displayed, so
      // the user only saw "Failed" with no clue what went wrong.
      const safeReason = String(reason || '').replace(/[<>&"]/g, '');
      const reasonHtml = safeReason
        ? `<span class="msg-failed-reason" style="color:var(--muted);font-size:0.72rem;">${safeReason}</span>`
        : '';
      meta.innerHTML = `<span style="color:var(--danger);font-size:0.75rem;display:inline-flex;align-items:center;gap:3px;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"></polygon><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg> Failed</span>
        ${reasonHtml}
        <button class="msg-retry-btn" data-msg-id="${msgId}">Retry</button>`;
      const retryBtn = meta.querySelector('.msg-retry-btn');
      retryBtn?.addEventListener('click', async () => {
        const pending = Storage.getPendingMessages(_room.id).find(m => m.id === msgId);
        if (!pending) {
          // Nothing to resend from — do NOT delete the user's message.
          // Put the text back into the composer so nothing is lost.
          const original = el.querySelector('.msg-text')?.textContent || '';
          if (original) {
            input.value = original;
            UI.autoResize(input);
            input.focus();
            UI.toast('info', 'Message not sent', 'The text was put back in the box — press send to try again.');
          }
          return;
        }
        el.remove();
        _pendingIds.delete(msgId);
        Storage.removePendingMessage(_room.id, msgId);
        if (!pending.message) {
          // Legacy queue entry (pre-payload save): resend the text only.
          input.value = pending.text || '';
          UI.autoResize(input);
          sendMessage();
          return;
        }
        // Reuse the original message id + full wire payload.
        _retryPayload = pending;
        input.value = pending.text || '';
        UI.autoResize(input);
        await sendMessage();
      });
    }
  }

  // ── Context menu ──────────────────────────────────────────────
  function openContextMenu(e, msg) {
    _contextTarget = msg;
    const isMe    = msg.senderId === _session.memberId;
    const isOwner = _session.role === 'owner';
    // Attachments/voice notes are JSON payloads: editing them as text would
    // replace (and corrupt) the whole message. Only plain text is editable.
    const msgType = msg.messageType || 'text';
    const canEdit = isMe && !msg.deleted && msgType === 'text';
    const canDel  = (isMe || isOwner) && !msg.deleted;

    document.getElementById('ctx-edit').style.display   = canEdit ? '' : 'none';
    document.getElementById('ctx-delete').style.display = canDel  ? '' : 'none';

    const x = Math.min(e.clientX, window.innerWidth - 180);
    const y = Math.min(e.clientY, window.innerHeight - 160);
    contextMenu.style.left    = `${x}px`;
    contextMenu.style.top     = `${y}px`;
    contextMenu.style.display = '';
  }

  function closeContextMenu() {
    contextMenu.style.display = 'none';
    _contextTarget = null;
  }

  function _bindContextMenu() {
    document.addEventListener('click', (e) => {
      if (!contextMenu.contains(e.target)) closeContextMenu();
    });

    document.getElementById('ctx-reply').addEventListener('click', () => {
      if (_contextTarget) startReply(_contextTarget);
      closeContextMenu();
    });

    document.getElementById('ctx-copy').addEventListener('click', async () => {
      if (_contextTarget?.message) {
        await UI.copyText(await _copyableText(_contextTarget.message));
        UI.toast('success', 'Copied', 'Message text copied.');
      }
      closeContextMenu();
    });

    document.getElementById('ctx-edit').addEventListener('click', () => {
      if (_contextTarget) openEditModal(_contextTarget);
      closeContextMenu();
    });

    document.getElementById('ctx-delete').addEventListener('click', () => {
      if (_contextTarget) openDeleteModal(_contextTarget);
      closeContextMenu();
    });
  }

  // ── Reply ─────────────────────────────────────────────────────
  function startReply(msg) {
    _replyTo = msg;
    document.getElementById('reply-to-name').textContent    = msg.senderName || 'Unknown';
    document.getElementById('reply-to-preview').textContent = _displayText(msg);
    replyBar.classList.remove('hidden');
    input.focus();
  }

  function cancelReply() {
    _replyTo = null;
    replyBar.classList.add('hidden');
  }

  // ── Edit modal ────────────────────────────────────────────────
  async function openEditModal(msg) {
    const editInput = document.getElementById('edit-input');
    if (!editInput) return;
    const raw = (typeof msg.message === 'string') ? msg.message : '';

    // Encrypted message: show plaintext, never the enc:... ciphertext, and
    // refuse if this device has no key to re-encrypt it (otherwise saving
    // would silently downgrade the message to plaintext).
    if (raw.startsWith('enc:')) {
      const keyActive = (typeof Encryption !== 'undefined' && Encryption.isActive) ? Encryption.isActive() : false;
      if (!keyActive) {
        UI.toast('error', 'Locked message', 'Ask the owner for the invite link or passphrase to edit this message.');
        return;
      }
      _editTarget = msg;
      editInput.value = '';
      editInput.placeholder = 'Decrypting…';
      UI.openModal('edit-modal');
      editInput.focus();
      let plain = '';
      try { plain = await Encryption.decrypt(raw); } catch { plain = ''; }
      if (_editTarget !== msg) return; // modal closed/reopened meanwhile
      if (!plain || plain.startsWith("[Couldn't decrypt")) {
        UI.closeModal('edit-modal');
        UI.toast('error', 'Locked message', 'This encrypted message could not be decrypted on this device.');
        return;
      }
      editInput.value = plain;
      editInput.placeholder = '';
      return;
    }

    _editTarget = msg;
    editInput.value = raw;
    editInput.placeholder = '';
    UI.openModal('edit-modal');
    editInput.focus();
  }

  async function saveEdit() {
    if (!_editTarget) return;
    const newText = document.getElementById('edit-input').value.trim();
    if (!newText) return;

    const saveBtn = document.getElementById('edit-save-btn');
    UI.setLoading(saveBtn, true, 'Saving…');

    try {
      // Re-encrypt edits of encrypted messages. Without this the new text was
      // written to the backend as plaintext, silently downgrading E2EE.
      const wasEncrypted = typeof _editTarget.message === 'string' && _editTarget.message.startsWith('enc:');
      let wireMessage = newText;
      if (wasEncrypted) {
        const canEncrypt = (typeof Encryption !== 'undefined' && Encryption.isActive && Encryption.isActive());
        if (!canEncrypt) throw new Error('Encryption key unavailable — cannot edit this message.');
        wireMessage = await Encryption.encrypt(newText);
        if (typeof wireMessage !== 'string' || !wireMessage.startsWith('enc:')) {
          throw new Error('Encryption failed — message left unchanged.');
        }
      }

      // Always call the backend (including mock://) so edits persist across reloads.
      const res = await RoomAPI.editMessage(_room.deploymentUrl, {
        memberId:     _session.memberId,
        sessionToken: _session.sessionToken,
        messageId:    _editTarget.id,
        message:      wireMessage,
      });
      if (!res.success) throw new Error(res.error || 'Edit failed');

      // Update local
      const updatedMsg = { ..._editTarget, message: wireMessage, edited: true };
      _updateMessageEl(updatedMsg);

      // Broadcast edit to all connected peers in real time
      if (typeof P2PSync !== 'undefined' && P2PSync.broadcastMessage) {
        P2PSync.broadcastMessage(updatedMsg);
      }

      UI.closeModal('edit-modal');
      UI.toast('success', 'Edited', 'Message updated.');

    } catch (err) {
      UI.toast('error', 'Edit Failed', err.message);
    } finally {
      UI.setLoading(saveBtn, false);
    }
  }

  // ── Delete modal ──────────────────────────────────────────────
  function openDeleteModal(msg) {
    _editTarget = msg;
    UI.openModal('delete-modal');
  }

  async function confirmDelete() {
    if (!_editTarget) return;

    const confirmBtn = document.getElementById('delete-confirm-btn');
    UI.setLoading(confirmBtn, true, 'Deleting…');

    try {
      // Always call the backend (including mock://) so deletes persist across reloads.
      const res = await RoomAPI.deleteMessage(_room.deploymentUrl, {
        memberId:     _session.memberId,
        sessionToken: _session.sessionToken,
        messageId:    _editTarget.id,
      });
      if (!res.success) throw new Error(res.error || 'Delete failed');

      const deletedMsg = { ..._editTarget, deleted: true, message: null };
      _updateMessageEl(deletedMsg);

      // Broadcast delete to all connected peers in real time
      if (typeof P2PSync !== 'undefined' && P2PSync.broadcastMessage) {
        P2PSync.broadcastMessage(deletedMsg);
      }

      UI.closeModal('delete-modal');
      UI.toast('success', 'Deleted', 'Message deleted.');

    } catch (err) {
      UI.toast('error', 'Delete Failed', err.message);
    } finally {
      UI.setLoading(confirmBtn, false);
    }
  }

  // ── Modals binding ────────────────────────────────────────────
  function _bindModals() {
    document.getElementById('cancel-reply-btn').addEventListener('click', cancelReply);

    document.getElementById('edit-modal-close').addEventListener('click', () => UI.closeModal('edit-modal'));
    document.getElementById('edit-cancel-btn').addEventListener('click',  () => UI.closeModal('edit-modal'));
    document.getElementById('edit-save-btn').addEventListener('click',    saveEdit);

    document.getElementById('delete-modal-close').addEventListener('click', () => UI.closeModal('delete-modal'));
    document.getElementById('delete-cancel-btn').addEventListener('click',  () => UI.closeModal('delete-modal'));
    document.getElementById('delete-confirm-btn').addEventListener('click', confirmDelete);

    document.getElementById('leave-modal-close').addEventListener('click', () => UI.closeModal('leave-modal'));
    document.getElementById('leave-cancel-btn').addEventListener('click',  () => UI.closeModal('leave-modal'));
    document.getElementById('leave-confirm-btn').addEventListener('click', leaveRoom);
    const leaveRoomName = document.getElementById('leave-room-name');
    if (leaveRoomName) leaveRoomName.textContent = _room?.name || 'this room';
  }

  // ── Scroll ────────────────────────────────────────────────────
  function _bindScroll() {
    if (!feed) return;
    // Mobile keyboard opens → layout viewport shrinks → keep the latest
    // messages visible instead of letting the input hide behind the keyboard.
    try {
      if (window.visualViewport) {
        let vvTimer = null;
        window.visualViewport.addEventListener('resize', () => {
          clearTimeout(vvTimer);
          vvTimer = setTimeout(() => {
            if (_atBottom && feed) feed.scrollTop = feed.scrollHeight;
          }, 120);
        });
      }
    } catch { /* ignore */ }
    feed.addEventListener('scroll', () => {
      _atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
      if (_atBottom) {
        scrollBtn.classList.add('hidden');
        _broadcastSeenForVisible();
      }
    });

    scrollBtn?.addEventListener('click', () => {
      UI.scrollToBottom(feed, true);
      scrollBtn.classList.add('hidden');
      _broadcastSeenForVisible();
    });

    // When returning to window/tab, broadcast seen for newly viewed messages
    window.addEventListener('focus', () => {
      if (_atBottom) _broadcastSeenForVisible();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && _atBottom) {
        _broadcastSeenForVisible();
      }
    });
  }

  // ── Header menu ───────────────────────────────────────────────
  function _bindHeaderMenu() {
    const menuBtn  = document.getElementById('header-menu-btn');
    const menuEl   = document.getElementById('header-menu');

    menuBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !menuEl.classList.contains('hidden');
      menuEl.classList.toggle('hidden', open);
      menuBtn.setAttribute('aria-expanded', String(!open));
    });

    document.addEventListener('click', () => menuEl?.classList.add('hidden'));

    document.getElementById('menu-copy-link')?.addEventListener('click', async () => {
      const url = Rooms.getRoomUrl(_room.id);
      await UI.copyText(url);
      UI.toast('success', 'Copied!', 'Invite link copied to clipboard.');
    });

    document.getElementById('menu-share-link')?.addEventListener('click', async () => {
      const url = Rooms.getRoomUrl(_room.id);
      if (navigator.share) {
        try {
          await navigator.share({ title: `${_room.name} — SHEPU ROOMS`, url });
        } catch (err) {
          // The user dismissed the share sheet (AbortError) — that is not an
          // error, and an unhandled rejection would spam the console.
          const name = (err && err.name) || '';
          if (name !== 'AbortError') {
            try { await UI.copyText(url); UI.toast('info', 'Link copied', 'Sharing was cancelled, so the link was copied instead.'); }
            catch { /* ignore */ }
          }
        }
      } else {
        await UI.copyText(url);
        UI.toast('success', 'Copied', 'Link copied (Web Share not available).');
      }
    });

    document.getElementById('menu-members')?.addEventListener('click', () => {
      openSidebar();
    });

    // Mobile overflow entry: proxies the header button hidden on small
    // screens (see responsive.css) so no function is lost.
    document.getElementById('menu-encryption')?.addEventListener('click', () => {
      document.getElementById('e2ee-toggle-btn')?.click();
    });

    // Same idea for the notification bell: it only exists in the ⋮ menu on
    // a phone. The bell's own toast reports whether it turned on or off.
    document.getElementById('menu-notify')?.addEventListener('click', () => {
      document.getElementById('notify-toggle-btn')?.click();
    });

    document.getElementById('menu-owner-panel')?.addEventListener('click', () => {
      window.location.href = `owner.html?r=${_room.id}`;
    });

    document.getElementById('menu-leave-room')?.addEventListener('click', () => {
      UI.openModal('leave-modal');
    });

    document.getElementById('back-btn')?.addEventListener('click', () => {
      window.location.href = 'index.html';
    });
  }

  // ── Theme (wallpaper) picker ──────────────────────────────────
  function _bindTheme() {
    document.getElementById('room-theme-btn')?.addEventListener('click', () => openThemePicker());
    document.getElementById('menu-theme')?.addEventListener('click', () => openThemePicker());
    document.getElementById('theme-modal-close')?.addEventListener('click', closeThemePicker);
    document.getElementById('theme-modal')?.addEventListener('click', (e) => {
      if (e.target && e.target.id === 'theme-modal') closeThemePicker();
    });
    _bindWallpaperLongPress();
  }

  function openThemePicker() {
    const grid = document.getElementById('theme-grid');
    if (grid) {
      const count = (typeof RoomTheme !== 'undefined') ? RoomTheme.count : 5;
      const current = (_room && _room.theme) || 1;
      grid.innerHTML = '';
      for (let n = 1; n <= count; n++) {
        const b = document.createElement('button');
        b.type = 'button';
        b.title = 'Theme ' + n;
        b.setAttribute('aria-label', 'Theme ' + n);
        b.style.backgroundImage = `url('assets/themes/theme${n}.webp')`;
        if (n === current) b.classList.add('active');
        b.addEventListener('click', () => setTheme(n));
        grid.appendChild(b);
      }
    }
    document.getElementById('theme-modal')?.classList.remove('hidden');
  }

  function closeThemePicker() {
    document.getElementById('theme-modal')?.classList.add('hidden');
  }

  // Set wallpaper for everyone: apply + persist + relay via ntfy.
  // broadcast=false when absorbing a relayed change (no echo loop).
  async function setTheme(n, broadcast = true) {
    if (!_room) return;
    const th = (typeof RoomTheme !== 'undefined') ? RoomTheme.normalize(n) : 1;
    if (typeof RoomTheme !== 'undefined') RoomTheme.apply(th);
    _room.theme = th;
    try { Rooms.updateRoom(_room.id, { theme: th }); } catch {}
    try {
      const s = (typeof Storage !== 'undefined' && Storage.getSession) ? Storage.getSession() : null;
      if (s && s.roomId === _room.id) { s.theme = th; Storage.setSession(s); }
    } catch {}
    document.querySelectorAll('#theme-grid button').forEach((b, i) => {
      b.classList.toggle('active', i + 1 === th);
    });
    if (broadcast && typeof NtfySync !== 'undefined' && NtfySync.publish) {
      try { NtfySync.publish({ type: 'theme', roomId: _room.id, theme: th }); } catch {}
    }
    closeThemePicker();
  }

  // Phone-style 3s long-press on empty wallpaper → theme picker.
  // Ignores presses starting on messages or interactive elements so the
  // message reaction picker / context menu never conflicts.
  function _bindWallpaperLongPress() {
    const feed = document.getElementById('chat-feed');
    if (!feed || feed.dataset.themeLpBound) return;
    feed.dataset.themeLpBound = '1';
    let timer = null, sx = 0, sy = 0, fired = false;
    const LONG_MS = 3000;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const isWallpaper = (t) => {
      if (!t || !t.closest) return true;
      return !t.closest('.msg-row, button, a, input, textarea, select, img, video, audio, .modal, .dropdown-menu');
    };
    const start = (x, y, target) => {
      if (!isWallpaper(target)) return;
      fired = false; sx = x; sy = y;
      cancel();
      timer = setTimeout(() => {
        timer = null; fired = true;
        try { if (navigator.vibrate) navigator.vibrate(30); } catch {}
        openThemePicker();
      }, LONG_MS);
    };
    const moved = (x, y) => {
      if (timer && Math.hypot(x - sx, y - sy) > 12) cancel();
    };
    feed.addEventListener('touchstart', (e) => {
      const t = e.touches[0]; if (t) start(t.clientX, t.clientY, e.target);
    }, { passive: true });
    feed.addEventListener('touchmove', (e) => {
      const t = e.touches[0]; if (t) moved(t.clientX, t.clientY);
    }, { passive: true });
    feed.addEventListener('touchend', cancel);
    feed.addEventListener('touchcancel', cancel);
    feed.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      start(e.clientX, e.clientY, e.target);
    });
    feed.addEventListener('mousemove', (e) => { if (timer) moved(e.clientX, e.clientY); });
    feed.addEventListener('mouseup', cancel);
    feed.addEventListener('mouseleave', cancel);
    // Swallow the synthetic contextmenu some browsers fire after long-press
    feed.addEventListener('contextmenu', (e) => {
      if (fired) { e.preventDefault(); fired = false; }
    });
  }

  // ── Sidebar ───────────────────────────────────────────────────
  function openSidebar() {
    document.getElementById('chat-sidebar')?.classList.add('open');
    document.getElementById('sidebar-overlay').style.display = '';
  }

  function closeSidebar() {
    document.getElementById('chat-sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay').style.display = 'none';
  }

  function _bindSidebar() {
    document.getElementById('members-toggle-btn')?.addEventListener('click', openSidebar);
    document.getElementById('close-sidebar-btn')?.addEventListener('click',  closeSidebar);
    document.getElementById('sidebar-overlay')?.addEventListener('click',    closeSidebar);
  }

  // ── Render members list ───────────────────────────────────────
  // ── Member directory: merged roster from ALL sources ──────────
  // fetch (local store) + P2P host roster + ntfy presence beacons.
  // Keyed by memberId, keeps the freshest sighting → list is truthful
  // even when members are on different devices.
  const _memberDir = new Map(); // memberId -> { memberId, displayName, picture, role, status, lastSeenMs }
  const ONLINE_WINDOW_MS = 45000; // seen within 45s = online

  function _normTs(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v; // sec → ms
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  function _isOnlineEntry(e) {
    if (!e) return false;
    if (e.status === 'online' && Date.now() - (e.lastSeenMs || 0) < 120000) return true;
    return Date.now() - (e.lastSeenMs || 0) < ONLINE_WINDOW_MS;
  }

  // Merge a member list into the directory. touch=true marks every entry
  // as "seen right now" (used for live presence beacons).
  function mergeMembers(members, { touch = false } = {}) {
    if (!Array.isArray(members)) return;
    const now = Date.now();
    members.forEach(m => {
      if (!m) return;
      const id = m.memberId || m.id;
      if (!id) return;
      const incoming = {
        memberId:    id,
        displayName: m.displayName || m.name || 'Unknown',
        picture:     m.picture || '',
        role:        m.role || 'member',
        status:      m.status || '',
        lastSeenMs:  touch ? now : (_normTs(m.lastSeen) || _normTs(m.lastActive) || 0),
      };
      const prev = _memberDir.get(id);
      // Never lose a name/picture to an emptier update; never go backwards in time.
      if (prev) {
        if (!incoming.displayName || incoming.displayName === 'Unknown') incoming.displayName = prev.displayName;
        if (!incoming.picture) incoming.picture = prev.picture;
        if (prev.role === 'owner') incoming.role = 'owner';
        if ((prev.lastSeenMs || 0) > (incoming.lastSeenMs || 0) && !touch) {
          incoming.lastSeenMs = prev.lastSeenMs;
          if (!incoming.status) incoming.status = prev.status;
        }
      }
      _memberDir.set(id, incoming);
      if (incoming.displayName) _memberMap.set(id, incoming.displayName);
    });
    _renderMemberDir();
  }

  function renderMembers(members) {
    mergeMembers(members);
  }

  function _renderMemberDir() {
    const list = document.getElementById('member-list');
    if (!list) return;

    const all = Array.from(_memberDir.values()).map(e => ({
      ...e, online: _isOnlineEntry(e),
    })).sort((a, b) => {
      if (!!a.online !== !!b.online) return a.online ? -1 : 1;
      if ((a.role === 'owner') !== (b.role === 'owner')) return a.role === 'owner' ? -1 : 1;
      return String(a.displayName || '').localeCompare(String(b.displayName || ''));
    });

    const onlineCount = all.filter(e => e.online).length;
    const countEl = document.getElementById('online-count');
    if (countEl) countEl.textContent = onlineCount;

    list.innerHTML = '';
    let offlineHeaderShown = false;
    all.forEach(m => {
      // Subtle section divider between online and offline groups
      if (!m.online && !offlineHeaderShown && all.some(e => e.online)) {
        offlineHeaderShown = true;
        const div = document.createElement('div');
        div.className = 'member-section-label';
        div.textContent = 'Offline';
        list.appendChild(div);
      }
      const isMe = _session && m.memberId === _session.memberId;
      const name = m.displayName || 'Unknown';
      const pic  = m.picture || '';

      const safePic = (typeof pic === 'string' && /^(data:image\/|https?:\/\/|ai\/|assets\/)/i.test(pic.trim())) ? pic.trim() : '';
      const avatarHtml = safePic
        ? `<div class="member-avatar has-img ${m.online ? 'is-online' : ''}" aria-hidden="true"><img src="${escapeHtml(safePic)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.parentElement.classList.remove('has-img');this.remove();" /></div>`
        : `<div class="member-avatar ${m.online ? 'is-online' : ''}" aria-hidden="true">${escapeHtml(UI.getInitial(name))}</div>`;

      const lastSeenText = m.online
        ? (m.role === 'owner' ? 'Owner · Online' : 'Online')
        : (m.lastSeenMs ? `Last seen ${UI.relativeTime(m.lastSeenMs)}` : 'Offline');

      const el = document.createElement('div');
      el.className = 'member-row' + (m.online ? '' : ' is-offline');
      el.setAttribute('role', 'listitem');
      el.innerHTML = `
        ${avatarHtml}
        <div class="member-info">
          <div class="member-name">${escapeHtml(name)}${isMe ? '<span class="member-pill me">you</span>' : ''}
            ${m.role === 'owner' ? '<span class="member-pill owner">Owner</span>' : ''}
          </div>
          <div class="member-status">
            <span class="status-dot ${m.online ? 'online' : 'offline'}" aria-hidden="true"></span>
            <span>${escapeHtml(lastSeenText)}</span>
          </div>
        </div>
        ${!isMe && m.online ? `
          <div class="member-call-actions">
            <button class="member-call-btn audio-btn" title="Voice Call ${escapeHtml(name)}" aria-label="Voice Call">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
            </button>
            <button class="member-call-btn video video-btn" title="Video Call ${escapeHtml(name)}" aria-label="Video Call">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
            </button>
          </div>
        ` : ''}
        ${_session && _session.role === 'owner' && m.memberId !== _session.memberId ? `
          <button class="btn btn-icon btn-ghost member-kick-btn" data-member-id="${escapeHtml(m.memberId)}" title="Remove" aria-label="Remove member"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
        ` : ''}
      `;

      el.querySelector('.member-call-btn.audio-btn')?.addEventListener('click', () => {
        if (window.CallManager) CallManager.startCall('audio', m.memberId, name);
      });
      el.querySelector('.member-call-btn.video-btn')?.addEventListener('click', () => {
        if (window.CallManager) CallManager.startCall('video', m.memberId, name);
      });
      el.querySelector('.member-kick-btn')?.addEventListener('click', () => ownerKickMember(m.memberId, name));
      list.appendChild(el);
    });
  }

  // ── Owner ops ─────────────────────────────────────────────────
  async function ownerOp(op, extra = {}, successText = '') {
    try {
      const res = await RoomAPI.roomOp(_room.deploymentUrl, {
        memberId:     _session.memberId,
        sessionToken: _session.sessionToken,
        op, ...extra,
      });
      if (!res.success) throw new Error(res.error || 'Operation failed');
      UI.toast('success', 'Done', successText || `Room ${op} applied.`);
      return true;
    } catch (err) {
      UI.toast('error', 'Failed', err.message);
      return false;
    }
  }

  async function ownerKickMember(targetId, name) {
    const okKick = await UI.confirmDialog({
      title: `Remove ${name}?`,
      message: 'They will leave this room immediately.',
      confirmText: 'Remove',
      danger: true,
    });
    if (!okKick) return;
    // Only confirm removal when the backend actually accepted it; the old
    // code printed "has been removed" even when the request failed.
    await ownerOp('remove_member', { targetId }, `${name} has been removed.`);
  }

  // ── Leave room ────────────────────────────────────────────────
  async function leaveRoom() {
    try {
      await RoomAPI.leave(_room.deploymentUrl, {
        memberId:     _session.memberId,
        sessionToken: _session.sessionToken,
      });
    } catch { /* non-critical */ }

    Storage.clearSession();
    Storage.clearCurrentRoom();
    window.location.href = 'index.html';
  }

  // ── Set room status in header ─────────────────────────────────
  function setStatus(text, online = true) {
    const dot  = document.getElementById('status-dot');
    const span = document.getElementById('room-subtitle-text');
    if (dot) {
      dot.classList.toggle('online',  online);
      dot.classList.toggle('offline', !online);
    }
    if (span) span.textContent = text;
  }

  // Enable / disable the composer. A locked room is read-only: the owner
  // applied the lock on ANOTHER device, so this device has to react to the
  // relayed status instead of keeping an active composer.
  function setComposerEnabled(enabled) {
    try {
      if (input) {
        input.disabled = !enabled;
        if (enabled) {
          const saved = input.getAttribute('data-locked-placeholder');
          if (saved) {
            input.setAttribute('placeholder', saved);
            input.removeAttribute('data-locked-placeholder');
          }
        } else if (!input.getAttribute('data-locked-placeholder')) {
          input.setAttribute('data-locked-placeholder', input.getAttribute('placeholder') || '');
          input.setAttribute('placeholder', 'This room is read-only');
        }
      }
      const sb = document.getElementById('send-btn');
      if (sb) sb.disabled = !enabled;
    } catch { /* the composer is optional on some pages */ }
  }

  // ── Room unavailable overlay ──────────────────────────────────
  function showUnavailable(reason) {
    document.getElementById('room-unavailable-overlay')?.classList.remove('hidden');
    const reasonEl = document.getElementById('unavail-reason');
    if (reasonEl) reasonEl.textContent = reason || 'This room is currently unavailable.';
    // Disable input
    if (input) input.disabled = true;
    if (sendBtn) sendBtn.disabled = true;
  }

// ── Attachments Handling ──────────────────────────────────────
  // ── Shared attachment preview (file picker + special emoji) ───
  // Shows the preview bar so the user can add a caption and press Send.
  function _showAttachmentPreview({ name, size, type, dataUrl }) {
    if (!name || !dataUrl) return;
    _pendingAttachment = {
      name: name,
      size: size || 0,
      // File.type is EMPTY for most non-web extensions (.zip, .apk, .bin…).
      // Claiming 'image/png' made the sender send messageType:'image' and
      // the receiver render a broken <img> with no download link.
      type: type || 'application/octet-stream',
      dataUrl: dataUrl,
      kind: 'image',
    };
    try {
      const previewBar = document.getElementById('attachment-preview-bar');
      const thumbEl    = document.getElementById('attachment-thumb');
      const fileIconEl = document.getElementById('attachment-file-icon');
      const nameEl     = document.getElementById('attachment-name');
      const sizeEl     = document.getElementById('attachment-size');
      if (nameEl) nameEl.textContent = name;
      if (sizeEl) sizeEl.textContent = UI.formatBytes ? UI.formatBytes(size || 0) : (Math.round((size || 0) / 1024) + ' KB');
      if (String(type || '').startsWith('image/')) {
        if (thumbEl) { thumbEl.src = dataUrl; thumbEl.classList.remove('hidden'); }
        if (fileIconEl) fileIconEl.style.display = 'none';
      } else {
        if (thumbEl) thumbEl.classList.add('hidden');
        if (fileIconEl) fileIconEl.style.display = '';
      }
      if (previewBar) previewBar.classList.remove('hidden');
      if (input) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus({ preventScroll: true });
      }
    } catch {}
  }

  function _bindAttachments() {
    const attachBtn   = document.getElementById('attach-btn');
    const fileInput   = document.getElementById('attach-file-input');
    const previewBar  = document.getElementById('attachment-preview-bar');
    const thumbEl     = document.getElementById('attachment-thumb');
    const fileIconEl  = document.getElementById('attachment-file-icon');
    const nameEl      = document.getElementById('attachment-name');
    const sizeEl      = document.getElementById('attachment-size');
    const cancelBtn   = document.getElementById('cancel-attachment-btn');

    if (!attachBtn || !fileInput) return;

    attachBtn.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (!file) return;

      if (file.size > 5 * 1024 * 1024) {
        UI.toast('error', 'File Too Large', 'Maximum attachment size is 5MB.');
        fileInput.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        _showAttachmentPreview({
          name: file.name,
          size: file.size,
          type: file.type,
          dataUrl: e.target.result,
        });
      };
      reader.readAsDataURL(file);
    });

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        _pendingAttachment = null;
        fileInput.value = '';
        previewBar.classList.add('hidden');
        if (input) input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }

    // Lightbox modal: backdrop click / close button / Esc to close
    const lightbox = document.getElementById('lightbox-modal');
    if (lightbox) {
      lightbox.addEventListener('click', (e) => {
        if (e.target === lightbox) closeLightbox();
      });
      document.getElementById('lightbox-close')?.addEventListener('click', (e) => {
        e.stopPropagation();
        closeLightbox();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !lightbox.classList.contains('hidden')) closeLightbox();
      });
    }
  }

  function _fmtDuration(totalSec) {
    const s = Math.max(0, Math.round(totalSec || 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // ── Voice Messages (mic → MediaRecorder → audio attachment) ─────
  let _recorder = null;       // MediaRecorder while recording
  let _recChunks = [];
  let _recStartedAt = 0;
  let _recTimer = null;
  let _recStream = null;

  function _bindVoice() {
    const micBtn = document.getElementById('voice-btn');
    if (!micBtn) return;
    micBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (_recorder) { await _stopVoiceRecording(false); return; }
      await _startVoiceRecording(micBtn);
    });
  }

  function _setMicUI(recording, secs) {
    const micBtn = document.getElementById('voice-btn');
    if (micBtn) micBtn.classList.toggle('recording', !!recording);
    if (input) {
      if (recording) {
        if (!input.dataset.ph) input.dataset.ph = input.placeholder || '';
        input.placeholder = `● Recording ${ _fmtDuration(secs || 0)}… tap mic to stop`;
      } else if (input.dataset.ph !== undefined) {
        input.placeholder = input.dataset.ph;
        delete input.dataset.ph;
      }
    }
  }

  function _micErrorText(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Microphone blocked — allow mic access in the address bar/site settings, then try again.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No microphone was found on this device.';
      case 'NotReadableError':
      case 'TrackStartError':
        return 'The microphone is busy in another app or tab. Close it and retry.';
      case 'AbortError':
        return 'The microphone request was interrupted. Try again.';
      default:
        return (err && err.message) || 'Please allow microphone access to record voice.';
    }
  }

  async function _startVoiceRecording(micBtn) {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        UI.toast('error', 'Not supported', 'Voice recording is not supported in this browser.');
        return;
      }
      if (typeof MediaRecorder === 'undefined') {
        UI.toast('error', 'Not supported', 'MediaRecorder is not available in this browser.');
        return;
      }
      _recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      UI.toast('error', 'Mic unavailable', _micErrorText(err));
      return;
    }
    try {
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find(t => {
        try { return MediaRecorder.isTypeSupported(t); } catch { return false; }
      }) || '';
      _recorder = mime ? new MediaRecorder(_recStream, { mimeType: mime }) : new MediaRecorder(_recStream);
    } catch (err) {
      _recStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      _recStream = null;
      UI.toast('error', 'Recording failed', err.message || 'Could not start recorder.');
      return;
    }
    _recChunks = [];
    _recStartedAt = Date.now();
    _recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size) _recChunks.push(ev.data); };
    _recorder.onstop = () => { _finishVoiceRecording(); };
    _recorder.start(250);
    _setMicUI(true, 0);
    clearInterval(_recTimer);
    _recTimer = setInterval(() => {
      const secs = (Date.now() - _recStartedAt) / 1000;
      _setMicUI(true, secs);
      if (secs >= 120) _stopVoiceRecording(false); // 2-min cap
    }, 500);
  }

  async function _stopVoiceRecording(sendAfter) {
    clearInterval(_recTimer);
    _recTimer = null;
    const rec = _recorder;
    _recorder = null;
    _setMicUI(false);
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch {}
    } else {
      _finishVoiceRecording();
    }
    if (_recStream) {
      _recStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      _recStream = null;
    }
    if (sendAfter) {
      // Wait for the FileReader to finish building the attachment. A fixed
      // 350ms timer sent the caption as a SEPARATE message (and left the
      // voice note attached to the NEXT message) whenever the reader was
      // slower than the timer.
      const send = () => { try { sendMessage(); } catch (e) { /* ignore */ } };
      if (_pendingAttachment) { send(); return; }
      _voiceSendResolver = send;
      // Safety net — never wait forever if the reader never calls back.
      setTimeout(() => {
        if (_voiceSendResolver === send) { _voiceSendResolver = null; send(); }
      }, 8000);
    }
  }

  function _finishVoiceRecording() {
    clearInterval(_recTimer);
    _recTimer = null;
    _setMicUI(false);
    const chunks = _recChunks;
    _recChunks = [];
    if (!chunks.length) {
      // Nothing was recorded — drop the pending send instead of sending an
      // empty message.
      if (_voiceSendResolver) { _voiceSendResolver = null; }
      return;
    }
    const mime = (_recorder && _recorder.mimeType) || (chunks[0] && chunks[0].type) || 'audio/webm';
    const blob = new Blob(chunks, { type: mime });
    if (blob.size > 5 * 1024 * 1024) {
      UI.toast('error', 'Too long', 'Voice message exceeds 5MB. Try a shorter recording.');
      return;
    }
    const secs = (Date.now() - _recStartedAt) / 1000;
    const ext = mime.includes('mp4') ? 'm4a' : 'webm';
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`;
    const reader = new FileReader();
    reader.onload = (e) => {
      _pendingAttachment = {
        name: `voice_${stamp}.${ext}`,
        size: blob.size,
        type: mime.split(';')[0],
        dataUrl: e.target.result,
        durationSec: Math.round(secs),
        kind: 'voice',
      };
      // Reuse the attachment preview bar
      const previewBar = document.getElementById('attachment-preview-bar');
      const thumbEl    = document.getElementById('attachment-thumb');
      const fileIconEl = document.getElementById('attachment-file-icon');
      const nameEl     = document.getElementById('attachment-name');
      const sizeEl     = document.getElementById('attachment-size');
      if (nameEl) nameEl.textContent = _pendingAttachment.name;
      if (sizeEl) sizeEl.textContent = `${_fmtDuration(secs)} · ${UI.formatBytes ? UI.formatBytes(blob.size) : Math.round(blob.size/1024) + ' KB'}`;
      if (thumbEl) thumbEl.classList.add('hidden');
      if (fileIconEl) fileIconEl.style.display = '';
      if (previewBar) previewBar.classList.remove('hidden');
      if (input) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus({ preventScroll: true });
      }
      // The attachment is ready — release the waiting send (if any).
      if (_voiceSendResolver) {
        const r = _voiceSendResolver;
        _voiceSendResolver = null;
        try { r(); } catch (e) { /* ignore */ }
      }
    };
    reader.readAsDataURL(blob);
  }

  // ── Emoji Picker Popover (custom set only) ────────────────────
  // No system/default emojis here: everything comes from assets/emoji.
  // Search bar on top; "All" selected by default with other categories
  // beside it as headings. Picking inserts the unicode char (storage stays
  // unicode) and the renderer swaps it for the custom image everywhere.
  function _bindEmojis() {
    const emojiBtn = document.getElementById('emoji-btn');
    const popover  = document.getElementById('emoji-popover');
    if (!emojiBtn || !popover) return;
    const searchInput = document.getElementById('emoji-search-input');
    const catRow      = document.getElementById('emoji-cat-row');
    const resultsEl   = document.getElementById('emoji-results');
    const loadingEl   = document.getElementById('emoji-loading');
    if (!searchInput || !catRow || !resultsEl) return;

    // ── Normal / Special set switcher ───────────────────────────
    // 3-dot menu beside the search bar. Special mode swaps the search bar
    // for a password input; the ZIP unlocks in memory only.
    const modeBtn    = document.getElementById('emoji-mode-btn');
    const modeMenu   = document.getElementById('emoji-mode-menu');
    const searchIcon = document.getElementById('emoji-search-icon');
    const searchWrap = searchInput.closest('.emoji-search-wrap');
    const passWrap   = document.getElementById('emoji-pass-wrap');
    const passInput  = document.getElementById('emoji-pass-input');
    const unlockBtn  = document.getElementById('emoji-unlock-btn');
    const passStatus = document.getElementById('emoji-pass-status');
    const hasSpecial = !!(modeBtn && modeMenu && passWrap && passInput && unlockBtn
      && typeof SpecialEmoji !== 'undefined');

    let activeCat = 'All';
    let query = '';

    function setPassStatus(msg, kind) {
      if (!passStatus) return;
      if (!msg) { passStatus.classList.add('hidden'); passStatus.textContent = ''; return; }
      passStatus.classList.remove('hidden');
      passStatus.textContent = msg;
      passStatus.dataset.kind = kind || 'info';
    }

    function specialButton(item) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-btn emoji-btn-custom';
      btn.title = item.name;
      btn.setAttribute('aria-label', item.name);
      const img = document.createElement('img');
      img.src = item.url;
      img.alt = item.name;
      img.title = item.name;
      img.loading = 'lazy';
      img.draggable = false;
      img.className = 'custom-emoji-picker';
      btn.appendChild(img);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // Behave exactly like a normal emoji: insert a shortcode as plain
        // text at the cursor (popover stays open for multi-pick). The
        // renderer swaps it for an inline image at send/display time.
        try {
          if (typeof SpecialEmoji !== 'undefined' && SpecialEmoji.shortcodeFor) {
            insertEmoji(SpecialEmoji.shortcodeFor(item));
          }
        } catch {}
      });
      return btn;
    }

    function renderSpecial() {
      resultsEl.innerHTML = '';
      if (!hasSpecial) return;
      if (!SpecialEmoji.isUnlocked()) {
        const hint = document.createElement('div');
        hint.className = 'emoji-empty';
        hint.textContent = 'Enter the password above to view special emojis.';
        resultsEl.appendChild(hint);
        return;
      }
      const items = SpecialEmoji.getItems();
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'emoji-empty';
        empty.textContent = 'No special emojis found.';
        resultsEl.appendChild(empty);
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      items.forEach(it => grid.appendChild(specialButton(it)));
      resultsEl.appendChild(grid);
    }

    function paintModeMenu() {
      if (!modeMenu) return;
      const mode = hasSpecial ? SpecialEmoji.getMode() : 'normal';
      modeMenu.querySelectorAll('.emoji-mode-item').forEach(b => {
        const on = b.dataset.mode === mode;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        const chk = b.querySelector('.emoji-mode-check');
        if (chk) chk.textContent = on ? '✓' : '';
      });
      if (modeBtn) modeBtn.setAttribute('aria-expanded', (!modeMenu.classList.contains('hidden')) ? 'true' : 'false');
    }

    function closeModeMenu() {
      if (modeMenu) modeMenu.classList.add('hidden');
      if (modeBtn) modeBtn.setAttribute('aria-expanded', 'false');
    }

    function applyMode(mode) {
      if (!hasSpecial) return;
      SpecialEmoji.setMode(mode);
      const special = SpecialEmoji.getMode() === 'special';
      if (searchInput) searchInput.classList.toggle('hidden', special);
      if (searchIcon) searchIcon.classList.toggle('hidden', special);
      if (catRow) catRow.classList.toggle('hidden', special);
      if (passWrap) passWrap.classList.toggle('hidden', !special);
      if (!special) setPassStatus('');
      paintModeMenu();
      if (special) {
        if (passInput && !SpecialEmoji.isUnlocked()) {
          setTimeout(() => { try { passInput.focus({ preventScroll: true }); } catch {} }, 50);
        }
        renderSpecial();
      } else {
        query = '';
        if (searchInput) searchInput.value = '';
        renderResults();
      }
    }

    async function doUnlock() {
      if (!hasSpecial || SpecialEmoji.isBusy()) return;
      const pw = (passInput && passInput.value) || '';
      if (!pw) { setPassStatus('Please enter the password.', 'error'); return; }
      try { unlockBtn.disabled = true; } catch {}
      setPassStatus('Unlocking…', 'info');
      const res = await SpecialEmoji.unlock(pw, (frac, label) => {
        setPassStatus(label || `Unlocking… ${Math.round((frac || 0) * 100)}%`, 'info');
      });
      try { unlockBtn.disabled = false; } catch {}
      try { if (passInput) passInput.value = ''; } catch {}
      if (res && res.ok) {
        setPassStatus(`Unlocked ${res.count} special emojis.`, 'ok');
        renderSpecial();
      } else {
        setPassStatus((res && res.error) || 'Unlock failed.', 'error');
      }
    }

    if (hasSpecial) {
      modeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        modeMenu.classList.toggle('hidden');
        paintModeMenu();
      });
      modeMenu.addEventListener('click', (e) => e.stopPropagation());
      modeMenu.querySelectorAll('.emoji-mode-item').forEach(b => {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          closeModeMenu();
          applyMode(b.dataset.mode);
        });
      });
      unlockBtn.addEventListener('click', (e) => { e.stopPropagation(); doUnlock(); });
      passInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doUnlock(); }
        e.stopPropagation();
      });
      passInput.addEventListener('click', (e) => e.stopPropagation());
      // Start on Normal (default) — restores search + previous emojis.
      applyMode('normal');
    }

    function insertEmoji(unicode) {
      if (!unicode || !input) return;
      const start = input.selectionStart ?? input.value.length;
      const end   = input.selectionEnd ?? input.value.length;
      const newPos = start + unicode.length; // UTF-16 units: surrogate pairs never split
      if (typeof input.setRangeText === 'function') {
        input.setRangeText(unicode, start, end, 'end');
      } else {
        input.value = input.value.substring(0, start) + unicode + input.value.substring(end);
        try { input.selectionStart = input.selectionEnd = newPos; } catch {}
      }
      input.focus({ preventScroll: true });
      try { input.selectionStart = input.selectionEnd = newPos; } catch {}
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      UI.autoResize(input);
    }

    function renderCats() {
      catRow.innerHTML = '';
      const cats = (typeof CustomEmoji !== 'undefined') ? CustomEmoji.categories() : ['All'];
      cats.forEach(cat => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'emoji-cat-btn' + (cat === activeCat ? ' active' : '');
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', cat === activeCat ? 'true' : 'false');
        btn.textContent = cat === 'All' ? 'All' : CustomEmoji.prettyName(cat);
        btn.title = cat === 'All' ? 'All emojis' : CustomEmoji.prettyName(cat);
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          activeCat = cat;
          renderCats();
          renderResults();
        });
        catRow.appendChild(btn);
      });
    }

    function emojiButton(item) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'emoji-btn emoji-btn-custom';
      btn.title = item.name;
      btn.setAttribute('aria-label', item.name);
      const img = document.createElement('img');
      img.src = item.src;
      img.alt = item.unicode;
      img.title = item.name;
      img.loading = 'lazy';
      img.draggable = false;
      img.className = 'custom-emoji-picker';
      btn.appendChild(img);
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        insertEmoji(item.unicode);
      });
      return btn;
    }

    function renderResults() {
      resultsEl.innerHTML = '';
      // Special mode has its own renderer (password grid, no search).
      if (typeof SpecialEmoji !== 'undefined' && SpecialEmoji.getMode() === 'special') {
        renderSpecial();
        return;
      }
      const q = (query || '').trim();
      if (q) {
        // Search across the active category (All = everything)
        const hits = CustomEmoji.search(q, activeCat);
        if (!hits.length) {
          const empty = document.createElement('div');
          empty.className = 'emoji-empty';
          empty.textContent = 'No emojis found.';
          resultsEl.appendChild(empty);
          return;
        }
        const grid = document.createElement('div');
        grid.className = 'emoji-grid';
        hits.slice(0, 400).forEach(it => grid.appendChild(emojiButton(it)));
        if (hits.length > 400) {
          const more = document.createElement('div');
          more.className = 'emoji-more';
          more.textContent = `Showing 400 of ${hits.length} — keep typing to narrow.`;
          resultsEl.appendChild(more);
        }
        resultsEl.appendChild(grid);
        return;
      }
      if (activeCat === 'All') {
        // Grouped sections with category headings
        CustomEmoji.categories().forEach(cat => {
          if (cat === 'All') return;
          const items = CustomEmoji.itemsByCategory(cat);
          if (!items.length) return;
          const title = document.createElement('div');
          title.className = 'emoji-section-title';
          title.textContent = CustomEmoji.prettyName(cat);
          resultsEl.appendChild(title);
          const grid = document.createElement('div');
          grid.className = 'emoji-grid';
          items.forEach(it => grid.appendChild(emojiButton(it)));
          resultsEl.appendChild(grid);
        });
        return;
      }
      const items = CustomEmoji.itemsByCategory(activeCat);
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'emoji-empty';
        empty.textContent = 'No emojis in this category.';
        resultsEl.appendChild(empty);
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'emoji-grid';
      items.forEach(it => grid.appendChild(emojiButton(it)));
      resultsEl.appendChild(grid);
    }

    // Harden against browser/password-manager autofill (Chrome ignores
    // plain autocomplete="off" in some cases).
    try {
      searchInput.setAttribute('autocomplete', 'new-password');
      searchInput.setAttribute('autocapitalize', 'off');
      searchInput.setAttribute('autocorrect', 'off');
      searchInput.setAttribute('spellcheck', 'false');
      // Random name per page load: autofill heuristics can't profile-match it
      searchInput.setAttribute('name', 'esq_' + Math.random().toString(36).slice(2, 8));
      searchInput.value = '';
    } catch {}

    // readonly-until-focus: browsers won't autofill a readonly field,
    // so saved emails never pop into the emoji search bar.
    const unlockSearch = () => {
      try {
        if (searchInput.hasAttribute('readonly')) searchInput.removeAttribute('readonly');
      } catch {}
    };
    searchInput.addEventListener('pointerdown', unlockSearch);
    searchInput.addEventListener('focus', unlockSearch);

    let searchTimer = null;
    let userTypedSearch = false;
    searchInput.addEventListener('keydown', () => { userTypedSearch = true; });
    searchInput.addEventListener('input', () => {
      // Only treat keyboard-driven input as real typing (autofill may not fire this)
      userTypedSearch = true;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        query = searchInput.value || '';
        renderResults();
      }, 120);
    });
    // If autofill sneaked text in without typing, wipe it when opening the picker.
    // Email-like text is never a legit emoji search, so always purge that.
    const purgeAutofill = () => {
      try {
        const v = searchInput.value || '';
        if ((v && !userTypedSearch) || v.includes('@')) {
          searchInput.value = '';
          if (query) { query = ''; renderResults(); }
        }
      } catch {}
    };
    searchInput.addEventListener('click', (e) => e.stopPropagation());

    async function boot() {
      try {
        if (typeof CustomEmoji !== 'undefined') await CustomEmoji.load();
      } catch (err) {
        console.warn('[Chat] custom emoji load failed:', err && err.message);
      }
      if (loadingEl) loadingEl.style.display = 'none';
      renderCats();
      renderResults();
    }
    boot();

    emojiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      popover.classList.toggle('hidden');
      if (!popover.classList.contains('hidden')) {
        closeModeMenu();
        const special = (typeof SpecialEmoji !== 'undefined') && SpecialEmoji.getMode() === 'special';
        if (special && passInput) {
          setTimeout(() => { try { passInput.focus({ preventScroll: true }); } catch {} }, 50);
        } else if (searchInput) {
          unlockSearch();
          purgeAutofill();
          setTimeout(() => searchInput.focus({ preventScroll: true }), 50);
        }
      }
    });

    document.addEventListener('click', (e) => {
      if (!popover.contains(e.target) && e.target !== emojiBtn && !emojiBtn.contains(e.target)) {
        popover.classList.add('hidden');
      }
    });
  }

  // ── E2EE Passphrase Handling ──────────────────────────────────
  // Reflect auto-derived E2EE (from room secret) on the header shield button.
  function setEncryptionStatus(active) {
    const toggleBtn = document.getElementById('e2ee-toggle-btn');
    if (!toggleBtn) return;
    if (active) {
      toggleBtn.style.color = 'var(--accent-2)';
      toggleBtn.title = 'End-to-end encryption is ON (room key)';
      toggleBtn.classList.add('e2ee-active');
    } else {
      toggleBtn.style.color = '';
      toggleBtn.title = 'Encryption Settings';
      toggleBtn.classList.remove('e2ee-active');
    }
  }

  // ── Notification ON/OFF toggle (header bell) ──────────────────
  // Default ON: sounds + background notifications work. Click → OFF and
  // everything goes silent. Click again → back ON. Choice persists.
  function _bindNotifications() {
    const btn = document.getElementById('notify-toggle-btn');
    if (!btn || typeof Notify === 'undefined' || !Notify.isSupported()) {
      if (btn) btn.style.display = 'none';
      const menuItem = document.getElementById('menu-notify');
      if (menuItem) menuItem.style.display = 'none';
      return;
    }
    // ON = normal bell, OFF = bell with a slash so the state is obvious.
    const ICON_ON = btn.innerHTML;
    const ICON_OFF = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13.73 21a2 2 0 0 1-3.46 0"></path><path d="M18.63 13A17.89 17.89 0 0 1 18 8"></path><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"></path><path d="M18 8a6 6 0 0 0-9.33-5"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';
    const paint = () => {
      const on = Notify.isSoundOn();
      btn.innerHTML = on ? ICON_ON : ICON_OFF;
      btn.style.color = on ? 'var(--accent-2)' : 'var(--muted)';
      btn.title = on ? 'Notifications on' : 'Notifications off';
      btn.setAttribute('aria-label', on ? 'Turn notifications off' : 'Turn notifications on');
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const menuText = document.getElementById('menu-notify-text');
      if (menuText) menuText.textContent = on ? 'Notifications on' : 'Notifications off';
    };
    paint();
    btn.addEventListener('click', async () => {
      if (Notify.isSoundOn()) {
        // ON → OFF: mute sounds + system notifications
        Notify.setUserPref('off');
        paint();
        UI.toast('info', 'Notifications Off', 'Sounds muted. Click the bell to turn back on.');
        return;
      }
      // OFF → ON: restore sounds; request system permission if needed
      Notify.setUserPref('on');
      paint();
      try {
        if (typeof Notification === 'undefined') {
          UI.toast('warning', 'Sounds On', 'Sounds are on, but this browser does not support system notifications.');
          return;
        }
        if (Notification.permission === 'denied') {
          UI.toast('warning', 'Sounds On', 'System popups are blocked in browser settings — sounds are still on.');
          return;
        }
        if (Notification.permission === 'default') {
          const result = await Notify.requestPermission();
          if (result !== 'granted') {
            UI.toast('warning', 'Sounds On', result === 'denied'
              ? 'System popups are blocked in browser settings — sounds are still on.'
              : 'Sounds are on, but notification permission was not granted.');
            return;
          }
        }
      } catch {}
      UI.toast('success', 'Notifications On', 'Sounds and background alerts are enabled.');
    });
  }

  function _bindEncryption() {
    const toggleBtn = document.getElementById('e2ee-toggle-btn');
    const modal     = document.getElementById('passphrase-modal');
    const inputPass = document.getElementById('room-passphrase-input');
    const saveBtn   = document.getElementById('save-passphrase-btn');
    const clearBtn  = document.getElementById('clear-passphrase-btn');
    const closeBtn  = document.getElementById('close-passphrase-btn');

    if (!toggleBtn || !modal) return;

    toggleBtn.addEventListener('click', () => {
      modal.classList.remove('hidden');
      if (inputPass) inputPass.focus();
    });

    if (closeBtn) closeBtn.onclick = () => modal.classList.add('hidden');

    if (saveBtn) {
      saveBtn.onclick = async () => {
        const pass = inputPass.value.trim();
        if (!pass) {
          UI.toast('error', 'Empty Passphrase', 'Please enter a passphrase.');
          return;
        }
        // Warn: a manual passphrase replaces the invite-link room key.
        // Guests must enter the SAME passphrase or they won't read new messages.
        if (_session && _session.role === 'owner') {
          const okPass = await UI.confirmDialog({
            title: 'Set a manual passphrase?',
            message: 'This replaces the automatic invite-link key. Guests must enter the SAME passphrase to read new messages.',
            confirmText: 'Continue',
          });
          if (!okPass) return;
        }
        if (typeof Encryption !== 'undefined' && Encryption.deriveKeyFromPassword) {
          await Encryption.deriveKeyFromPassword(pass, _room.id);
          UI.toast('success', 'E2EE Enabled', 'Passphrase set. Share it with guests out-of-band.');
          toggleBtn.style.color = 'var(--accent-2)';
          modal.classList.add('hidden');
          // Refresh rendered messages to decrypt
          _messages.forEach(m => _updateMessageEl(m));
        }
      };
    }

    if (clearBtn) {
      clearBtn.onclick = async () => {
        inputPass.value = '';
        modal.classList.add('hidden');
        // Restore the automatic invite-link room key instead of leaving
        // encryption off (which would mix plaintext with old enc: history).
        try {
          const roomSecret = (_session && _session.roomSecret) || (_room && _room.secret) || '';
          if (typeof Encryption !== 'undefined' && roomSecret && Encryption.deriveKeyFromRoomSecret) {
            await Encryption.deriveKeyFromRoomSecret(roomSecret, _room.id);
            toggleBtn.style.color = '';
            toggleBtn.classList.remove('e2ee-active');
            UI.toast('success', 'Passphrase cleared', 'New messages are plaintext — guests need no passphrase.');
          } else {
            if (typeof Encryption !== 'undefined') Encryption.clearKey();
            toggleBtn.style.color = '';
            UI.toast('info', 'E2EE Disabled', 'Client-side encryption disabled.');
          }
        } catch {
          if (typeof Encryption !== 'undefined') Encryption.clearKey();
          toggleBtn.style.color = '';
        }
        _messages.forEach(m => _updateMessageEl(m));
      };
    }
  }


  // Short human-readable preview for replies/quotes (never raw JSON/base64)
  function _displayText(msg) {
    const c = msg && msg.message;
    if (typeof c === 'string' && c.startsWith('{')) {
      try {
        const p = JSON.parse(c);
        if (p && typeof p.dataUrl === 'string') {
          if (p.text) return String(p.text).substring(0, 80);
          const kind = (msg.messageType === 'audio' || String(p.fileType || '').startsWith('audio/')) ? '🎤 Voice' : '📎 Attachment';
          return `${kind} · ${p.fileName || 'file'}`;
        }
      } catch {}
    }
    if (typeof c === 'string' && c.startsWith('enc:')) return 'Encrypted message (locked)';
    return (typeof c === 'string' ? c : '').substring(0, 80);
  }

  // ── Premium voice player (waveform + speed, custom UI) ────────
  const _voicePeaks = new Map(); // msgId -> { peaks:number[], dur:number }
  let _voiceCtx = null;
  let _playingVoice = null; // { audio, btn, wave, time, speedBtn, id }

  function _voiceCtxGet() {
    try {
      if (!_voiceCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        _voiceCtx = new AC();
      }
      if (_voiceCtx.state === 'suspended') _voiceCtx.resume().catch(() => {});
      return _voiceCtx;
    } catch { return null; }
  }

  async function _voicePeaksFor(id, dataUrl, n = 36) {
    if (id && _voicePeaks.has(id)) return _voicePeaks.get(id);
    const ctx = _voiceCtxGet();
    if (!ctx) return null;
    try {
      const buf = await (await fetch(dataUrl)).arrayBuffer();
      const decoded = await ctx.decodeAudioData(buf);
      const ch = decoded.getChannelData(0);
      const peaks = [];
      const step = Math.max(1, Math.floor(ch.length / n));
      for (let i = 0; i < n; i++) {
        let m = 0;
        const start = i * step;
        for (let j = start; j < Math.min(start + step, ch.length); j += 7) {
          const v = Math.abs(ch[j]);
          if (v > m) m = v;
        }
        peaks.push(m);
      }
      const max = Math.max(...peaks, 0.01);
      const norm = peaks.map(v => 0.18 + 0.82 * (v / max));
      const entry = { peaks: norm, dur: decoded.duration || 0 };
      if (id) _voicePeaks.set(id, entry);
      return entry;
    } catch { return null; }
  }

  const VP_PLAY = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
  const VP_PAUSE = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="5" height="16" rx="1"></rect><rect x="14" y="4" width="5" height="16" rx="1"></rect></svg>';

  function _stopActiveVoice() {
    if (!_playingVoice) return;
    try {
      _playingVoice.audio.pause();
      _playingVoice.btn.innerHTML = VP_PLAY;
      _playingVoice.btn.classList.remove('playing');
    } catch {}
    _playingVoice = null;
  }

  function _bindVoicePlayer(scope, parsed, msgId) {
    const root = scope.querySelector('.voice-player');
    if (!root) return;
    const btn = root.querySelector('.vp-play');
    const wave = root.querySelector('.vp-wave');
    const timeEl = root.querySelector('.vp-time');
    const speedBtn = root.querySelector('.vp-speed');
    const audio = root.querySelector('.vp-audio');
    const total = parsed.durationSec > 0 ? parsed.durationSec : 0;
    if (timeEl && total > 0) timeEl.textContent = _fmtDuration(total);

    // Build waveform bars optimistically; fill real peaks when decoded
    const N = 36;
    const bars = [];
    wave.innerHTML = '';
    for (let i = 0; i < N; i++) {
      const b = document.createElement('span');
      b.className = 'voice-bar';
      const h = 5 + Math.round(Math.abs(Math.sin(i * 1.7) * 0.6 + Math.sin(i * 0.6) * 0.4) * 22);
      b.style.height = h + 'px';
      wave.appendChild(b);
      bars.push(b);
    }
    _voicePeaksFor(msgId, parsed.dataUrl, N).then(entry => {
      if (!entry || !wave.isConnected) return;
      entry.peaks.forEach((v, i) => {
        if (bars[i]) bars[i].style.height = Math.max(4, Math.round(v * 27)) + 'px';
      });
      if (timeEl && !(total > 0) && entry.dur > 0) {
        timeEl.textContent = _fmtDuration(entry.dur);
      }
    });

    const paint = () => {
      const d = (total > 0 ? total : (audio.duration || 0)) || 0;
      const c = audio.currentTime || 0;
      const frac = d > 0 ? Math.min(1, c / d) : 0;
      bars.forEach((b, i) => b.classList.toggle('played', i / bars.length < frac));
      if (timeEl) timeEl.textContent = d > 0 ? `${_fmtDuration(c)} / ${_fmtDuration(d)}` : _fmtDuration(c);
    };

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { _voiceCtxGet(); } catch {}
      if (_playingVoice && _playingVoice.audio === audio && !audio.paused) {
        audio.pause();
        btn.innerHTML = VP_PLAY;
        btn.classList.remove('playing');
        _playingVoice = null;
        return;
      }
      _stopActiveVoice();
      try {
        await audio.play();
        btn.innerHTML = VP_PAUSE;
        btn.classList.add('playing');
        _playingVoice = { audio, btn, wave, time: timeEl, speedBtn, id: msgId };
      } catch {
        UI.toast('error', 'Playback failed', 'This audio cannot be played here.');
      }
    });

    speedBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const steps = [1, 1.5, 2];
      const next = steps[(steps.indexOf(audio.playbackRate) + 1) % steps.length] || 1;
      audio.playbackRate = next;
      speedBtn.textContent = (next + 'x').replace('.0', '');
    });

    audio.addEventListener('timeupdate', paint);
    audio.addEventListener('loadedmetadata', paint);
    audio.addEventListener('ended', () => {
      btn.innerHTML = VP_PLAY;
      btn.classList.remove('playing');
      bars.forEach(b => b.classList.remove('played'));
      if (timeEl && total > 0) timeEl.textContent = _fmtDuration(total);
      if (_playingVoice && _playingVoice.audio === audio) _playingVoice = null;
    });

    wave.addEventListener('click', (e) => {
      const r = wave.getBoundingClientRect();
      const frac = r.width ? (e.clientX - r.left) / r.width : 0;
      const d = (total > 0 ? total : (audio.duration || 0)) || 0;
      if (d > 0) {
        audio.currentTime = Math.max(0, Math.min(0.999, frac)) * d;
        paint();
      }
    });

    // Decode failure → fall back to the native player
    audio.addEventListener('error', () => {
      const native = document.createElement('audio');
      native.controls = true;
      native.preload = 'metadata';
      native.src = parsed.dataUrl;
      native.className = 'msg-audio';
      root.replaceWith(native);
    }, { once: true });
  }

  // ── Professional image rendering helpers ─────────────────────
  // Edge-to-edge media bubble (WhatsApp style): image-only bubbles lose
  // their text padding so the photo sits flush with rounded corners.
  function _paintMediaBubble(container) {
    try {
      const bubble = container && container.closest ? container.closest('.msg-bubble') : null;
      if (!bubble) return;
      const media = container.querySelector('.msg-media-wrap');
      bubble.classList.toggle('msg-media', !!media && !media.classList.contains('has-caption'));
      bubble.classList.toggle('has-caption', !!media && media.classList.contains('has-caption'));
    } catch {}
  }

  // ── Shepu-AI 4.1-style image generation animation ─────────────
  // A 19×19 wave of dots + a slowly rising percentage, adapted from the
  // reference build's canvas loader. It runs behind the image until load.
  function _mediaGenMarkup() {
    return '<span class="msg-media-gen" aria-hidden="true">'
      + '<span class="msg-media-gen-title">Creating image</span>'
      + '<canvas class="msg-media-gen-canvas" width="300" height="300"></canvas>'
      + '<span class="msg-media-gen-percent">12%</span>'
      + '</span>';
  }

  function _startMediaGenAnimation(wrap) {
    try {
      if (!wrap || wrap._mediaGenStop) return;
      const canvas = wrap.querySelector('.msg-media-gen-canvas');
      const percentElem = wrap.querySelector('.msg-media-gen-percent');
      if (!canvas || !percentElem || typeof requestAnimationFrame !== 'function') return;
      const ctx = canvas.getContext && canvas.getContext('2d');
      if (!ctx) return;

      const size = 300;
      const dpr = Math.min((typeof window !== 'undefined' && window.devicePixelRatio) || 1, 2);
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      if (ctx.setTransform) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      else ctx.scale(dpr, dpr);

      const reduceMotion = typeof window !== 'undefined' && window.matchMedia
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches : false;
      const isLight = document.body && document.body.classList.contains('light-mode');
      const cols = 19;
      const rows = 19;
      const step = size / (cols + 1);
      const cx = size / 2;
      const cy = size / 2;
      const maxDist = Math.hypot(cx, cy);
      let progress = 12 + Math.floor(Math.random() * 3);
      let phase = 0;
      let raf = 0;
      let timer = null;
      let stopped = false;

      const paintPercent = () => { percentElem.textContent = progress + '%'; };
      paintPercent();

      if (!reduceMotion) {
        timer = setInterval(() => {
          if (stopped || progress >= 95) return;
          const inc = progress < 40
            ? (Math.floor(Math.random() * 2) + 1)
            : (progress < 75 ? (Math.random() < 0.65 ? 1 : 2) : 1);
          progress = Math.min(95, progress + inc);
          paintPercent();
        }, 450);
      }

      const stop = (complete) => {
        if (stopped) return;
        stopped = true;
        if (timer) clearInterval(timer);
        if (raf) cancelAnimationFrame(raf);
        if (complete) { progress = 100; paintPercent(); }
        wrap._mediaGenStop = null;
      };
      wrap._mediaGenStop = stop;

      const draw = () => {
        if (stopped) return;
        if (!canvas.isConnected) { stop(false); return; }
        ctx.clearRect(0, 0, size, size);
        phase += 0.62;
        const cycle = maxDist * 1.5;
        const wave1 = phase % cycle;
        const wave2 = (phase + cycle * 0.5) % cycle;
        for (let r = 1; r <= rows; r++) {
          for (let c = 1; c <= cols; c++) {
            const x = c * step;
            const y = r * step;
            const d = Math.hypot(x - cx, y - cy);
            const int1 = Math.max(0, 1 - Math.abs(d - wave1) / 56);
            const int2 = Math.max(0, 1 - Math.abs(d - wave2) / 56);
            const intensity = Math.pow(Math.min(1, int1 + int2), 1.2);
            const radius = 1.35 + intensity * 1.1;
            let color;
            if (intensity > 0.04) {
              const alpha = 0.18 + intensity * 0.82;
              color = isLight
                ? `rgba(37, 99, 235, ${alpha})`
                : `rgba(${Math.round(96 + intensity * 130)}, ${Math.round(165 + intensity * 75)}, 255, ${alpha})`;
            } else {
              color = isLight ? 'rgba(0, 0, 0, 0.11)' : 'rgba(255, 255, 255, 0.12)';
            }
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fillStyle = color;
            ctx.fill();
          }
        }
        if (!reduceMotion) raf = requestAnimationFrame(draw);
        else stopped = true;
      };
      raf = requestAnimationFrame(draw);
    } catch (e) { /* keep the CSS shimmer as a fallback */ }
  }

  function _stopMediaGenAnimation(wrap, complete) {
    try {
      if (wrap && typeof wrap._mediaGenStop === 'function') wrap._mediaGenStop(!!complete);
    } catch (e) { /* non-fatal */ }
  }

  function _revealMediaWrap(wrap, delay) {
    if (!wrap || wrap.dataset.revealPending === '1') return;
    wrap.dataset.revealPending = '1';
    setTimeout(() => wrap.classList.add('loaded'), Math.max(0, delay || 0));
  }

  // Fade-in on load, turbo-model fallback, error state, overlay buttons.
  function _bindMediaWraps(container) {
    try {
      container.querySelectorAll('.msg-media-wrap').forEach(wrap => {
        const hasGen = !!wrap.querySelector('.msg-media-gen');
        if (hasGen) _startMediaGenAnimation(wrap);
        const img = wrap.querySelector('img.msg-attachment-img');
        if (img) {
          const revealDelay = Math.max(0, parseInt(img.getAttribute('data-reveal-delay') || '0', 10) || 0);
          const finishLoad = () => {
            if (img.dataset.mediaRevealScheduled === '1') return;
            img.dataset.mediaRevealScheduled = '1';
            if (hasGen) _stopMediaGenAnimation(wrap, true);
            _revealMediaWrap(wrap, hasGen ? 180 : 0);
          };
          const onLoad = () => {
            // 4.1 keeps the dots loader on screen for the official portrait
            // even though the bundled image is already available locally.
            if (hasGen && revealDelay > 0) {
              setTimeout(finishLoad, revealDelay);
            } else {
              finishLoad();
            }
          };
          const onError = () => {
            // 4.1 image logic: retry the same prompt with the faster
            // Shepu-AI turbo image model before showing a broken-image state.
            const fallback = img.getAttribute('data-fallback-src') || '';
            if (fallback && img.dataset.fallbackTried !== '1') {
              img.dataset.fallbackTried = '1';
              wrap.classList.remove('media-error');
              wrap.classList.remove('loaded');
              if (img.dataset.fallbackLoadBound !== '1') {
                img.dataset.fallbackLoadBound = '1';
                img.addEventListener('load', onLoad, { once: true });
                // Also cover the case where `complete` was already true at
                // bind time; otherwise a failed turbo retry could leave the
                // shimmer spinning forever.
                img.addEventListener('error', onError, { once: true });
              }
              img.src = fallback;
              return;
            }
            // Official local photo or remote Shepu-AI image failed twice:
            // keep the image reachable through a normal link.
            const href = img.getAttribute('data-remote-href') || '';
            if (href) {
              if (img.dataset.finalErrorHandled === '1') return;
              img.dataset.finalErrorHandled = '1';
              _stopMediaGenAnimation(wrap, false);
              wrap.innerHTML = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="msg-link">ছবিটি নতুন ট্যাবে খুলুন</a>`;
              return;
            }
            _stopMediaGenAnimation(wrap, false);
            wrap.classList.add('media-error');
          };
          if (img.complete) {
            if (img.naturalWidth) onLoad();
            else onError();
          } else {
            img.addEventListener('load', onLoad, { once: true });
            img.addEventListener('error', onError);
          }
          img.addEventListener('click', (e) => {
            e.stopPropagation();
            openLightbox(img.src, wrap.dataset.filename || img.alt || 'Image');
          });
        }
        wrap.querySelectorAll('[data-act="view"]').forEach(b => {
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            const im = wrap.querySelector('img.msg-attachment-img');
            if (im) openLightbox(im.src, wrap.dataset.filename || im.alt || 'Image');
          });
        });
        wrap.querySelectorAll('[data-act="download"]').forEach(a => {
          a.addEventListener('click', (e) => e.stopPropagation());
        });
      });
    } catch {}
  }

  function openLightbox(src, name) {
    try {
      const box = document.getElementById('lightbox-modal');
      const img = document.getElementById('lightbox-img');
      const label = document.getElementById('lightbox-name');
      const dl = document.getElementById('lightbox-download');
      if (!box || !img || !src) return;
      img.src = src;
      img.alt = name || 'Enlarged preview';
      if (label) label.textContent = name || '';
      if (dl) { dl.href = src; dl.setAttribute('download', name || 'image'); }
      box.classList.remove('hidden');
      try { document.body.style.overflow = 'hidden'; } catch {}
    } catch {}
  }

  function closeLightbox() {
    try {
      document.getElementById('lightbox-modal')?.classList.add('hidden');
      const img = document.getElementById('lightbox-img');
      // removeAttribute, not src = '' — an empty src makes the browser
      // re-fetch the page URL as an image.
      if (img) img.removeAttribute('src');
      try { document.body.style.overflow = ''; } catch {}
    } catch {}
  }

  // ── Emoji-bubble repaint (post-decrypt sizing) ────────────────
  // Bubble size is decided at build time from msg.message — but encrypted
  // rooms store enc: ciphertext, so after a refresh every message builds as
  // a plain bubble and emojis stay text-sized even after decrypting.
  // Recompute from the PLAINTEXT on every text render: idempotent, so the
  // initial build, async decrypts, edits and key-arrivals all converge.
  const _EMOJI_SIZE_CLASSES = ['msg-bubble-emoji', 'emoji-xl', 'emoji-lg', 'emoji-md', 'emoji-sm', 'emoji-xs'];
  function _refreshEmojiBubble(container, plainText) {
    let bubble = null;
    try { bubble = container && container.closest ? container.closest('.msg-bubble') : null; } catch {}
    if (!bubble) return;
    let only = false, count = 0;
    try {
      only = !!(plainText && _isEmojiOnly(plainText));
      if (only) {
        count = _countEmojis(plainText);
        try {
          if (typeof SpecialEmoji !== 'undefined' && SpecialEmoji.countShortcodes) {
            count += SpecialEmoji.countShortcodes(plainText) || 0;
          }
        } catch {}
        if (!(count > 0)) count = Math.max(1, Math.ceil(String(plainText).length / 2));
      }
    } catch { only = false; }
    _EMOJI_SIZE_CLASSES.forEach(c => bubble.classList.remove(c));
    if (!only) return;
    bubble.classList.add('msg-bubble-emoji');
    bubble.classList.add(count === 1 ? 'emoji-xl' : count <= 3 ? 'emoji-lg' : count <= 6 ? 'emoji-md' : count <= 12 ? 'emoji-sm' : 'emoji-xs');
  }

  function _renderBubbleContent(container, content, messageType, msgId) {
    if (!container) return;
    try {
      // Sniff attachment payloads even when messageType was lost upstream
      // (old history, third-party relays) so raw JSON/base64 never shows.
      if (typeof content === 'string' && content.startsWith('{') && (!messageType || messageType === 'text')) {
        try {
          const sniff = JSON.parse(content);
          if (sniff && typeof sniff.dataUrl === 'string') {
            const ft = String(sniff.fileType || '');
            messageType = ft.startsWith('image/') ? 'image' : ft.startsWith('audio/') ? 'audio' : 'file';
          }
        } catch { /* not an attachment — render as text below */ }
      }
      if ((messageType === 'image' || messageType === 'file' || messageType === 'audio') && typeof content === 'string' && content.startsWith('{')) {
        const parsed = JSON.parse(content);
        const isAudio = messageType === 'audio' || (typeof parsed.fileType === 'string' && parsed.fileType.startsWith('audio/'));
        if (isAudio && typeof parsed.dataUrl === 'string' && /^data:audio\//i.test(parsed.dataUrl)) {
          const dur = parsed.durationSec > 0 ? _fmtDuration(parsed.durationSec) : '';
          let ahtml = `<div class="voice-player"><button type="button" class="vp-play" aria-label="Play voice message">${VP_PLAY}</button><div class="vp-wave" role="slider" aria-label="Seek"></div><button type="button" class="vp-speed" aria-label="Playback speed">1x</button><span class="vp-time">${dur ? escapeHtml(dur) : ''}</span><audio class="vp-audio" preload="metadata" src="${escapeHtml(parsed.dataUrl)}"></audio></div>`;
          if (parsed.text) ahtml += `<div class="msg-attach-caption">${_renderText(parsed.text)}</div>`;
          container.innerHTML = ahtml;
          _bindVoicePlayer(container, parsed, msgId);
          _paintMediaBubble(container);
          return;
        }
        // Any data: URL is accepted EXCEPT the media types that can run
        // script when opened (text/html, xhtml, svg). The previous
        // allow-list only took image/audio/video/pdf/text-plain, so a
        // .docx, .zip, .csv — or the application/octet-stream this app
        // itself sends for an unknown MIME — was rejected here and the
        // message rendered as an EMPTY bubble: the file was transferred,
        // but nobody could see or download it.
        const dataUrl = (typeof parsed.dataUrl === 'string' && SAFE_DATA_URL_RE.test(parsed.dataUrl))
          ? parsed.dataUrl : '';
        // The Shepu-AI bot can attach a remote Shepu-AI image or the exact
        // bundled official portrait instead of a data: upload. Legacy rooms
        // may still contain the old provider tag, so both are accepted; only
        // these two sources are allowed. User/peer messages cannot turn
        // arbitrary remote URLs into inline media.
        const isAiProvider = parsed.provider === 'shepu-ai-image' || parsed.provider === 'pollinations';
        const remoteImage = (typeof parsed.dataUrl === 'string'
          && isAiProvider
          && /^https:\/\/image\.pollinations\.ai\/prompt\/[^\s"'<>]+$/i.test(parsed.dataUrl))
          ? parsed.dataUrl : '';
        const localOfficial = (typeof parsed.dataUrl === 'string'
          && parsed.provider === 'shepu-official'
          && parsed.dataUrl === 'ai/shepu-official.png')
          ? parsed.dataUrl : '';
        const remoteFallback = (typeof parsed.fallbackUrl === 'string'
          && isAiProvider
          && /^https:\/\/image\.pollinations\.ai\/prompt\/[^\s"'<>]+$/i.test(parsed.fallbackUrl))
          ? parsed.fallbackUrl : '';
        const mediaSrc = dataUrl || remoteImage || localOfficial;
        const fallbackAttr = remoteFallback ? ` data-fallback-src="${escapeHtml(remoteFallback)}"` : '';
        const remoteHrefAttr = (remoteImage || localOfficial) ? ` data-remote-href="${escapeHtml(mediaSrc)}"` : '';
        const isAiImage = isAiProvider || parsed.provider === 'shepu-official';
        // Local-only placeholder shown while ShepuBot is enhancing the prompt
        // and building the image URL (before the final message exists).
        if (parsed.provider === 'shepu-generating') {
          const genHtml = `<figure class="msg-media-wrap msg-media-ai msg-media-generating" data-filename="Shepu-AI image">`
            + `<span class="msg-media-shimmer msg-media-gen-wrap" aria-hidden="true">${_mediaGenMarkup()}</span>`
            + `</figure>`;
          container.innerHTML = genHtml + (parsed.text ? `<div class="msg-attach-caption">${_renderText(parsed.text)}</div>` : '');
          _bindMediaWraps(container);
          _paintMediaBubble(container);
          return;
        }
        const watermark = isAiImage
          ? `<span class="msg-media-watermark" aria-hidden="true">Shepu-AI</span>` : '';
        // The 4.1 loader: a 19×19 wave of dots plus a percentage badge.
        // It is visible while the prompt/image is being prepared, and also
        // while the final Shepu-AI image is decoding.
        const genMarkup = isAiImage ? _mediaGenMarkup() : '';
        const shimmerClass = isAiImage ? 'msg-media-shimmer msg-media-gen-wrap' : 'msg-media-shimmer';
        const officialDelayAttr = localOfficial ? ' data-reveal-delay="2200"' : '';
        let html = '';
        let renderedImage = false;
        if (mediaSrc && parsed.fileType && parsed.fileType.startsWith('image/')) {
          renderedImage = true;
          const fname = parsed.fileName || 'Image';
          const cap = parsed.text ? `<div class="msg-img-caption">${_renderText(parsed.text)}</div>` : '';
          html += `<figure class="msg-media-wrap${isAiImage ? ' msg-media-ai' : ''}${parsed.text ? ' has-caption' : ''}" data-filename="${escapeHtml(fname)}">`
            + `<span class="${shimmerClass}" aria-hidden="true">${genMarkup}</span>`
            + `<img src="${escapeHtml(mediaSrc)}" class="msg-attachment-img" alt="${escapeHtml(fname)}" loading="lazy" referrerpolicy="no-referrer"${fallbackAttr}${remoteHrefAttr}${officialDelayAttr} />`
            + watermark
            + `<figcaption class="msg-media-overlay">`
            + `<button type="button" class="msg-media-btn" data-act="view" aria-label="View full size" title="View full size"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"></path><path d="M9 21H3v-6"></path><path d="M21 3l-7 7"></path><path d="M3 21l7-7"></path></svg></button>`
            + `<a class="msg-media-btn" data-act="download" href="${escapeHtml(mediaSrc)}" download="${escapeHtml(fname)}" aria-label="Download image" title="Download"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg></a>`
            + `</figcaption></figure>${cap}`;
        } else if (dataUrl) {
          html += `<a href="${escapeHtml(dataUrl)}" download="${escapeHtml(parsed.fileName || 'file')}" class="msg-file-card"><span class="msg-file-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg></span><div class="msg-file-details"><div class="msg-file-name">${escapeHtml(parsed.fileName)}</div><div class="msg-file-meta">${Math.round((parsed.fileSize||0)/1024)} KB · Click to download</div></div></a>`;
        }
        if (parsed.text && !renderedImage) {
          html += `<div class="msg-attach-caption">${_renderText(parsed.text)}</div>`;
        }
        container.innerHTML = html;
        _bindMediaWraps(container);
        _paintMediaBubble(container);
        return;
      }
    } catch (e) { /* fallback to plain text */ }
    container.innerHTML = _renderText(content);
    _paintMediaBubble(container);
    // Plaintext (never enc:/JSON) → repaint bubble sizing. Covers async
    // decrypts, edits and late key arrivals uniformly.
    try {
      if ((messageType === 'text' || !messageType) && typeof content === 'string'
        && !content.startsWith('enc:') && !content.startsWith('{')) {
        _refreshEmojiBubble(container, content);
      }
    } catch {}
  }



  // Re-decrypt all rendered enc: messages (call after the room key arrives).
  async function refreshDecryption() {
    for (const m of _messages) {
      try { _updateMessageEl(m); } catch {}
    }
    // Let pending async decrypts settle
    await new Promise(r => setTimeout(r, 50));
  }

  // ── Ephemeral 4.1 image-generation placeholder ────────────────
  // Shown only on the client that asked ShepuBot, while the prompt is being
  // refined and the image URL is built. It is never persisted; the final
  // image message replaces it through the normal room transport.
  let _genPlaceholderSeq = 0;
  function beginImageGeneration(opts) {
    opts = opts || {};
    if (!feed || !_session) return null;
    try {
      const id = 'g_' + (++_genPlaceholderSeq) + '_' + Date.now();
      const msg = {
        id,
        createdAt: new Date().toISOString(),
        senderId: 'shepu_ai_bot',
        senderName: 'Shepu-AI 4.1 Ultra',
        senderPicture: 'ai/pai.png',
        messageType: 'image',
        message: JSON.stringify({
          provider: 'shepu-generating',
          fileType: 'image/jpeg',
          fileName: 'shepu-ai.jpg',
          text: String(opts.text || ''),
        }),
        replyTo: null,
        edited: false,
        deleted: false,
      };
      const el = _makeMessageEl(msg);
      el.id = 'gen-' + id;
      el.classList.add('msg-generating');
      feed.appendChild(el);
      _checkEmpty();
      try {
        if (UI && typeof UI.scrollToBottom === 'function') UI.scrollToBottom(feed, true);
        else feed.scrollTop = feed.scrollHeight;
      } catch { feed.scrollTop = feed.scrollHeight; }
      return id;
    } catch (e) { return null; }
  }

  function endImageGeneration(id) {
    if (!id) return;
    try {
      const el = document.getElementById('gen-' + id);
      if (el) el.remove();
      _checkEmpty();
    } catch { /* non-fatal */ }
  }

  // Read-only directory for the Shepu-AI room-command layer. Online state is
  // derived from the same presence window used by the member sidebar.
  function getMembers() {
    return Array.from(_memberDir.values()).map(e => ({
      ...e,
      online: _isOnlineEntry(e),
    }));
  }

  // Remove a member from the local directory immediately after the owner
  // removes them through the bot. The next sync will reconcile anyway.
  function dropMember(memberId) {
    if (!memberId) return;
    _memberDir.delete(memberId);
    _memberMap.delete(memberId);
    _renderMemberDir();
  }

  return {
    init,
    appendMessages,
    renderMembers,
    refreshDecryption,
    getMembers,
    dropMember,
    setStatus,
    setComposerEnabled,
    showUnavailable,
    loadSheetMessages,
    setEncryptionStatus,
    handleTypingEvent,
    beginImageGeneration,
    endImageGeneration,
    getMessages: () => _messages,
    mergeMembers,
    setTheme,
  };
})();

window.Chat = Chat;


  