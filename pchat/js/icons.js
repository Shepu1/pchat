/**
 * SHEPU ROOMS — icons.js
 * Crisp, ultra-modern Lucide-style SVG icon system.
 */

const Icons = {
  svg(path, size = 20, className = '') {
    return `<svg class="icon-svg ${className}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  },

  logo(size = 24) {
    return `<svg class="icon-svg" width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="logo-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop stop-color="#6366f1" />
          <stop offset="0.5" stop-color="#a855f7" />
          <stop offset="1" stop-color="#ec4899" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="10" fill="url(#logo-grad)" />
      <path d="M10 16.5C10 12.91 12.91 10 16.5 10C20.09 10 23 12.91 23 16.5C23 20.09 20.09 23 16.5 23H10V16.5Z" fill="white" fill-opacity="0.9" />
      <circle cx="16.5" cy="16.5" r="2.5" fill="#6366f1" />
    </svg>`;
  },

  chat(size = 20) {
    return this.svg('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>', size);
  },

  send(size = 18) {
    return this.svg('<line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>', size);
  },

  plus(size = 20) {
    return this.svg('<line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>', size);
  },

  qr(size = 20) {
    return this.svg('<rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><path d="M7 7h.01M17 7h.01M7 17h.01M17 17h.01"></path>', size);
  },

  shield(size = 20) {
    return this.svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>', size);
  },

  lock(size = 18) {
    return this.svg('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>', size);
  },

  unlock(size = 18) {
    return this.svg('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 9.9-1"></path>', size);
  },

  key(size = 18) {
    return this.svg('<circle cx="7.5" cy="15.5" r="5.5"></circle><path d="m21 2-9.6 9.6M15.5 7.5l3 3M18.5 4.5l3 3"></path>', size);
  },

  users(size = 20) {
    return this.svg('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>', size);
  },

  settings(size = 20) {
    return this.svg('<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>', size);
  },

  copy(size = 16) {
    return this.svg('<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>', size);
  },

  check(size = 16) {
    return this.svg('<polyline points="20 6 9 17 4 12"></polyline>', size);
  },

  doubleCheck(size = 16) {
    return this.svg('<path d="M18 6L7 17l-5-5"></path><path d="M22 10l-7.5 7.5L13 16"></path>', size);
  },

  paperclip(size = 18) {
    return this.svg('<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>', size);
  },

  smile(size = 18) {
    return this.svg('<circle cx="12" cy="12" r="10"></circle><path d="M8 14s1.5 2 4 2 4-2 4-2"></path><line x1="9" y1="9" x2="9.01" y2="9"></line><line x1="15" y1="9" x2="15.01" y2="9"></line>', size);
  },

  search(size = 18) {
    return this.svg('<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>', size);
  },

  share(size = 16) {
    return this.svg('<circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>', size);
  },

  arrowLeft(size = 20) {
    return this.svg('<line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline>', size);
  },

  close(size = 18) {
    return this.svg('<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>', size);
  },

  trash(size = 16) {
    return this.svg('<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>', size);
  },

  edit(size = 16) {
    return this.svg('<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>', size);
  },

  reply(size = 16) {
    return this.svg('<polyline points="9 17 4 12 9 7"></polyline><path d="M20 18v-2a4 4 0 0 0-4-4H4"></path>', size);
  },

  moreVertical(size = 18) {
    return this.svg('<circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="19" r="1"></circle>', size);
  },

  sparkles(size = 18) {
    return this.svg('<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"></path>', size);
  },

  wifi(size = 18) {
    return this.svg('<path d="M5 12.55a11 11 0 0 1 14.08 0"></path><path d="M1.42 9a16 16 0 0 1 21.16 0"></path><path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path><line x1="12" y1="20" x2="12.01" y2="20"></line>', size);
  },

  globe(size = 18) {
    return this.svg('<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>', size);
  },

  phone(size = 18) {
    return this.svg('<rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line>', size);
  },

  laptop(size = 18) {
    return this.svg('<rect x="3" y="4" width="18" height="12" rx="2"></rect><line x1="2" y1="20" x2="22" y2="20"></line>', size);
  },

  dice(size = 18) {
    return this.svg('<rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><circle cx="15.5" cy="8.5" r="1.5"></circle><circle cx="15.5" cy="15.5" r="1.5"></circle><circle cx="8.5" cy="15.5" r="1.5"></circle>', size);
  },

  help(size = 16) {
    return this.svg('<circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line>', size);
  },

  fire(size = 18) {
    return this.svg('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 17c1.38 0 2.5-1.12 2.5-2.5 0-1.63-1.07-2.67-1.74-3.32-.4-.39-.76-.74-.76-1.18 0-.44.33-.8.75-.8.56 0 1.25.32 1.75.82 1.5 1.5 2.5 3.5 2.5 6A6.5 6.5 0 0 1 2 16c0-3.5 2.5-6.5 5-8.5.5 1 1.5 2 1.5 3.5 0 .5-.25.96-.5 1.4-.41.72-.5 1.5-.5 2.1z"></path>', size);
  },

  rocket(size = 18) {
    return this.svg('<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"></path><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"></path><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"></path><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"></path>', size);
  },

  // ── Additional Icons ──────────────────────────────────────────

  crown(size = 18) {
    return this.svg('<path d="M2 20h20M5 20V10l7-7 7 7v10"></path><path d="M9 20v-5h6v5"></path>', size);
  },

  coffee(size = 18) {
    return this.svg('<path d="M17 8h1a4 4 0 1 1 0 8h-1"></path><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"></path><line x1="6" x2="6" y1="2" y2="4"></line><line x1="10" x2="10" y1="2" y2="4"></line><line x1="14" x2="14" y1="2" y2="4"></line>', size);
  },

  music(size = 18) {
    return this.svg('<path d="M9 18V5l12-2v13"></path><circle cx="6" cy="18" r="3"></circle><circle cx="18" cy="16" r="3"></circle>', size);
  },

  gamepad(size = 18) {
    return this.svg('<line x1="6" y1="12" x2="10" y2="12"></line><line x1="8" y1="10" x2="8" y2="14"></line><line x1="15" y1="13" x2="15.01" y2="13"></line><line x1="18" y1="11" x2="18.01" y2="11"></line><rect x="2" y="6" width="20" height="12" rx="2"></rect>', size);
  },

  star(size = 18) {
    return this.svg('<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>', size);
  },

  zap(size = 18) {
    return this.svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>', size);
  },

  checkCircle(size = 18) {
    return this.svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline>', size);
  },

  spreadsheet(size = 18) {
    return this.svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="16" y2="17"></line><line x1="8" y1="9" x2="10" y2="9"></line>', size);
  },

  link(size = 18) {
    return this.svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>', size);
  },

  shieldCheck(size = 18) {
    return this.svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><polyline points="9 12 11 14 15 10"></polyline>', size);
  },

  user(size = 18) {
    return this.svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>', size);
  },

  logout(size = 18) {
    return this.svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line>', size);
  },

  invite(size = 18) {
    return this.svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line>', size);
  },

  pizza(size = 18) {
    return this.svg('<circle cx="12" cy="12" r="10"></circle><polygon points="12 2 15 22 9 22"></polygon><circle cx="10" cy="10" r="1.5"></circle><circle cx="14" cy="14" r="1.5"></circle>', size);
  },

  warning(size = 18) {
    return this.svg('<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>', size);
  },

  info(size = 18) {
    return this.svg('<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>', size);
  },

  clock(size = 18) {
    return this.svg('<circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline>', size);
  },

  folder(size = 18) {
    return this.svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>', size);
  },

  database(size = 18) {
    return this.svg('<ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"></path><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"></path>', size);
  },

  external(size = 16) {
    return this.svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>', size);
  },

  export(size = 16) {
    return this.svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line>', size);
  },

  pause(size = 16) {
    return this.svg('<rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect>', size);
  },

  ban(size = 18) {
    return this.svg('<circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>', size);
  },

  wave(size = 20) {
    return this.svg('<path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"></path><path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"></path><path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"></path><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 13"></path>', size);
  },

  bell(size = 18) {
    return this.svg('<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path>', size);
  },

  file(size = 18) {
    return this.svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>', size);
  },

  refresh(size = 16) {
    return this.svg('<polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>', size);
  },

  // ── Room-icon picker set ──────────────────────────────────────
  // The create-room picker offers these eight; every one of them must
  // resolve to a real icon or the picker's choice is silently dropped.

  trend(size = 20) {
    return this.svg('<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline><polyline points="16 7 22 7 22 13"></polyline>', size);
  },

  game(size = 20) {
    return this.svg('<line x1="6" y1="11" x2="6" y2="13"></line><line x1="5" y1="12" x2="7" y2="12"></line><line x1="7" y1="12" x2="7" y2="12"></line><line x1="15" y1="12" x2="15" y2="12"></line><line x1="14" y1="11" x2="14" y2="13"></line><line x1="16" y1="11" x2="16" y2="13"></line><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14 2 14a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-1h12v1a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2c0-3.5-.68-6.258-1.685-8.258A4 4 0 0 0 17.32 5z"></path>', size);
  },

  chill(size = 20) {
    return this.svg('<path d="M17 8h1a4 4 0 1 1 0 8h-1"></path><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V8z"></path><path d="M6 1v3M10 1v3M14 1v3"></path>', size);
  },

  private(size = 20) {
    return this.svg('<rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>', size);
  },

  instant(size = 20) {
    return this.svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>', size);
  },

  // ── Render helper: returns an <span> wrapping the SVG ─────────
  // Usage in HTML: ${Icons.render('sparkles', 20, 'accent')}
  render(name, size = 20, colorClass = '') {
    if (!this[name]) return '';
    const svg = this[name](size);
    return `<span class="icon-wrap ${colorClass}" style="display:inline-flex;align-items:center;vertical-align:middle;">${svg}</span>`;
  },
};

window.Icons = Icons;
