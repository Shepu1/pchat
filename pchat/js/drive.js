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

  // ── Get file metadata ─────────────────────────────────────────
  async function getFile(fileId, fields = 'id,name,webViewLink,createdTime') {
    return GoogleAPI.get(`${BASE}/files/${fileId}?fields=${fields}`);
  }

  // ── Get web view link ─────────────────────────────────────────
  async function getWebViewLink(fileId) {
    const file = await getFile(fileId, 'webViewLink');
    return file.webViewLink;
  }

  // ── Delete a file ─────────────────────────────────────────────
  async function deleteFile(fileId) {
    await GoogleAPI.delete(`${BASE}/files/${fileId}`);
  }

  // ── Move file to trash (soft delete) ─────────────────────────
  async function trashFile(fileId) {
    return GoogleAPI.patch(`${BASE}/files/${fileId}`, { trashed: true });
  }

  return {
    getOrCreateFolder,
    createSpreadsheet,
    getFile,
    getWebViewLink,
    deleteFile,
    trashFile,
  };
})();

window.Drive = Drive;
