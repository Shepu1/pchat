/**
 * SHEPU ROOMS — drive.js
 * Google Drive API v3 operations:
 * - Create SHEPU ROOMS folder
 * - Create Google Sheet in that folder
 * - File metadata
 */

const Drive = (() => {
  const BASE = CONFIG.DRIVE_API;

  // ── Find or create SHEPU ROOMS folder ────────────────────────
  async function getOrCreateFolder() {
    // Search for existing folder
    const query = encodeURIComponent(
      `name='${CONFIG.FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
    );
    const res = await GoogleAPI.get(`${BASE}/files?q=${query}&fields=files(id,name)&spaces=drive`);

    if (res.files && res.files.length > 0) {
      return res.files[0].id;
    }

    // Create the folder
    const folder = await GoogleAPI.post(`${BASE}/files`, {
      name:     CONFIG.FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    });

    return folder.id;
  }

  // ── Create a Google Sheet ─────────────────────────────────────
  async function createSpreadsheet(name, folderId) {
    const body = {
      name:    name,
      mimeType:'application/vnd.google-apps.spreadsheet',
      parents: folderId ? [folderId] : [],
    };

    const file = await GoogleAPI.post(`${BASE}/files`, body);
    return file; // { id, name, webViewLink, ... }
  }

  return {
    getOrCreateFolder,
    createSpreadsheet,
  };
})();

window.Drive = Drive;
