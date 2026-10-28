// SHEPU ROOMS — Code.gs
// Auto-deployed room backend. Do not modify unless you know what you're doing.
// This file is auto-generated and uploaded by SHEPU ROOMS during room creation.
//
// If you need to make changes, modify the template in js/apps-script.js
// and re-deploy from the owner panel.
//
// Variables are injected at deploy time:
//   ROOM_ID, ROOM_SECRET, SHEET_ID

var ROOM_ID     = 'REPLACE_WITH_ROOM_ID';
var ROOM_SECRET = 'REPLACE_WITH_ROOM_SECRET';
var SHEET_ID    = 'REPLACE_WITH_SHEET_ID';

// ── CORS helper ──────────────────────────────────────────────────
function corsResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorResponse(msg, code) {
  return corsResponse({ success: false, error: msg, code: code || 'ERROR' });
}

// ── doGet ────────────────────────────────────────────────────────
function doGet(e) {
  try {
    var action = (e.parameter && e.parameter.action) || 'messages';
    // One script serves ONE room, so these buckets are per-room. The client
    // polls messages every 2 s (30/min), so the old 300/min cap throttled real
    // users at ~10 people per room. Sized for ~40 concurrent clients — Apps
    // Script's own execution concurrency is the natural ceiling below this.
    var limits = { messages: 1200, members: 300, room: 180 };
    if (!Object.prototype.hasOwnProperty.call(limits, action)) return errorResponse('Unknown action', 'NOT_FOUND');
    if (!checkRateLimit('get_global', 2400, 60)) return errorResponse('Room is busy — try again shortly', 'RATE_LIMITED');
    if (!checkRateLimit('get_' + action, limits[action], 60)) return errorResponse('Too many requests — try again shortly', 'RATE_LIMITED');
    if (action === 'messages') return handleGetMessages(e);
    if (action === 'room')     return handleGetRoom(e);
    if (action === 'members')  return handleGetMembers(e);
    return errorResponse('Unknown action', 'NOT_FOUND');
  } catch(err) {
    return errorResponse(err.message || 'Internal error', 'INTERNAL');
  }
}

// ── doPost ───────────────────────────────────────────────────────
function doPost(e) {
  try {
    // Apply the room-wide cap before parsing/processing caller-controlled JSON.
    if (!checkRateLimit('post_global', 2400, 60)) return errorResponse('Room is busy — try again shortly', 'RATE_LIMITED');

    var raw = e && e.postData && e.postData.contents;
    if (typeof raw !== 'string' || raw.length > 52000 || Utilities.newBlob(raw).getBytes().length > 52000) {
      return errorResponse('Request is too large', 'TOO_LARGE');
    }
    var body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse('Invalid request', 'INVALID');

    var action = body.action;
    // Per-action room caps: generous enough for ~40 active clients (presence
    // heartbeats every 20 s = 3/min each), still low enough that a flood
    // cannot burn the room's Apps Script quota in seconds. message is further
    // capped at 30/min per member below.
    var limits = { join: 120, message: 900, edit: 300, delete: 300, presence: 600, leave: 300, room_op: 120 };
    if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(limits, action)) {
      return errorResponse('Unknown action', 'NOT_FOUND');
    }
    if (!checkRateLimit('post_' + action, limits[action], 60)) return errorResponse('Too many requests — try again shortly', 'RATE_LIMITED');

    if (action === 'join')     return handleJoin(body);
    if (action === 'message')  return handleSendMessage(body);
    if (action === 'edit')     return handleEditMessage(body);
    if (action === 'delete')   return handleDeleteMessage(body);
    if (action === 'presence') return handlePresence(body);
    if (action === 'leave')    return handleLeave(body);
    if (action === 'room_op')  return handleRoomOp(body);

    return errorResponse('Unknown action', 'NOT_FOUND');
  } catch(err) {
    return errorResponse(err.message || 'Internal error', 'INTERNAL');
  }
}

// ── Helpers ───────────────────────────────────────────────────────
function getSpreadsheet() {
  if (typeof SHEET_ID !== 'undefined' && SHEET_ID && SHEET_ID !== 'REPLACE_WITH_SHEET_ID' && SHEET_ID.length > 5) {
    try { return SpreadsheetApp.openById(SHEET_ID); } catch(e) {}
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet(name) {
  var ss = getSpreadsheet();
  if (!ss) {
    throw new Error('Spreadsheet not found. Please attach this script to a Google Sheet (Extensions > Apps Script).');
  }
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (name === 'messages') {
      sheet.appendRow(['id', 'createdAt', 'senderId', 'senderName', 'messageType', 'message', 'replyTo', 'edited', 'deleted']);
    } else if (name === 'members') {
      sheet.appendRow(['memberId', 'displayName', 'joinedAt', 'lastSeen', 'status', 'role', 'banned', 'active', 'sessionToken']);
    } else if (name === 'room_config') {
      sheet.appendRow(['key', 'value']);
      sheet.appendRow(['room_id', (typeof ROOM_ID !== 'undefined' && ROOM_ID !== 'REPLACE_WITH_ROOM_ID') ? ROOM_ID : 'room_' + Utilities.getUuid().substring(0,8)]);
      sheet.appendRow(['room_name', 'SHEPU CHAT Room']);
      sheet.appendRow(['room_status', 'active']);
      sheet.appendRow(['created_at', now()]);
    }
  }
  return sheet;
}

function generateId(prefix) {
  return (prefix || 'id') + '_' + Utilities.getUuid().replace(/-/g,'').substring(0,12);
}

function now() { return new Date().toISOString(); }

function getRoomConfig() {
  var sheet = getSheet('room_config');
  var data  = sheet.getDataRange().getValues();
  var cfg   = {};
  for (var i = 1; i < data.length; i++) {
    if (data[i][0]) cfg[data[i][0]] = data[i][1];
  }
  return cfg;
}

function updateConfig(key, value) {
  var sheet = getSheet('room_config');
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      sheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function validateSession(memberId, sessionToken) {
  if (!memberId || !sessionToken) return false;
  var sheet = getSheet('members');
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === memberId) {
      var banned = data[i][6];
      var active = data[i][7];
      var token  = data[i][8];
      if (banned === true || banned === 'TRUE') return false;
      if (active === false || active === 'FALSE') return false;
      if (String(token) !== String(sessionToken)) return false;
      return true;
    }
  }
  return false;
}

function getMemberRow(memberId) {
  var sheet = getSheet('members');
  var data  = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === memberId) return { row: i + 1, data: data[i] };
  }
  return null;
}

// ── Rate limiting (CacheService survives across executions — the old
// in-memory object did not, so floods from fresh memberIds sailed through).
// Caps normal use generously; only automated floods trip it.
function checkRateLimit(scope, limit, windowSec) {
  var lock = LockService.getScriptLock();
  // Fail closed on lock/cache failures: allowing uncounted requests would
  // turn a quota-service problem into an unlimited-write path.
  if (!lock.tryLock(2500)) return false;
  try {
    var cache = CacheService.getScriptCache();
    var seconds = windowSec || 60;
    var bucket = Math.floor(Date.now() / 1000 / seconds);
    var key = 'rl_' + String(scope || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 60) + '_' + bucket;
    var n = parseInt(cache.get(key) || '0', 10) || 0;
    if (n >= (limit || 30)) return false;
    cache.put(key, String(n + 1), seconds + 5);
    return true;
  } catch (e) {
    return false;
  } finally {
    lock.releaseLock();
  }
}

// Spreadsheet cells have a 50,000-character limit. Keep a little headroom
// and ensure user-controlled text is stored as text, never as a formula.
function sheetText(value) {
  var text = String(value == null ? '' : value);
  var first = text.trimStart().charAt(0);
  return '=+@-'.indexOf(first) !== -1 ? "'" + text : text;
}

// ── GET /room ─────────────────────────────────────────────────────
function handleGetRoom(e) {
  var cfg = getRoomConfig();
  return corsResponse({
    success: true,
    room: {
      id:          cfg.room_id     || ROOM_ID,
      name:        cfg.room_name   || 'Room',
      description: cfg.description || '',
      status:      cfg.room_status || 'active',
      createdAt:   cfg.created_at  || '',
      // Presence of a password hash = locked. The hash itself never leaves.
      passwordLocked: !!(cfg.room_password_hash && cfg.room_password_hash !== ''),
    }
  });
}

// ── GET /members ──────────────────────────────────────────────────
function handleGetMembers(e) {
  var sheet = getSheet('members');
  var lastRow = sheet.getLastRow();
  var startRow = Math.max(2, lastRow - 199);
  var data = lastRow >= 2 ? sheet.getRange(startRow, 1, lastRow - startRow + 1, 9).getValues() : [];
  var members = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (!row[0]) continue;
    if (row[6] === true || row[6] === 'TRUE') continue;
    members.push({
      memberId:    row[0],
      displayName: row[1],
      joinedAt:    row[2],
      lastSeen:    row[3],
      status:      row[4],
      role:        row[5],
    });
  }
  return corsResponse({ success: true, members: members });
}

// ── POST join ─────────────────────────────────────────────────────
function handleJoin(body) {
  var displayName   = sheetText(String(body.displayName || '').trim().substring(0, 50));
  var memberId      = body.memberId;

  if (!displayName) return errorResponse('Display name required', 'INVALID');

  var cfg = getRoomConfig();
  if (cfg.room_status === 'disabled') return errorResponse('Room is disabled', 'DISABLED');
  if (cfg.room_status === 'deleted')  return errorResponse('Room has been deleted', 'DELETED');

  // Join flood guard (global bucket — memberIds are client-chosen).
  if (!checkRateLimit('join_global', 30, 60)) return errorResponse('Too many joins — try again in a minute', 'RATE_LIMITED');

  // Password-locked rooms: the client sends a SHA-256 verifier, never the
  // password itself. Missing/wrong → distinct codes so the UI can re-prompt.
  var needPw = cfg.room_password_hash && cfg.room_password_hash !== '';
  if (needPw && String(body.passwordHash || '') !== String(cfg.room_password_hash)) {
    return errorResponse(body.passwordHash ? 'Wrong room password' : 'This room needs a password', body.passwordHash ? 'WRONG_PASSWORD' : 'PASSWORD_REQUIRED');
  }

  var sheet = getSheet('members');
  var data  = sheet.getDataRange().getValues();

  if (memberId) {
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === memberId) {
        var banned = data[i][6];
        if (banned === true || banned === 'TRUE') return errorResponse('You have been banned', 'BANNED');
        var newToken = Utilities.getUuid();
        sheet.getRange(i + 1, 9).setValue(newToken);
        sheet.getRange(i + 1, 5).setValue('online');
        sheet.getRange(i + 1, 4).setValue(now());
        sheet.getRange(i + 1, 8).setValue('TRUE');
        return corsResponse({ success: true, memberId: memberId, sessionToken: newToken, displayName: data[i][1], role: data[i][5] });
      }
    }
  }

  var newMemberId  = generateId('u');
  var sessionToken = Utilities.getUuid();
  var role = 'member'; // Never auto-promote: first joiner must not become owner

  sheet.appendRow([newMemberId, displayName, now(), now(), 'online', role, 'FALSE', 'TRUE', sessionToken]);

  return corsResponse({ success: true, memberId: newMemberId, sessionToken: sessionToken, displayName: displayName, role: role });
}

// ── GET /messages ─────────────────────────────────────────────────
function handleGetMessages(e) {
  var afterRow = parseInt(e.parameter && e.parameter.afterRow, 10);
  if (!isFinite(afterRow) || afterRow < 0) afterRow = 0;
  var requestedLimit = parseInt(e.parameter && e.parameter.limit, 10);
  var limit = (!isFinite(requestedLimit) || requestedLimit < 1) ? 50 : Math.min(requestedLimit, 50);

  var sheet   = getSheet('messages');
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) return corsResponse({ success: true, messages: [], lastRow: 1 });

  var startRow = Math.max(2, afterRow > 0 ? afterRow + 1 : Math.max(2, lastRow - limit + 1));
  if (startRow > lastRow) return corsResponse({ success: true, messages: [], lastRow: lastRow });

  // Bound both the sheet read and response. Return the page cursor, not the
  // sheet's final row, so clients can fetch subsequent pages without skips.
  var numRows = Math.min(limit, lastRow - startRow + 1);
  var data    = sheet.getRange(startRow, 1, numRows, 9).getValues();

  var messages = [];
  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    if (!row[0]) continue;
    var isDeleted = (row[8] === true || row[8] === 'TRUE');
    messages.push({
      id:          row[0],
      createdAt:   row[1] ? new Date(row[1]).toISOString() : '',
      senderId:    row[2],
      senderName:  row[3],
      messageType: row[4] || 'text',
      message:     isDeleted ? null : row[5],
      replyTo:     row[6] || null,
      edited:      (row[7] === true || row[7] === 'TRUE'),
      deleted:     isDeleted,
      _row:        startRow + i,
    });
  }

  return corsResponse({ success: true, messages: messages, lastRow: startRow + numRows - 1 });
}

// ── POST message ──────────────────────────────────────────────────
function handleSendMessage(body) {
  var memberId     = body.memberId;
  var sessionToken = body.sessionToken;
  var messageId    = String(body.messageId || '').substring(0, 128);
  var message      = String(body.message || '').trim();
  var replyTo      = String(body.replyTo || '').substring(0, 128);
  var messageType  = (body.messageType === 'image' || body.messageType === 'file' || body.messageType === 'audio') ? body.messageType : 'text';

  if (!validateSession(memberId, sessionToken)) {
    var displayName = String(body.displayName || body.senderName || 'Member').trim().substring(0, 50);
    var joinRes = handleJoin({ displayName: displayName, memberId: memberId });
    try {
      var parsed = JSON.parse(joinRes.getContent());
      if (parsed && parsed.success) {
        memberId = parsed.memberId;
        sessionToken = parsed.sessionToken;
      }
    } catch(e) {}
    // Heal-or-reject: a failed rejoin (banned, locked room, missing room
    // password…) must NOT silently write as 'Unknown' like before.
    if (!validateSession(memberId, sessionToken)) {
      return errorResponse('Invalid session — please rejoin', 'UNAUTHORIZED');
    }
  }
  // Flood guard: generous for humans (30/min), fatal for scripts.
  if (!checkRateLimit('send_' + memberId, 30, 60)) {
    return errorResponse('Too fast — slow down a little', 'RATE_LIMITED');
  }
  if (!message) return errorResponse('Message cannot be empty', 'INVALID');
  if (messageType === 'text' && message.length > 4000) return errorResponse('Message too long', 'TOO_LONG');
  if (message.length > 45000) return errorResponse('Message/attachment exceeds the safe spreadsheet cell limit', 'TOO_LARGE');

  var cfg = getRoomConfig();
  if (cfg.room_status === 'disabled') return errorResponse('Room is disabled', 'DISABLED');
  if (cfg.room_status === 'locked')   return errorResponse('Room is locked', 'LOCKED');
  if (cfg.room_status === 'deleted')  return errorResponse('Room has been deleted', 'DELETED');

  var msgSheet = getSheet('messages');
  if (messageId) {
    var col1 = msgSheet.getRange(2, 1, Math.max(1, msgSheet.getLastRow() - 1), 1).getValues();
    for (var i = 0; i < col1.length; i++) {
      if (col1[i][0] === messageId) return corsResponse({ success: true, messageId: messageId, duplicate: true });
    }
  }

  var memberRow   = getMemberRow(memberId);
  var displayName = memberRow ? memberRow.data[1] : 'Unknown';
  var msgId       = messageId || generateId('m');

  msgSheet.appendRow([sheetText(msgId), now(), sheetText(memberId), sheetText(displayName), messageType, sheetText(message), sheetText(replyTo), 'FALSE', 'FALSE']);

  if (memberRow) {
    getSheet('members').getRange(memberRow.row, 4).setValue(now());
  }

  return corsResponse({ success: true, messageId: msgId });
}

// ── POST edit ─────────────────────────────────────────────────────
function handleEditMessage(body) {
  var memberId     = body.memberId;
  var sessionToken = body.sessionToken;
  var messageId    = body.messageId;
  var newMessage   = String(body.message || '').trim();

  if (!validateSession(memberId, sessionToken)) return errorResponse('Invalid session', 'UNAUTHORIZED');
  if (!newMessage) return errorResponse('Message cannot be empty', 'INVALID');
  if (newMessage.length > 4000) return errorResponse('Message too long', 'TOO_LONG');

  var sheet = getSheet('messages');
  var data  = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === messageId) {
      if (data[i][2] !== memberId) return errorResponse('Not your message', 'FORBIDDEN');
      if (data[i][8] === true || data[i][8] === 'TRUE') return errorResponse('Message is deleted', 'DELETED');
      sheet.getRange(i + 1, 6).setValue(sheetText(newMessage));
      sheet.getRange(i + 1, 8).setValue('TRUE');
      return corsResponse({ success: true, messageId: messageId });
    }
  }

  return errorResponse('Message not found', 'NOT_FOUND');
}

// ── POST delete ───────────────────────────────────────────────────
function handleDeleteMessage(body) {
  var memberId     = body.memberId;
  var sessionToken = body.sessionToken;
  var messageId    = body.messageId;

  if (!validateSession(memberId, sessionToken)) return errorResponse('Invalid session', 'UNAUTHORIZED');

  var sheet     = getSheet('messages');
  var data      = sheet.getDataRange().getValues();
  var memberRow = getMemberRow(memberId);
  var isOwner   = memberRow && (memberRow.data[5] === 'owner');

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === messageId) {
      if (!isOwner && data[i][2] !== memberId) return errorResponse('Not your message', 'FORBIDDEN');
      sheet.getRange(i + 1, 6).setValue('');
      sheet.getRange(i + 1, 9).setValue('TRUE');
      return corsResponse({ success: true, messageId: messageId });
    }
  }

  return errorResponse('Message not found', 'NOT_FOUND');
}

// ── POST presence ─────────────────────────────────────────────────
function handlePresence(body) {
  var memberId     = body.memberId;
  var sessionToken = body.sessionToken;
  var status       = body.status || 'online';

  if (!validateSession(memberId, sessionToken)) return corsResponse({ success: false });

  var memberRow = getMemberRow(memberId);
  if (memberRow) {
    getSheet('members').getRange(memberRow.row, 4).setValue(now());
    getSheet('members').getRange(memberRow.row, 5).setValue(status);
  }

  return corsResponse({ success: true });
}

// ── POST leave ────────────────────────────────────────────────────
function handleLeave(body) {
  var memberId     = body.memberId;
  var sessionToken = body.sessionToken;

  if (!validateSession(memberId, sessionToken)) return corsResponse({ success: false });

  var memberRow = getMemberRow(memberId);
  if (memberRow) {
    getSheet('members').getRange(memberRow.row, 4).setValue(now());
    getSheet('members').getRange(memberRow.row, 5).setValue('offline');
    getSheet('members').getRange(memberRow.row, 9).setValue('');
  }

  return corsResponse({ success: true });
}

// ── POST room_op ──────────────────────────────────────────────────
function handleRoomOp(body) {
  var memberId     = body.memberId;
  var sessionToken = body.sessionToken;
  var op           = body.op;

  if (!validateSession(memberId, sessionToken)) return errorResponse('Invalid session', 'UNAUTHORIZED');

  var memberRow = getMemberRow(memberId);
  if (!memberRow || memberRow.data[5] !== 'owner') return errorResponse('Owner only', 'FORBIDDEN');

  if (op === 'lock')    { updateConfig('room_status', 'locked');   return corsResponse({ success: true }); }
  if (op === 'unlock')  { updateConfig('room_status', 'active');   return corsResponse({ success: true }); }
  if (op === 'disable') { updateConfig('room_status', 'disabled'); return corsResponse({ success: true }); }
  if (op === 'enable')  { updateConfig('room_status', 'active');   return corsResponse({ success: true }); }
  if (op === 'delete')  { updateConfig('room_status', 'deleted');  return corsResponse({ success: true }); }

  if (op === 'rename') {
    var newName = String(body.name || '').trim().substring(0, 80);
    if (!newName) return errorResponse('Name required', 'INVALID');
    updateConfig('room_name', newName);
    return corsResponse({ success: true });
  }

  if (op === 'ban_member') {
    var targetId = body.targetId;
    var mRow = getMemberRow(targetId);
    if (mRow) {
      getSheet('members').getRange(mRow.row, 7).setValue('TRUE');
      getSheet('members').getRange(mRow.row, 8).setValue('FALSE');
    }
    return corsResponse({ success: true });
  }

  if (op === 'remove_member') {
    var targetId = body.targetId;
    var mRow = getMemberRow(targetId);
    if (mRow) {
      getSheet('members').getRange(mRow.row, 8).setValue('FALSE');
      getSheet('members').getRange(mRow.row, 9).setValue('');
    }
    return corsResponse({ success: true });
  }

  if (op === 'set_password') {
    // Owner locks the room: clients send a SHA-256 verifier, never the password.
    var hash = String(body.passwordHash || '').trim();
    if (!/^[0-9a-f]{64}$/i.test(hash)) return errorResponse('Bad password verifier', 'INVALID');
    updateConfig('room_password_hash', hash.toLowerCase());
    // Kill every OTHER session: pre-lock members must rejoin with the password.
    try {
      var msheet = getSheet('members');
      var mdata  = msheet.getDataRange().getValues();
      for (var i = 1; i < mdata.length; i++) {
        if (mdata[i][0] && String(mdata[i][0]) !== String(memberId)) {
          msheet.getRange(i + 1, 9).setValue('');
        }
      }
    } catch (e) {}
    return corsResponse({ success: true, passwordLocked: true });
  }

  if (op === 'remove_password') {
    updateConfig('room_password_hash', '');
    return corsResponse({ success: true, passwordLocked: false });
  }

  if (op === 'get_stats') {    var membersSheet  = getSheet('members');
    var messagesSheet = getSheet('messages');
    var memberCount   = Math.max(0, membersSheet.getLastRow()  - 1);
    var messageCount  = Math.max(0, messagesSheet.getLastRow() - 1);
    return corsResponse({ success: true, memberCount: memberCount, messageCount: messageCount });
  }

  if (op === 'clear_chat') {
    var msgSheet = getSheet('messages');
    var lastRow = msgSheet.getLastRow();
    if (lastRow > 1) {
      // Wipe the CONTENT but keep the rows.
      //
      // The client's incremental cursor is a ROW NUMBER. clearContents()
      // would shrink the sheet back to its header row, so every client
      // would keep asking for (old cursor + 1) of a 1-row sheet and the
      // room would never receive another message. Soft-deleting the rows
      // (exactly what a normal delete does) removes the text from the
      // owner's Drive while leaving the row counter intact.
      var msgData = msgSheet.getRange(2, 1, lastRow - 1, 9).getValues();
      for (var i = 0; i < msgData.length; i++) {
        msgData[i][4] = 'text';   // messageType
        msgData[i][5] = '';       // message content
        msgData[i][6] = '';       // replyTo
        msgData[i][7] = 'FALSE';  // edited
        msgData[i][8] = 'TRUE';   // deleted
      }
      msgSheet.getRange(2, 1, lastRow - 1, 9).setValues(msgData);
    }
    return corsResponse({ success: true });
  }

  return errorResponse('Unknown operation', 'NOT_FOUND');
}
