      document.addEventListener('DOMContentLoaded', () => {
        // ── Login is OPTIONAL. Quick rooms + joining work logged-out.
        // Google sign-in is asked on demand only when creating a Saved room.

        // ── Show user profile in header ───────────────────────────────
        const user = Auth.getUser();
        const avatarBtn = document.getElementById('user-avatar-btn');
        const avatarInitials = document.getElementById('user-avatar-initials');
        const avatarImg = document.getElementById('user-avatar-img');
        // Effective identity: manual Settings photo → Google photo; name likewise.
        const savedName = (typeof localStorage !== 'undefined' && localStorage.getItem('shepu_display_name')) || '';
        const shownName = (user && (user.name || user.email)) || savedName || '?';
        const initials = shownName.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
        if (avatarInitials) avatarInitials.textContent = initials;
        const effPic = (typeof UI !== 'undefined' && UI.effectivePicture) ? UI.effectivePicture() : ((user && user.picture) || '');
        if (avatarImg && effPic) {
          avatarImg.src = effPic;
          avatarImg.style.display = 'block';
          if (avatarInitials) avatarInitials.style.display = 'none';
        }
        if (avatarBtn) {
          if (user) {
            avatarBtn.title = 'Account / Logout';
            avatarBtn.onclick = async () => {
              const ok = await UI.confirmDialog({
                title: 'Log out?',
                message: `Logged in as ${user?.name || user?.email || 'User'}`,
                confirmText: 'Log out',
                cancelText: 'Stay',
                danger: true,
              });
              if (ok) {
                Auth.signOut();
                window.location.reload();
              }
            };
          } else {
            // Logged out: avatar becomes an optional Login entry point
            avatarBtn.title = 'Log in (optional)';
            avatarBtn.onclick = () => {
              window.location.href = 'login.html?redirect=' + encodeURIComponent(location.href);
            };
          }
        }

        const chatListContainer = document.getElementById('chats-items');
        const chatLoading = document.getElementById('chats-loading');
        const chatEmpty = document.getElementById('chats-empty');
        const searchInput = document.getElementById('search-input');
        const clearBtn = document.getElementById('search-clear-btn');

        const fabCreate = document.getElementById('fab-create-btn');
        const navTabFriends = document.getElementById('nav-tab-friends');
        const emptyCreate = document.getElementById('empty-create-btn');
        const createSheet = document.getElementById('create-sheet');
        const closeCreate = document.getElementById('close-create-sheet');
        const createForm = document.getElementById('fast-create-form');
        const roomNameInput = document.getElementById('sheet-room-name');
        const randomBtn = document.getElementById('btn-sheet-random');

        const topJoin = document.getElementById('top-join-btn');
        const joinForm = document.getElementById('fast-join-form');
        const joinCodeInput = document.getElementById('join-code-input');

        // Desktop Card Form Elements
        const desktopCreateForm = document.getElementById('desktop-create-form');
        const desktopRoomName = document.getElementById('desktop-room-name');
        const desktopRandomBtn = document.getElementById('btn-desktop-random');
        const desktopJoinForm = document.getElementById('desktop-join-form');
        const desktopJoinCode = document.getElementById('desktop-join-code');
        const desktopShowQr = document.getElementById('btn-desktop-show-qr');

        const filterBtns = document.querySelectorAll('.chip-btn');
        let currentFilter = 'all';

        // Phone only "+": lives inside the Joined view and joins a room with
        // a link or room code. Creating a room keeps its original buttons
        // (the FAB and the bottom "New" tab).
        const mobilePlus = document.getElementById('mobile-new-btn');
        const mobilePlusRow = document.getElementById('mobile-new-row');
        const syncMobilePlus = () => {
          if (mobilePlusRow) mobilePlusRow.classList.toggle('is-joined', currentFilter === 'joined');
          if (!mobilePlus) return;
          const label = 'Join a room with a link or code';
          mobilePlus.title = label;
          mobilePlus.setAttribute('aria-label', label);
        };
        if (mobilePlus) {
          mobilePlus.onclick = () => { openJoinSheet(); };
          syncMobilePlus();
        }
        let allRooms = [];
        const randomNames = [
          'Night Owls', 'Coffee Chill', 'Game Squad', 'Secret Den',
          'Vibe Station', 'Tech Talk', 'Weekend Crew', 'Open Space'
        ];

        // ── Connection Mode selector (Quick P2P vs Saved Sheet-backup) ──
        let roomMode = 'instant';
        const MODE_HINTS = {
          instant: 'Quick rooms connect directly peer-to-peer — no sign-in, no cloud backup.',
          secure:  'Saved rooms auto-save every message to a Google Sheet in your Drive. Google sign-in required.',
        };
        const syncModePickers = (pickers) => {
          pickers.forEach(btns => {
            btns.forEach(b => {
              b.classList.toggle('active', b.dataset.mode === roomMode);
            });
          });
        };
        const sheetModeBtns   = Array.from(document.querySelectorAll('#sheet-mode-picker .hub-mode-btn'));
        const desktopModeBtns = Array.from(document.querySelectorAll('#desktop-mode-picker .hub-mode-btn'));
        const sheetModeHint   = document.getElementById('sheet-mode-hint');
        const desktopModeHint = document.getElementById('desktop-mode-hint');
        const bindModePicker = (btns) => {
          btns.forEach(btn => {
            btn.addEventListener('click', () => {
              roomMode = btn.dataset.mode;
              syncModePickers([sheetModeBtns, desktopModeBtns]);
              if (sheetModeHint)   sheetModeHint.textContent   = MODE_HINTS[roomMode];
              if (desktopModeHint) desktopModeHint.textContent = MODE_HINTS[roomMode];
            });
          });
        };
        bindModePicker(sheetModeBtns);
        bindModePicker(desktopModeBtns);

        // Random Name generators
        const pickRandom = (inputEl) => {
          const pick = randomNames[Math.floor(Math.random() * randomNames.length)];
          inputEl.value = pick;
          inputEl.focus();
        };
        if (randomBtn && roomNameInput) randomBtn.onclick = () => pickRandom(roomNameInput);
        if (desktopRandomBtn && desktopRoomName) desktopRandomBtn.onclick = () => pickRandom(desktopRoomName);

        // Filter chips
        filterBtns.forEach(btn => {
          btn.onclick = () => {
            filterBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            currentFilter = btn.dataset.filter;
            syncMobilePlus();
            applyFilterAndRender();
          };
        });

        function applyFilterAndRender() {
          let list = allRooms;
          if (currentFilter === 'my') list = allRooms.filter(r => r.isOwner);
          if (currentFilter === 'joined') list = allRooms.filter(r => !r.isOwner);

          const q = (searchInput.value || '').trim().toLowerCase();
          if (q) {
            list = list.filter(r => (r.name || '').toLowerCase().includes(q) || (r.id || '').toLowerCase().includes(q));
          }
          renderRooms(list);
        }

        function loadRooms() {
          chatLoading.style.display = 'block';
          chatListContainer.style.display = 'none';
          chatEmpty.style.display = 'none';

          try {
            const myRooms = Rooms.getMyRooms() || [];
            const joined = Rooms.getJoinedRooms() || [];

            const map = new Map();
            myRooms.forEach(r => map.set(r.id, { ...r, isOwner: true }));
            joined.forEach(r => { if (!map.has(r.id)) map.set(r.id, { ...r, isOwner: false }); });

            allRooms = Array.from(map.values()).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
            updateDesktopHubMeta();
            applyFilterAndRender();
          } catch (e) {
            console.error(e);
            chatLoading.style.display = 'none';
            chatEmpty.style.display = 'block';
          }
        }

        function renderRooms(rooms) {
          chatLoading.style.display = 'none';

          if (!rooms.length) {
            chatListContainer.style.display = 'none';
            chatEmpty.style.display = 'block';
            return;
          }

          chatEmpty.style.display = 'none';
          chatListContainer.style.display = 'flex';
          chatListContainer.innerHTML = '';

          rooms.forEach(room => {
            const item = document.createElement('div');
            item.className = 'chat-item';

            const cleanName = (room.name || 'R').replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\s]+/gu, '').trim();
            const initial = (cleanName[0] || (room.name || 'R').trim()[0] || 'R').toUpperCase();
            const timeStr = formatRelativeTime(room.createdAt || room.joinedAt);
            const roomIcon = (typeof Rooms !== 'undefined' && Rooms.roomIcon)
              ? Rooms.roomIcon(room, room.kind)
              : (room.spreadsheetId
                ? 'assets/icons/saved.webp'
                : ((typeof Rooms !== 'undefined' && Rooms.quickIconFor)
                  ? Rooms.quickIconFor(room)
                  : 'assets/icons/quick.webp'));

            item.innerHTML = `
        <div class="chat-avatar">
          ${initial.toUpperCase()}
          <img src="${roomIcon}" alt="" aria-hidden="true" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%;" onload="this.parentElement.classList.add('has-photo')" onerror="this.remove()" />
          <span class="online-indicator"></span>
        </div>
        <div class="chat-info">
          <div class="chat-row-top">
            <span class="chat-name">${emoName(cleanName || room.name || 'Private Room')}</span>
            <span class="chat-time">${timeStr || 'Active'}</span>
          </div>
          <div class="chat-row-bottom">
            <span class="chat-preview-text">${escapeHtml(room.description || 'Tap to enter chat room')}</span>
            <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
              <button type="button" class="btn btn-icon btn-ghost btn-item-call-audio" title="Audio Call" style="width:32px;height:32px;color:#38bdf8;">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
              </button>
              <button type="button" class="btn btn-icon btn-ghost btn-item-call-video" title="Video Call" style="width:32px;height:32px;color:#a855f7;">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
              </button>
              ${room.spreadsheetId ? `
              <a href="https://docs.google.com/spreadsheets/d/${room.spreadsheetId}/edit" target="_blank" rel="noopener noreferrer" class="btn btn-icon btn-ghost btn-item-sheet" title="Open Google Sheet (Drive: SHEPU ROOMS)" style="width:32px;height:32px;color:#10b981;display:inline-flex;align-items:center;justify-content:center;text-decoration:none;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="16" y2="17"></line></svg>
              </a>` : ''}
              <button type="button" class="btn btn-icon btn-ghost btn-item-qr" title="Share QR" style="width:32px;height:32px;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>
              </button>
            </div>
          </div>
        </div>
      `;

            item.onclick = (e) => {
              if (e.target.closest('.btn-item-qr') || e.target.closest('.btn-item-sheet') || e.target.closest('.btn-item-call-audio') || e.target.closest('.btn-item-call-video')) return;
              window.location.href = `room.html?r=${room.id}`;
            };

            const callAudioBtn = item.querySelector('.btn-item-call-audio');
            if (callAudioBtn) {
              callAudioBtn.onclick = (e) => {
                e.stopPropagation();
                window.location.href = `room.html?r=${room.id}&autocall=audio`;
              };
            }

            const callVideoBtn = item.querySelector('.btn-item-call-video');
            if (callVideoBtn) {
              callVideoBtn.onclick = (e) => {
                e.stopPropagation();
                window.location.href = `room.html?r=${room.id}&autocall=video`;
              };
            }

            const qrBtn = item.querySelector('.btn-item-qr');
            if (qrBtn) {
              qrBtn.onclick = (e) => {
                e.stopPropagation();
                openShareModal(room);
              };
            }

            chatListContainer.appendChild(item);
          });
        }

        // Search filter
        searchInput.oninput = () => {
          const query = searchInput.value.trim().toLowerCase();
          clearBtn.style.display = query ? 'block' : 'none';
          applyFilterAndRender();
        };

        // Phones get a short placeholder — the long one wraps the field.
        const phoneQuery = window.matchMedia('(max-width: 859px)');
        const syncPlaceholder = () => {
          searchInput.placeholder = phoneQuery.matches
            ? 'Search or paste invite link'
            : 'Search chats or paste code / link...';
        };
        syncPlaceholder();
        if (typeof phoneQuery.addEventListener === 'function') {
          phoneQuery.addEventListener('change', syncPlaceholder);
        }

        // Pasting an invite link (or a room code) straight into the search
        // field joins that room — people copy links from other chat apps.
        const looksLikeJoinTarget = (v) => {
          const s = (v || '').trim();
          if (!s) return false;
          if (/(?:join|room)\.html\?/i.test(s)) return true;          // our invite links
          return /^[A-Za-z0-9]{6,16}$/.test(s) && /\d/.test(s);         // 12-char room code
        };
        searchInput.addEventListener('paste', (e) => {
          const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
          if (!looksLikeJoinTarget(text)) return;   // ordinary search paste
          e.preventDefault();
          searchInput.value = '';
          clearBtn.style.display = 'none';
          handleJoin(text.trim());
        });

        clearBtn.onclick = () => {
          searchInput.value = '';
          clearBtn.style.display = 'none';
          applyFilterAndRender();
        };

        // Action Sheet Tab Switcher (Create vs Join, Create default)
        const setActionSheetTab = (tab) => {
          const tabCreate = document.getElementById('modal-tab-create');
          const tabJoin = document.getElementById('modal-tab-join');
          const panelCreate = document.getElementById('sheet-panel-create');
          const panelJoin = document.getElementById('sheet-panel-join');
          if (tab === 'join') {
            if (tabJoin) {
              tabJoin.style.background = 'var(--accent)';
              tabJoin.style.color = '#fff';
              tabJoin.classList.add('active');
            }
            if (tabCreate) {
              tabCreate.style.background = 'transparent';
              tabCreate.style.color = 'var(--text-2)';
              tabCreate.classList.remove('active');
            }
            if (panelCreate) panelCreate.style.display = 'none';
            if (panelJoin) panelJoin.style.display = 'block';
            setTimeout(() => { try { joinCodeInput?.focus(); } catch {} }, 120);
          } else {
            if (tabCreate) {
              tabCreate.style.background = 'var(--accent)';
              tabCreate.style.color = '#fff';
              tabCreate.classList.add('active');
            }
            if (tabJoin) {
              tabJoin.style.background = 'transparent';
              tabJoin.style.color = 'var(--text-2)';
              tabJoin.classList.remove('active');
            }
            if (panelJoin) panelJoin.style.display = 'none';
            if (panelCreate) panelCreate.style.display = 'block';
            setTimeout(() => { try { roomNameInput?.focus(); } catch {} }, 120);
          }
        };

        const modalTabCreate = document.getElementById('modal-tab-create');
        if (modalTabCreate) modalTabCreate.onclick = () => setActionSheetTab('create');
        const modalTabJoin = document.getElementById('modal-tab-join');
        if (modalTabJoin) modalTabJoin.onclick = () => setActionSheetTab('join');

        // Open Sheet (Create active by default)
        const openActionSheet = (defaultTab = 'create') => {
          setActionSheetTab(defaultTab);
          createSheet.classList.add('active');
        };

        const openCreateSheet = () => openActionSheet('create');

        const navTabAction = document.getElementById('nav-tab-action');
        if (navTabAction) navTabAction.onclick = () => openActionSheet('create');
        if (fabCreate) fabCreate.onclick = () => openActionSheet('create');
        if (emptyCreate) emptyCreate.onclick = () => openActionSheet('create');


        function updateDesktopHubMeta() {
          try {
            const userNameEl = document.getElementById('desktop-user-name');
            if (userNameEl) {
              const name = (typeof Storage !== 'undefined' && Storage.getAuth()?.user?.name) || localStorage.getItem('shepu_display_name') || 'Guest';
              userNameEl.textContent = name;
            }
            const roomsCountEl = document.getElementById('desktop-rooms-count');
            if (roomsCountEl) {
              const count = (allRooms || []).length;
              roomsCountEl.textContent = `${count} Active Room${count === 1 ? '' : 's'}`;
            }
          } catch {}
        }
        if (navTabFriends) {
          navTabFriends.onclick = () => {
            if (window.FriendUI && typeof window.FriendUI.open === 'function') {
              window.FriendUI.open();
            } else {
              const btn = document.getElementById('friends-open-btn');
              if (btn) btn.click();
            }
          };
        }

        if (closeCreate) closeCreate.onclick = () => createSheet.classList.remove('active');
        createSheet.onclick = (e) => { if (e.target === createSheet) createSheet.classList.remove('active'); };

        // Room Creation Helper — async, uses Google Sheet if configured
        const handleCreate = async (rawName, inputEl, sheetToClose, pwEl) => {
          if (!rawName) return;
          // Optional password up front (empty = open room). Validated BEFORE
          // anything is created so a typo can't leave a half-locked room.
          const pwValue = ((pwEl && pwEl.value) || '');
          if (pwValue && pwValue.length < 4) {
            UI.toast('error', 'Weak Password', 'Use at least 4 characters — or leave it empty for an open room.');
            try { pwEl.focus(); } catch {}
            return;
          }

          // One rule: logged-in → Gmail name; logged-out → one-time name prompt.
          // Saved rooms trigger Google sign-in on demand below.
          const ownerName = await UI.resolveDisplayName();
          if (!ownerName) return; // user cancelled the name prompt
          const name = rawName;

          // Close sheet & disable inputs
          if (sheetToClose) sheetToClose.classList.remove('active');
          if (inputEl) inputEl.value = '';
          if (pwEl) pwEl.value = '';

          // Show progress overlay
          const overlay = document.getElementById('room-creating-overlay');
          const progressText = document.getElementById('room-creating-text');
          if (overlay) overlay.classList.remove('hidden');
          const updateProgress = (msg) => {
            if (progressText) {
              progressText.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> ${escapeHtml(msg)}</span>`;
            }
          };

          let newRoom;
          try {
            if (roomMode === 'instant') {
              // Quick (P2P) mode — no Google sign-in required
              updateProgress('Creating room (instant peer-to-peer mode)…');
              newRoom = Rooms.createInstantRoom(name, 'Private Room', ownerName);
              UI.toast('success', 'Room Created!', `"${name}" is live. Share the link to invite people!`);
            } else {
              // Saved mode — Google Sheet backend, requires sign-in
              if (!CONFIG.isGoogleConfigured() || typeof Drive === 'undefined') {
                throw new Error('Saved mode needs a Google Client ID configured. Switch to Quick mode.');
              }
              if (!Auth.isAuthenticated()) {
                updateProgress('Waiting for Google sign-in…');
                try {
                  await Auth.signIn();
                } catch (e) {
                  throw new Error('Google sign-in is required for Saved rooms. Please try again or switch to Quick.');
                }
              }
              if (!Auth.isAuthenticated()) {
                throw new Error('Google sign-in is required for Saved rooms.');
              }
              newRoom = await Rooms.createRoomWithSheet(name, 'Private Room', ownerName, updateProgress, { strict: true });
              UI.toast('success', 'Room + Google Sheet Created!', `Your chat is backed by Google Sheets.`);
            }
          } catch (err) {
            console.error('Room creation error:', err);
            if (roomMode === 'secure') {
              // Never silently downgrade a Saved room to Quick
              UI.toast('error', 'Saved room failed', err.message || 'Please try again.');
              if (overlay) overlay.classList.add('hidden');
              return;
            }
            // Emergency fallback (Quick mode only)
            newRoom = Rooms.createInstantRoom(name, 'Private Room', ownerName);
            UI.toast('warning', 'Room Created (Quick)', 'Created quick room.');
          } finally {
            if (overlay) overlay.classList.add('hidden');
          }

          loadRooms();
          // Optional password: lock with end-to-end encryption from the very
          // first message. Secret is brand-new (nothing leaked yet), so no
          // rotation is needed — key + registry flag + server verifier.
          if (newRoom && pwValue) {
            if (overlay) overlay.classList.remove('hidden');
            updateProgress('Locking with password…');
            try {
              if (typeof RoomPassword === 'undefined') throw new Error('Password module missing — reload and retry.');
              await RoomPassword.deriveAndStore(newRoom.id, pwValue);
              const hash = await RoomPassword.hashForServer(newRoom.id, pwValue);
              const sess = (typeof Storage !== 'undefined' && Storage.getSession) ? Storage.getSession() : null;
              const res = await RoomAPI.roomOp(newRoom.deploymentUrl, {
                memberId: sess && sess.memberId, sessionToken: sess && sess.sessionToken,
                op: 'set_password', passwordHash: hash,
              });
              if (!res || !res.success) throw new Error((res && res.error) || 'Server refused.');
              try { Rooms.updateRoom(newRoom.id, { passwordLocked: true }); } catch {}
              newRoom.passwordLocked = true;
              UI.toast('success', 'Room Locked', 'End-to-end encrypted from the first message.');
            } catch (err) {
              try { RoomPassword.clearStored(newRoom.id); } catch {}
              try { if (typeof Encryption !== 'undefined') Encryption.clearKey(); } catch {}
              UI.toast('warning', 'Lock Failed', (err && err.message) || 'Room created WITHOUT password.');
            } finally {
              if (overlay) overlay.classList.add('hidden');
            }
          }
          // Play room-created animation (~2.5s) before opening the share modal
          if (window.UI?.playRoomCreatedAnimation) await UI.playRoomCreatedAnimation();
          openShareModal(newRoom);
        };

        // Optional password toggle (collapsed, OFF by default). Turning it
        // OFF clears the box so a stale password can never lock by accident.
        const bindPwToggle = (btnId, boxId, inputId) => {
          const btn = document.getElementById(btnId), box = document.getElementById(boxId), inp = document.getElementById(inputId);
          if (!btn || !box) return;
          btn.addEventListener('click', () => {
            const open = box.classList.contains('hidden');
            box.classList.toggle('hidden', !open);
            btn.setAttribute('aria-expanded', String(open));
            if (open && inp) setTimeout(() => inp.focus(), 60);
            if (!open && inp) inp.value = '';
          });
        };
        bindPwToggle('sheet-pw-toggle', 'sheet-pw-box', 'sheet-room-password');
        bindPwToggle('desktop-pw-toggle', 'desktop-pw-box', 'desktop-room-password');
        // Password input counts ONLY while its toggle box is open.
        const pwEnabledInput = (boxId, inputId) => {
          const box = document.getElementById(boxId), inp = document.getElementById(inputId);
          return (box && inp && !box.classList.contains('hidden')) ? inp : null;
        };

        // Mobile create submit
        createForm.onsubmit = (e) => {
          e.preventDefault();
          handleCreate(roomNameInput.value.trim(), roomNameInput, createSheet, pwEnabledInput('sheet-pw-box', 'sheet-room-password'));
        };

        // Desktop create submit
        if (desktopCreateForm) {
          desktopCreateForm.onsubmit = (e) => {
            e.preventDefault();
            handleCreate(desktopRoomName.value.trim(), desktopRoomName, null, pwEnabledInput('desktop-pw-box', 'desktop-room-password'));
          };
        }

        // Join Sheet (switches to Join tab)
        const openJoinSheet = () => {
          openActionSheet('join');
        };
        if (topJoin) topJoin.onclick = openJoinSheet;

        const handleJoin = (val) => {
          if (!val) return;
          // Full links (invite OR room URLs) go through untouched so ?k= / #k=
          // / ?th= / ?ep= survive. room.html links are rewritten to join.html
          // with params intact — never alnum-stripped (that created GHOST
          // rooms: page opens, nobody there, zero errors).
          if (val.includes('join.html?') || /room\.html\?/.test(val)) {
            try {
              const u = new URL(val, window.location.href);
              if (/room\.html$/.test(u.pathname)) {
                u.pathname = u.pathname.replace(/room\.html$/, 'join.html');
              }
              window.location.href = u.toString();
            } catch {
              window.location.href = val;
            }
            return;
          }
          const cleanId = val.replace(/[^a-zA-Z0-9]/g, '');
          if (cleanId.length >= 6) {
            window.location.href = `join.html?r=${cleanId}`;
          } else {
            UI.toast('error', 'Invalid code', 'Please enter a valid room code or link.');
          }
        };

        joinForm.onsubmit = (e) => {
          e.preventDefault();
          handleJoin(joinCodeInput.value.trim());
        };

        // One-tap paste inside the join sheet (phones: no keyboard hunting).
        const joinPasteBtn = document.getElementById('btn-join-paste');
        if (joinPasteBtn) {
          joinPasteBtn.onclick = async () => {
            let text = '';
            try {
              if (!navigator.clipboard || !navigator.clipboard.readText) throw new Error('no clipboard');
              text = (await navigator.clipboard.readText() || '').trim();
            } catch (err) {
              UI.toast('info', 'Paste it here', 'Long-press the field and choose Paste.');
              try { joinCodeInput.focus(); } catch (e) { /* non-fatal */ }
              return;
            }
            if (!text) {
              UI.toast('info', 'Clipboard is empty', 'Copy the invite link first.');
              return;
            }
            joinCodeInput.value = text;
            if (looksLikeJoinTarget(text)) {
              handleJoin(text);
            } else {
              UI.toast('info', 'Link copied in', 'Tap Join Room to continue.');
            }
          };
        }

        if (desktopJoinForm) {
          desktopJoinForm.onsubmit = (e) => {
            e.preventDefault();
            handleJoin(desktopJoinCode.value.trim());
          };
        }

        // Share Modal (QR + 3 tabs)
        let activeShareRoom = null;
        let activeShareUrl = '';

        // ── App URL for the cross-device strip (never hardcoded) ──
        function getAppUrl() {
          let basePath = '';
          try {
            const p = window.location.pathname || '';
            if (p && !p.startsWith('/mnt') && !p.startsWith('/run') && !p.startsWith('/tmp')) {
              basePath = p.split('/').slice(0, -1).join('/') || '';
            }
          } catch {}
          const origin = (window.location.origin && window.location.origin !== 'null' && !window.location.origin.startsWith('file'))
            ? window.location.origin
            : 'https://shepu1.github.io';
          return origin + basePath + '/index.html';
        }
        const connDisplay = document.getElementById('connectivity-url-display');
        if (connDisplay) connDisplay.textContent = getAppUrl();

        // Single universal invite link (no device tabs — one link for all)
        function openShareModal(room) {
          activeShareRoom = room;
          const modal = document.getElementById('share-modal');
          const modalTitle = document.getElementById('share-modal-title');
          const qrImg = document.getElementById('share-qr-img');
          const urlDisplay = document.getElementById('modal-share-url');
          const linkHint = document.getElementById('modal-link-hint');
          const chatBtn = document.getElementById('share-modal-chat');
          if (chatBtn) chatBtn.style.display = '';

          const urls = Rooms.getShareUrls(room.id, room.deploymentUrl, room.name);
          activeShareUrl = urls.defaultUrl;

          modalTitle.innerHTML = emoName(room.name);
          urlDisplay.textContent = activeShareUrl;
          try {
            if (typeof InstantSecurity !== 'undefined') {
              InstantSecurity.renderQR({ qrImg, qrBox: document.getElementById('share-qr-box'), text: urls.qrText || activeShareUrl });
            } else qrImg.src = urls.qrCodeUrl;
          } catch { qrImg.src = urls.qrCodeUrl; }

          UI.openModal('share-modal');
        }

        if (desktopShowQr) {
          desktopShowQr.onclick = () => {
            // QR encodes the APP url (what the strip promises) — never
            // invents a junk room just to show a code.
            const appUrl = getAppUrl();
            activeShareRoom = null;
            activeShareUrl = appUrl;
            const modalTitle = document.getElementById('share-modal-title');
            const qrImg = document.getElementById('share-qr-img');
            const urlDisplay = document.getElementById('modal-share-url');
            const chatBtn = document.getElementById('share-modal-chat');
            if (modalTitle) modalTitle.textContent = 'Open on your phone';
            if (urlDisplay) urlDisplay.textContent = appUrl;
            try {
              if (typeof InstantSecurity !== 'undefined') {
                InstantSecurity.renderQR({ qrImg, qrBox: document.getElementById('share-qr-box'), text: appUrl });
              } else if (qrImg) {
                qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&margin=8&data=${encodeURIComponent(appUrl)}`;
              }
            } catch {}
            if (chatBtn) chatBtn.style.display = 'none';
            UI.openModal('share-modal');
          };
        }

        // Copy button
        document.getElementById('btn-modal-copy').onclick = async () => {
          if (!activeShareUrl) return;
          await UI.copyText(activeShareUrl);
          UI.toast('success', 'Copied!', 'Room link copied to clipboard.');
        };

        // Close share modal
        document.getElementById('share-modal-close').onclick = () => UI.closeModal('share-modal');
        document.getElementById('share-modal-done').onclick = () => UI.closeModal('share-modal');

        // Enter Chat Button
        document.getElementById('share-modal-chat').onclick = () => {
          if (activeShareRoom) {
            window.location.href = `room.html?r=${activeShareRoom.id}`;
          }
        };

        // Quick Name Presets (ProjectMind usability)
        document.querySelectorAll('.quick-preset-chip').forEach(chip => {
          chip.addEventListener('click', () => {
            const targetInput = document.getElementById(chip.dataset.target || 'desktop-room-name');
            if (targetInput) {
              targetInput.value = chip.dataset.name || chip.textContent.trim();
              targetInput.focus();
            }
          });
        });

        // Quick Paste for Join Code
        const pasteBtn = document.getElementById('btn-desktop-paste-code');
        if (pasteBtn && desktopJoinCode) {
          pasteBtn.addEventListener('click', async () => {
            try {
              if (navigator.clipboard && navigator.clipboard.readText) {
                const text = await navigator.clipboard.readText();
                if (text) {
                  desktopJoinCode.value = text.trim();
                  desktopJoinCode.focus();
                  UI.toast('info', 'Pasted', 'Pasted invite code / link from clipboard.');
                  return;
                }
              }
            } catch {}
            desktopJoinCode.focus();
          });
        }

        // Copy Connectivity URL Button
        const copyConnBtn = document.getElementById('btn-copy-conn-url');
        if (copyConnBtn) {
          copyConnBtn.addEventListener('click', async () => {
            const url = getAppUrl();
            if (url) {
              await UI.copyText(url);
              UI.toast('success', 'Copied!', 'App URL copied to clipboard.');
            }
          });
        }

        // Global '/' keyboard shortcut to focus search input (Vercel style)
        document.addEventListener('keydown', (e) => {
          if (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
            e.preventDefault();
            if (searchInput) searchInput.focus();
          }
        });

        // Troubleshooting toggle
        const tBtn = document.getElementById('btn-toggle-troubleshoot');
        const tContent = document.getElementById('troubleshoot-content');
        const tChevron = document.getElementById('troubleshoot-chevron');
        if (tBtn && tContent) {
          tBtn.onclick = () => {
            const isHidden = tContent.style.display === 'none';
            tContent.style.display = isHidden ? 'block' : 'none';
            tChevron.textContent = isHidden ? '▴' : '▾';
          };
        }

        function formatRelativeTime(ts) {
          if (!ts) return '';
          const diff = Date.now() - new Date(ts).getTime();
          if (diff < 60000) return 'Just now';
          if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
          if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
          return Math.floor(diff / 86400000) + 'd ago';
        }

        // Initial load
        loadRooms();
        // Re-render once custom emoji arrive so room names show images
        if (window.CustomEmoji) {
          CustomEmoji.load().then(() => applyFilterAndRender()).catch(() => {});
        }
      });
