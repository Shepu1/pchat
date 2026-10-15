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
    var body   = JSON.parse(e.postData.contents);
    var action = body.action;

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

// ── Rate limiting ──────────────────────────────────────────────────
var _rateLimitCache = {};
function checkRateLimit(memberId) {
  var key  = memberId;
  var now_ = Date.now();
  if (!_rateLimitCache[key]) _rateLimitCache[key] = { count: 0, window: now_ };
  var rl = _rateLimitCache[key];
  if (now_ - rl.window > 10000) { rl.count = 0; rl.window = now_; }
  rl.count++;
  return rl.count <= 20;
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
    }
  });
}

// ── GET /members ──────────────────────────────────────────────────
function handleGetMembers(e) {
  var sheet = getSheet('members');
  var data  = sheet.getDataRange().getValues();
  var members = [];
  for (var i = 1; i < data.length; i++) {
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
  var displayName   = String(body.displayName || '').trim().substring(0, 50);
  var memberId      = body.memberId;
  var existingToken = body.sessionToken;

  if (!displayName) return errorResponse('Display name required', 'INVALID');

  var cfg = getRoomConfig();
  if (cfg.room_status === 'disabled') return errorResponse('Room is disabled', 'DISABLED');
  if (cfg.room_status === 'deleted')  return errorResponse('Room has been deleted', 'DELETED');

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
  var afterRow = parseInt(e.parameter && e.parameter.afterRow) || 0;
  var limit    = Math.min(parseInt(e.parameter && e.parameter.limit) || 50, 100);

  var sheet   = getSheet('messages');
  var lastRow = sheet.getLastRow();

  if (lastRow <= 1) return corsResponse({ success: true, messages: [], lastRow: 1 });

  var startRow = Math.max(2, afterRow > 0 ? afterRow + 1 : Math.max(2, lastRow - limit + 1));
  if (startRow > lastRow) return corsResponse({ success: true, messages: [], lastRow: lastRow });

  var numRows = lastRow - startRow + 1;
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

  return corsResponse({ success: true, messages: messages, lastRow: lastRow });
}

// ── POST message ──────────────────────────────────────────────────
function handleSendMessage(body) {
  var memberId     = body.memberId;
  var sessionToken = body.sessionToken;
  var messageId    = body.messageId;
  var message      = String(body.message || '').trim();
  var replyTo      = body.replyTo || '';
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
  }
  if (!message) return errorResponse('Message cannot be empty', 'INVALID');
  if (messageType === 'text' && message.length > 4000) return errorResponse('Message too long', 'TOO_LONG');

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

  msgSheet.appendRow([msgId, now(), memberId, displayName, messageType, message, replyTo, 'FALSE', 'FALSE']);

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

  var sheet = getSheet('messages');
  var data  = sheet.getDataRange().getValues();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === messageId) {
      if (data[i][2] !== memberId) return errorResponse('Not your message', 'FORBIDDEN');
      if (data[i][8] === true || data[i][8] === 'TRUE') return errorResponse('Message is deleted', 'DELETED');
      sheet.getRange(i + 1, 6).setValue(newMessage);
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

  if (op === 'get_stats') {
    var membersSheet  = getSheet('members');
    var messagesSheet = getSheet('messages');
    var memberCount   = Math.max(0, membersSheet.getLastRow()  - 1);
    var messageCount  = Math.max(0, messagesSheet.getLastRow() - 1);
    return corsResponse({ success: true, memberCount: memberCount, messageCount: messageCount });
  }

  if (op === 'clear_chat') {
    var msgSheet = getSheet('messages');
    var headers  = msgSheet.getRange(1, 1, 1, 9).getValues();
    msgSheet.clearContents();
    msgSheet.getRange(1, 1, 1, 9).setValues(headers);
    return corsResponse({ success: true });
  }

  return errorResponse('Unknown operation', 'NOT_FOUND');
}
