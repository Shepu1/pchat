/**
 * SHEPU ROOMS — sheets.js
 * Google Sheets API v4 operations:
 * - Create/initialize sheets (tabs)
 * - Write headers
 * - Write room_config
 * - Read/write values (used only by the owner for setup)
 *
 * NOTE: During chat, ALL read/write goes through the Apps Script endpoint.
 * Sheets API here is only used during room creation and owner operations.
 */

const Sheets = (() => {
  const BASE = CONFIG.SHEETS_API;

  // ── Sheet tab definitions ─────────────────────────────────────
  // NOTE: headers must match apps-script/Code.gs getSheet() schema
  // (camelCase + members.sessionToken in column 9) so validateSession works.
  const SHEET_TABS = [
    {
      name: CONFIG.SHEETS.MESSAGES,
      headers: ['id','createdAt','senderId','senderName','messageType','message','replyTo','edited','deleted'],
    },
    {
      name: CONFIG.SHEETS.MEMBERS,
      headers: ['memberId','displayName','joinedAt','lastSeen','status','role','banned','active','sessionToken'],
    },
    {
      name: CONFIG.SHEETS.ROOM_CONFIG,
      headers: ['key','value'],
    },
    {
      name: CONFIG.SHEETS.ATTACHMENTS,
      headers: ['attachment_id','message_id','file_id','file_name','mime_type','size','created_at'],
    },
    {
      name: CONFIG.SHEETS.MODERATION,
      headers: ['action_id','timestamp','actor_id','target_id','action','reason'],
    },
    {
      name: CONFIG.SHEETS.SYNC_STATE,
      headers: ['key','value'],
    },
  ];

  // ── Initialize all tabs in a newly created Spreadsheet ────────
  async function initializeSpreadsheet(spreadsheetId, roomConfig) {
    // Step 1: Add required sheets (first sheet is auto-created as "Sheet1")
    // Rename Sheet1 → messages, then add the rest
    const addSheetsRequests = SHEET_TABS.map((tab, i) => {
      if (i === 0) {
        return { updateSheetProperties: {
          properties: { sheetId: 0, title: tab.name },
          fields: 'title',
        }};
      }
      return { addSheet: { properties: { title: tab.name } } };
    });

    await batchUpdate(spreadsheetId, addSheetsRequests);

    // Step 2: Fetch sheet IDs
    const meta = await getSpreadsheetMeta(spreadsheetId);
    const sheetMap = {};
    meta.sheets.forEach(s => { sheetMap[s.properties.title] = s.properties.sheetId; });

    // Step 3: Write headers to each tab
    const writeHeadersRequests = [];
    for (const tab of SHEET_TABS) {
      writeHeadersRequests.push({
        updateCells: {
          range: {
            sheetId:          sheetMap[tab.name],
            startRowIndex:    0,
            endRowIndex:      1,
            startColumnIndex: 0,
            endColumnIndex:   tab.headers.length,
          },
          rows: [{
            values: tab.headers.map(h => ({
              userEnteredValue: { stringValue: h },
              userEnteredFormat: {
                textFormat: { bold: true },
                backgroundColor: { red: 0.07, green: 0.09, blue: 0.13 },
              },
            })),
          }],
          fields: 'userEnteredValue,userEnteredFormat',
        },
      });
    }

    await batchUpdate(spreadsheetId, writeHeadersRequests);

    // Step 4: Write room_config
    const configRows = Object.entries(roomConfig).map(([key, value]) => [key, String(value)]);
    await appendRows(spreadsheetId, CONFIG.SHEETS.ROOM_CONFIG, configRows);

    return sheetMap;
  }

  // ── Batch update ─────────────────────────────────────────────
  async function batchUpdate(spreadsheetId, requests) {
    return GoogleAPI.post(`${BASE}/${spreadsheetId}:batchUpdate`, { requests });
  }

  // ── Get spreadsheet metadata ──────────────────────────────────
  async function getSpreadsheetMeta(spreadsheetId) {
    return GoogleAPI.get(`${BASE}/${spreadsheetId}?fields=sheets.properties`);
  }

  // ── Append rows to a sheet ────────────────────────────────────
  async function appendRows(spreadsheetId, sheetName, rows) {
    const values = rows;
    return GoogleAPI.post(
      `${BASE}/${spreadsheetId}/values/${encodeURIComponent(sheetName)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      { values }
    );
  }

  // ── Read values from a sheet ──────────────────────────────────
  async function readValues(spreadsheetId, range) {
    const res = await GoogleAPI.get(
      `${BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}`
    );
    return res.values || [];
  }

  // ── Update a single cell ──────────────────────────────────────
  // Supports columns beyond Z (AA, AB, ...) via base-26 conversion.
  async function updateCell(spreadsheetId, sheetName, row, col, value) {
    let n = col;
    let colLetter = '';
    while (n > 0) {
      const rem = (n - 1) % 26;
      colLetter = String.fromCharCode(65 + rem) + colLetter;
      n = Math.floor((n - 1) / 26);
    }
    const range = `${sheetName}!${colLetter}${row}`;
    return GoogleAPI.put(
      `${BASE}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
      { values: [[value]] }
    );
  }

  // ── Clear sheet content (keep headers) ────────────────────────
  async function clearSheet(spreadsheetId, sheetName) {
    // Read header row first
    const headers = await readValues(spreadsheetId, `${sheetName}!1:1`);
    // Clear all
    await GoogleAPI.post(
      `${BASE}/${spreadsheetId}/values/${encodeURIComponent(sheetName)}:clear`,
      {}
    );
    // Restore header
    if (headers.length) {
      await GoogleAPI.put(
        `${BASE}/${spreadsheetId}/values/${encodeURIComponent(sheetName + '!A1')}?valueInputOption=USER_ENTERED`,
        { values: headers }
      );
    }
  }

  // ── Read config values from room_config sheet ─────────────────
  async function readRoomConfig(spreadsheetId) {
    const rows = await readValues(spreadsheetId, `${CONFIG.SHEETS.ROOM_CONFIG}!A:B`);
    const config = {};
    rows.slice(1).forEach(row => {
      if (row[0]) config[row[0]] = row[1] || '';
    });
    return config;
  }

  // ── Update a config key ───────────────────────────────────────
  async function updateRoomConfigKey(spreadsheetId, key, value) {
    // Read current config rows to find the key's row number.
    // NOTE: row 1 is the header ['key','value'] — never overwrite it,
    // even if key === 'key'.
    const rows = await readValues(spreadsheetId, `${CONFIG.SHEETS.ROOM_CONFIG}!A:A`);
    let rowIdx = -1;
    for (let i = 1; i < rows.length; i++) {
      if (rows[i][0] === key) { rowIdx = i; break; }
    }

    if (rowIdx === -1) {
      // Append new key
      await appendRows(spreadsheetId, CONFIG.SHEETS.ROOM_CONFIG, [[key, value]]);
    } else {
      // Update existing row (rowIdx is 0-based, Sheets rows are 1-based)
      await updateCell(spreadsheetId, CONFIG.SHEETS.ROOM_CONFIG, rowIdx + 1, 2, value);
    }
  }

  return {
    initializeSpreadsheet,
    batchUpdate,
    getSpreadsheetMeta,
    appendRows,
    readValues,
    updateCell,
    clearSheet,
    readRoomConfig,
    updateRoomConfigKey,
    SHEET_TABS,
  };
})();

window.Sheets = Sheets;
