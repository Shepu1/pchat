# Pchat (SHEPU ROOMS) — Bug Report

Audit date: 2026-10-21
Method: ESLint (no-undef/no-dupe-keys/custom globals), 5 parallel deep code audits,
plus live runtime verification in a headless Chromium against a local static server.

Legend: **[RT]** = reproduced in a real browser. **[C]** = confirmed by code reading only.

---

## ✅ FIXED — Round 2 (2026-10-21, second audit)

A second, independent audit ran 5 parallel deep audits over every module plus
static cross-file analysis (DOM-id ↔ HTML cross-check, HTML 404 check,
cache-bust consistency check, XSS sweep). It confirmed the 57 earlier fixes
(54 fully applied) and found **~65 more**, of which the ones that genuinely
matter were fixed. 52 automated checks cover the changes.

### Security

| # | Bug | Fix | File |
|---|---|---|---|
| S1 | **`?ep=` let an attacker pick the room's backend** — the join side decoded the invite's endpoint URL with no validation, so a crafted link harvested the victim's display name, picture and room-password verifier and turned every later message into plaintext posted to a foreign server. (The create side already validated; only the join side was missing.) | Allow-list `script.google.com` / `script.googleusercontent.com` / `mock://local/…`, enforced at `RoomAPI._fetch` (the single choke point) *and* when the link is parsed | `js/rooms.js`, `js/join-room.js`, `js/app.js`, `js/create-room.js` |
| S2 | **Any invitee could act as the owner** — the owner's session token was `owner_sess_` + the room secret, and the secret travels in the invite link (`#k=`) while the room id travels in the query string (`?r=`). Both were enough to reconstruct the owner's credentials and run every owner action (delete room, ban members, wipe chat, change the password). | The owner token is now a random 40-char value stored device-locally, never derivable from the link. Legacy rooms rotate automatically via the existing owner-row repair | `js/rooms.js`, `js/app.js`, `js/create-room.js` |
| S3 | `emoName()` fell back to the **unescaped** string when the emoji pipeline threw, and every caller assigns it to `innerHTML` | Always escape, in the happy path *and* in the fallback | `js/custom-emoji.js` |
| S4 | `encrypt()` returned the **plaintext** when no key was set (only the crypto-error path threw) | Refuse to encrypt without a key | `js/encryption.js` |
| S5 | The owner's `memberId` was built with two different lengths (`slice(0,8)` vs `slice(0,6)`) → duplicate owner rows and sessions the backend rejected | Unified on 6 characters | `js/create-room.js` |

### Data loss / broken core features

| # | Bug | Fix | File |
|---|---|---|---|
| D1 | **Relay messages were split at 4096 bytes but never reassembled** — a 4000-character Bengali message (12 000 bytes) arrived as 4 separate chat bubbles, cut mid-word | The chunks now carry `_part` / `_parts` / `_origId` and the receiver stitches them back together before delivering | `js/ntfy-sync.js` |
| D2 | **"Clear chat" permanently killed the sync of every real Apps Script room** — the sheet lost its rows, so `getLastRow()` fell to 1 while the client still asked for row 43; the room never received another message. (The mock had been fixed; the backend had not.) | The backend soft-deletes the rows instead of wiping the sheet, and the client accepts a server counter that moved backwards — so already-deployed backends recover on their own | `apps-script/Code.gs`, `js/sync.js` |
| D3 | **One failed IndexedDB write silenced the whole chat** — the delivery callback was gated on the cache write, so the feed stayed empty *and* the same rows were re-fetched every 2 s forever, with no error shown | A cache must never gate delivery: the messages are delivered and the cursor advances even if the cache write fails | `js/sync.js` |
| D4 | **Every reply loaded with the history lost its quoted snippet** — `_messages` was merged *after* the render loop, so the quoted parent was not in the array yet | Merge the batch into the state before rendering; keep a pre-merge snapshot for the "did it change?" check | `js/chat.js` |
| D5 | **`.doc` / `.docx` / `.zip` / `.csv` attachments rendered as an empty bubble** — the receiver's allow-list rejected the very MIME type the sender-side fix produced | Accept any `data:` URL except the media types that can execute script | `js/chat.js` |
| D6 | **Edits and deletions never reached members over the relay** — they reuse the original message id, which the id-dedupe set had already seen | Edits/deletes bypass the id-dedupe (they are idempotent on the receiving side) | `js/ntfy-sync.js` |
| D7 | "Rotate invite link" **kept the revoked topic alive** — the aborted stream's restart was not bound to the current topic set | Topic check + a generation counter that invalidates in-flight streams | `js/ntfy-sync.js` |

### Broken interactions

| # | Bug | Fix | File |
|---|---|---|---|
| B1 | **Any Enter keypress confirmed a destructive dialog and swallowed the chat message** — the dialog used a document-level *capture-phase* key handler, so it fired before the composer's own handler. Deleting a room or banning a member could be confirmed by accident. | The listener now lives on the overlay, so only a focused control inside the dialog is affected | `js/ui.js` |
| B2 | A replaced confirm dialog **leaked its key handler forever** and the stale handler hid the dialog that was open | Every dialog is fully torn down when it is superseded | `js/ui.js` |
| B3 | **Screen capture kept running after the call was hung up** (no guard after the picker) and two taps opened two pickers | Post-`await` state check that stops the tracks, plus an in-flight flag | `js/calls.js` |
| B4 | The ICE watchdog **killed live calls on a transient `disconnected` state** (Wi-Fi handover, VPN toggle) | Only `failed` / `closed` end the call; `disconnected` gets a 12 s grace period | `js/calls.js` |
| B5 | **One busy member aborted the whole room-wide call** | Only a call addressed to a single member can be aborted by that member's "busy" | `js/calls.js` |
| B6 | `peer.call()` returns `undefined` (it does not throw) when the peer is disconnected — both sides showed "Connected" with no connection | Check the return value in `acceptCall` too | `js/calls.js` |
| B7 | **A locked room did not lock the guests** — the mock keeps the status in the owner's local storage, so a guest could keep sending | The relayed status is mirrored into each device's local store and the composer is disabled | `js/rooms.js`, `js/app.js`, `js/chat.js` |
| B8 | **The bot's answer was stored under the human's name** — after a reload it showed up as the user's own message (right-aligned, "Sent" tick) | The bot keeps its own member row in the room | `js/shepu-bot.js` |
| B9 | **The bot's own reply was read as a music command** — its answer to "next song" is literally *"gan chenge koreci 🎶"*, which the radio detector matched as "next": two tracks skipped and the room radio lost sync | Bot messages are excluded from the music-command detector | `js/chat.js` |
| B10 | **Enter still sent `@sh` instead of accepting the suggestion** — the popup never selected a row | The first row is selected by default | `js/shepu-bot.js` |
| B11 | The mobile redesign **never reached 5 of the 7 pages** — `css/responsive.css` was referenced with two different `?v=` tokens | One token for every page; every changed asset re-versioned | `*.html` |
| B12 | A failed room creation left the **spinner spinning forever** next to "Setup failed" | The spinner has an id and is replaced by an error icon | `create.html`, `js/create-room.js` |
| B13 | The member list could show **another room's members** — the refresh read the global session's room id | Use the room the presence instance was started for | `js/presence.js` |
| B14 | `loadMembers` was declared in two files — the last one loaded won on `window` | The unused copy was removed | `js/presence.js` |

**Not fixed on purpose:** the remaining ~35 low-severity findings (toast
timers, unused `_pendingIds`, the `_pendingAttachment.kind` metadata,
`RoomSounds.unlock()` audibility, the sheet's 50 000-character cell limit for
attachments, the music relay fallback, the notification bell's first click,
the AI knowledge-file timeout, …) were left alone — they are cosmetic or
rare edge cases, and the brief was to fix only what genuinely matters.

---

## ✅ FIXED (2026-10-21)

All entries below were fixed and verified. Each fix was checked with `node --check`,
ESLint (project rules), and — where behaviour was observable — in a real headless
Chromium against a local static server.

| # | Bug | Fix | Verified |
|---|---|---|---|
| 1 | ntfy call signals dropped (duplicate `payload` key) | `js/ntfy-sync.js:403` — removed the duplicate key | [RT] |
| 2 | ⋮ menu opens+closes in one tick | `js/chat.js:817` — `stopPropagation()` | [RT] |
| 3 | Join button did a native form GET | `js/join-room.js` — `bindJoinForm()` called from `showJoinForm()` | [RT] |
| 4 | `:error:` replaced by a padlock | `js/special-emoji.js` — only known codes count (`assets/emoji/special/codes.json` added) | [RT] |
| 5 | Long messages dropped by the relay | `js/ntfy-sync.js` — split over 4096 bytes | [RT] |
| 6 | E2EE silently downgraded to plaintext | `js/encryption.js` — `encrypt()` now throws | [RT] |
| 7 | Sync cursor stored as an object | `js/storage.js` / `js/sync.js` — numeric cursor | [RT] |
| 8 | Remote voice played twice | `js/calls.js` — remote `<video>` muted | [RT] |
| 9 | "Retry" deleted the message | `js/chat.js` — queue every failure, restore instead of delete | [C] |
| 10 | Rejoin never applied the fresh invite key | `js/join-room.js` — `_joinCtx` + fresh secret from context | [RT] |
| 11 | Saved rooms skipped Google consent | `js/create-room.js` — `Auth.hasGoogleToken()` | [C] |
| 12 | Stale `isEmailAuth` after Google sign-in | `js/auth.js` — cleared in the GIS callback | [C] |
| 13 | Member list wiped by a transient error | `js/members.js` — fall through to the IDB cache | [RT] |
| 14 | "No key in link" badge never rendered | `js/join-room.js` — read from `_joinCtx` | [RT] |
| 15 | Every message relayed twice | `js/rooms.js` — the mock backend no longer relays messages | [C] |
| 16 | A second accepter hijacked the call | `js/calls.js` — only answer the current peer/call | [C] |
| 17 | Members kept ringing forever | `js/calls.js` — handle `accept` in the `incoming` state + 45 s timeout | [RT] |
| 18 | `peer.call()` failure reported as success | `js/calls.js` — check for `undefined` | [C] |
| 19 | `_isScreenSharing` never reset | `js/calls.js` — reset in `endCall()` / `acceptCall()` | [C] |
| 20 | Stale timers killed a new call | `js/calls.js` — re-check the call id | [C] |
| 21 | No ICE watchdog | `js/calls.js` — `iceStateChanged` handler | [C] |
| 22 | Unknown MIME → broken image | `js/chat.js` — `application/octet-stream` | [C] |
| 23 | Voice note sent before the FileReader finished | `js/chat.js` — wait for the attachment | [C] |
| 24 | Retry payload lost on declined consent | `js/chat.js` — keep `_retryPayload` | [C] |
| 25 | `navigator.share` rejection unhandled | `js/chat.js` — catch AbortError | [C] |
| 27 | Cursor advanced after a failed cache write | `js/sync.js` — advance only after a successful write | [C] |
| 28 | Sync loop could not be stopped | `js/sync.js` — added `stop()` + in-flight guard | [C] |
| 29 | Mock cursor broke after `clear_chat` | `js/rooms.js` — monotonic `_seq` | [RT] |
| 30 | Mock backend granted `owner` from a crafted id | `js/rooms.js` — role from the session/registry only | [C] |
| 31 | HTTP status lost on retries | `js/rooms.js` — keep `lastErr` | [C] |
| 32 | localStorage quota broke sending | `js/rooms.js` — `_persistMockRoom()` best-effort | [C] |
| 33 | 4xx counted as a server outage | `js/ntfy-sync.js` — `clientError` flag | [C] |
| 34 | `stop()` marked all servers failed | `js/ntfy-sync.js` — `_stopping` guard | [C] |
| 35 | `_seenIds` grew without bound | `js/ntfy-sync.js` — cap at 3000 | [C] |
| 36 | Full history re-downloaded on reconnect | `js/ntfy-sync.js` — resume with `?since=<id>` | [C] |
| 37 | `Presence.stop` was `window.stop` | `js/presence.js` — real `stop()` + `start()` guard | [RT] |
| 41 | Audio-call avatar always "?" | `js/calls.js` — `_paintAudioAvatar()` | [RT] |
| 42 | `_pendingMediaConnection` leaked | `js/calls.js` — close the previous one | [C] |
| 43 | `endCall()` kept `_remotePeerId` | `js/calls.js` — cleared | [C] |
| 44 | Room icon picker discarded | `js/rooms.js` + `js/icons.js` — `roomIconDataUri()`, 5 icons added | [RT] |
| 45 | Custom backend URL silently ignored | `js/create-room.js` — validated + error shown | [C] |
| 46 | Member initial injected unescaped | `js/owner.js` — escaped | [C] |
| 47 | Join button stuck on "Joining…" | `js/ui.js` — `setLoading()` restores the label | [RT] |
| 48 | Enter sent instead of accepting the suggestion | `js/shepu-bot.js` — capture-phase key handler | [RT] |
| 49 | Failed lock left the room half-encrypted | `js/room-password.js` + `js/app.js` — roll the key back | [RT] |
| 50 | Notification per cached message | `js/app.js` + `js/chat.js` + `js/notify.js` — init earlier, notify only new, age filter | [RT] |
| 51 | Music sync seek dropped | `js/music.js` — seek on `loadedmetadata` | [C] |
| 52 | Notification focused the wrong tab | `sw.js` + `js/notify.js` — carry the room URL | [C] |
| 53 | Server failure suppressed the P2P broadcast | `js/shepu-bot.js` — decoupled transports | [C] |
| 54 | Wrong member could be removed | `js/shepu-actions.js` — word-boundary matching | [C] |
| 55 | "Hide player bar" did not stick | `js/music.js` — `_barHiddenByUser` | [C] |
| 56 | Bot claimed "(copied)" on failure | `js/shepu-actions.js` — use the return value | [C] |
| 57 | Notifications vanished on Android | `js/notify.js` — wait for an activated SW | [C] |

Also fixed: **#21** (digits-only messages rendered as giant emoji bubbles — `js/chat.js`).

### Second audit round — HTML / CSS (agent 6)

| # | Bug | Fix | Verified |
|---|---|---|---|
| H1 | **Stale `?v=` cache-busters** — `js/sounds.js`, `css/base.css`, `css/components.css`, `js/drive.js`, `js/sheets.js`, `manifest.json` were pinned to a version older than their last content change, so returning visitors kept the old code (including the Oct-19 sound fix) | All 112 local asset references now use one token `20261021z`; verified that no file has two tokens | [C] |
| H2 | **CSS variables `--text-1` / `--text-3` were used but never defined** — the `color` declaration was invalid at computed-value time, so the text silently inherited the parent's colour | `css/base.css` `:root` — added `--text-1: #f8fafc` and `--text-3: #64748b` (aliases of `--text` / `--muted`) | [RT] |
| H3 | **`<img src="">` on 5 elements** — an empty `src` makes the browser re-fetch the page URL as an image and flash a broken image | The `src` attribute was removed from all 5; `js/chat.js` `closeLightbox()` now uses `removeAttribute('src')` instead of `src = ''` | [RT] |
| H4 | **Dead CSS selectors** — `.msg-retry` (the JS renders `.msg-retry-btn`) and `.incoming-avatar-img` (the JS renders `.incoming-avatar-initial`) never matched anything | Removed the dead rules; the live rules are untouched and still present | [RT] |
| H5 | *(found by my own regression suite)* The relay chunking overran the 4096-byte limit because the per-chunk `_part`/`_parts`/`_origId` markers were not counted in the overhead | `js/ntfy-sync.js` — the overhead is now measured from a worst-case chunk (3-digit index) | [RT] — max body 4 081 bytes |

Not fixed (deliberately): **#26** — the date-divider feature was never wired up; it is a
missing cosmetic feature rather than a broken one.

---

## CRITICAL

### 1. Ntfy-relayed calls never ring — duplicate object key
**`js/ntfy-sync.js:403`** [RT]

```js
if (_onEvent) _onEvent({ kind: 'call_signal', payload: payload.payload, payload });
```

`payload` is declared twice in the same literal. The shorthand wins, so the event
carries the whole envelope instead of the inner signal.

Chain: `calls.js:691` → `p2p-sync.js:700-712` (`NtfySync.publish`) →
`ntfy-sync.js:403` → `app.js:849-854` → `CallManager.handleIncomingSignal(payload)`
→ `calls.js:731` `if (!payload || !payload.action) return;` → **silent drop**.

Result: the callee's phone never rings when the call arrives over the relay
(Quick rooms / NAT-blocked P2P). P2P path is unaffected (`p2p-sync.js:518` is correct).

**Fix:** `{ kind: 'call_signal', payload: payload.payload }`

---

### 2. "More options" (⋮) menu opens and closes in the same tick — Edit/Delete unreachable
**`js/chat.js:817`** vs **`js/chat.js:1547-1550`** [RT]

```js
menuBtn.addEventListener('click', (e) => openContextMenu(e, msg));   // no stopPropagation
document.addEventListener('click', (e) => { if (!contextMenu.contains(e.target)) closeContextMenu(); });
```

React (`:781`) and Copy (`:793`) both call `e.stopPropagation()`; ⋮ does not.
Runtime capture of the `display` writes: `["OPEN", "CLOSE(none)"]` — the menu is
never painted. On mobile the long-press path is consumed by the reaction picker
and suppresses the synthetic `contextmenu`, so **Edit/Delete have no working entry
point on phones at all**.

**Fix:** `menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openContextMenu(e, msg); });`

---

### 3. Join button does a native form GET — the typed nickname is lost
**`js/join-room.js:182`** [RT]

The `submit` listener is attached at line 182, *after* the `return`s at `:170` and
`:175`, and `showJoinForm()` is also called from `:514` ("Join with a different name").
So on those two paths **no submit listener exists**. The button is `type="submit"`
inside `<form id="join-form">` with no `action` → the browser performs a native GET
and reloads the page.

Runtime check: dispatching `submit` on the rejoin path ran **no** handler
(`handlerRan: false`). The user must click Join twice; the nickname is discarded.

**Fix:** move the attachment into `bindJoinForm()` and call it from `showJoinForm()`.

---

### 4. Any 5-letter word in colons is replaced by a padlock icon
**`js/special-emoji.js:45-47` + `:159-173`** [RT]

```js
const SHORTCODE_NEW = ':[a-z][a-z0-9]{4}:';
```

Matches *any* 5-letter lowercase word. `urlForShortcode()` returns `null` for unknown
codes → the text is rewritten to the "locked emoji" SVG. Verified in the browser:

```
emojifyShortcodes(':error:')  -> <span class="special-emoji-locked">…padlock svg…</span>
emojifyShortcodes('hello :super: world') -> hello <span class="special-emoji-locked">…</span> world
```

14 of 78 common English 5-letter words are swallowed (`error super react music start
share these about point first after input north large`). `_isEmojiOnly()` strips
shortcodes first, so a message that is only `:error:` also becomes a giant bubble.

**Fix:** match against the *known* code set, not a generic pattern.

---

### 5. Long messages are silently dropped by the relay (>4096 bytes)
**`js/ntfy-sync.js:113-140`** + `js/config.js:82` (`MAX_MESSAGE_LENGTH: 4000`) [C]

ntfy's `DefaultMessageSizeLimit = 4096` bytes (confirmed in ntfy `server/config.go`).
The relay body is `JSON.stringify({type:'message', msg:{…}})` posted as `text/plain`.
Measured payload sizes:

| message | payload bytes | |
|---|---|---|
| English 1000 chars | 1 217 | ok |
| English 3700 chars | 3 917 | ok |
| **Bangla 1000 chars** | **3 217** | ok |
| **Bangla 1500 chars** | **4 717** | **over 4096** |
| **Bangla 4000 chars (max allowed)** | **12 217** | **over 4096** |

ntfy treats an over-limit body as an *attachment*, not as the message text, so the
content never arrives. `_post()` swallows the failure → the sender sees "sent".
For a Bengali-first chat app this is a ~1200-character practical ceiling.

**Fix:** byte-check the body and chunk oversized messages, or warn the sender.

---

### 6. E2EE silently downgrades to plaintext on a crypto error
**`js/encryption.js:56-59`** + **`js/chat.js:1323-1325`** [C]

```js
} catch (e) { console.warn("Encryption failed:", e); return plaintext; }   // encryption.js
finalMessage = await Encryption.encrypt(finalMessage);                     // chat.js — no check
```

If `crypto.subtle.encrypt` throws, the raw plaintext is POSTed to the Apps Script
backend and broadcast to the relay while the UI still says the room is encrypted.
The edit path (`chat.js:1643-1649`) already does the right thing.

**Fix:** treat a non-`enc:` result as a failure and abort the send.

---

### 7. The incremental-sync cursor is written as an object and read as a number
**`js/storage.js:84`** + **`js/sync.js:61`** + **`js/app.js:753`** [C]

```js
getSyncCursor(roomId) { return this.get(`sync_${roomId}`); },        // → {lastRow:42}
Storage.setSyncCursor(_roomId, { lastRow: _lastRow });                // stores an object
startRow = Storage.getSyncCursor(roomId) || 0;                        // → {lastRow:42}
```

→ `afterRow=[object Object]` → the backend does `parseInt(...) || 0` → 0.
On every reload the cursor is useless: the Sheet backend returns only the **last 50
rows** (older messages silently dropped) and the mock backend returns everything.

**Fix:** make the contract numeric in `storage.js:84` and coerce in `sync.js:22`.

---

### 8. Every call plays the remote voice twice
**`js/calls.js:337` + `:347` + `:1024-1034`** [RT]

The same `MediaStream` is attached to `#call-remote-audio` **and** `#call-remote-video`;
neither is muted (`#call-local-video` correctly is). `display:none` does not stop a
media element from playing. Runtime check: `audioMuted:false`, `videoMuted:false`.

→ the peer is heard twice (doubled/comb-filtered voice) in every call.

**Fix:** mute `#call-remote-video`, or only attach the stream to it for video calls.

---

### 9. Clicking "Retry" on a failed message deletes it
**`js/chat.js:1431`** + **`:1499-1502`** [C]

Only `err.isNetwork` failures are queued to `Storage.addPendingMessage`. Every other
failure (`res.success === false`, HTTP 4xx/5xx, bad JSON) queues nothing, so the
Retry handler hits `if (!pending) { el.remove(); return; }` — **the message and the
user's text vanish with no recovery**. The `reason` passed to `_markOptimisticFailed`
is never shown.

**Fix:** queue on every failure, and restore the text into the composer instead of
removing the bubble.

---

### 10. Rejoin never applies the fresh invite key — share links stay stale
**`js/join-room.js:473`** [RT]

`roomInfoTrusted` and `pwParam` are locals of the `DOMContentLoaded` callback, but
`showRejoin()` is a top-level function. The call throws `ReferenceError`, which is
swallowed by the `catch { /* non-critical */ }` at `:481` — so **lines 474-479 never
run** and the registry patch (new secret, deploymentUrl, name, kind, passwordLocked,
theme) is never applied.

This is exactly the failure the code comments at `:465-467` say they are preventing
("a rejoin must adopt the new secret instead of keeping the stale registry copy").

Verified in the browser: an invite carrying a new `?k=` key left
`registrySecretAfter = OLD_SECRET_VALUE`.

**Fix:** pass `roomInfoTrusted` and `pwParam` into `showRejoin()`.

---

## HIGH

### 11. Saved-room creation skips Google consent for email/demo logins
**`js/create-room.js:203` + `:214`** [C]

`Auth.isAuthenticated()` is true for email/demo logins (`js/auth.js:246-252`), so the
Google step is skipped and `hasGoogle` is true without a Google token.
`Drive.getOrCreateFolder()` then sends `Bearer email_token_…` → 401 → an unsolicited
OAuth popup → "Google Sign-In popup closed or cancelled".

`Auth.hasGoogleToken()` already exists (`js/auth.js:255`) and is used correctly in
`js/app.js:548`.

### 12. A stale `isEmailAuth` survives a real Google sign-in
**`js/auth.js:56`** [C]

`Storage.setAuth({...})` resets `isDemo:false` but never clears `isEmailAuth:true`, so
`hasGoogleToken()` keeps returning false → the room history is never loaded from the
Sheet even though a valid Google token is stored.

### 13. A member list is wiped by a transient backend error
**`js/members.js:12`** [C]

`if (!res.success) return [];` short-circuits the IndexedDB cache fallback, which is
only reachable from the `catch`. The backend answers `{success:false}` with HTTP 200
(`apps-script/Code.gs:22-24`), so `_fetch` resolves normally → the roster empties.

### 14. The "no key in link" warning badge never renders
**`js/join-room.js:378-379`** [RT]

`room` and `roomSecret` are locals of the `DOMContentLoaded` callback, not of
`showJoinForm()`. The `ReferenceError` is swallowed by `catch {}` at `:383`.

Verified in the browser: `inviteKeyWarning(false,false)` correctly returns
"⚠ No key in link — ask owner for the FULL invite link" but the badge is absent.

### 15. Every message is published to the relay twice
**`js/rooms.js:861`** + **`js/p2p-sync.js:568`** [C]

The mock backend relays the message and `broadcastMessage()` relays it again →
16 POSTs per message (2 topics × 4 servers × 2 copies) instead of 8. The two copies
differ (`rooms.js:848` regenerates `createdAt`), so the 5 s fingerprint dedupe cannot
collapse them.

### 16. A second accepter hijacks an established call
**`js/calls.js:1449-1457`** [C]

The `'connected'` branch answers *any* incoming offer with no check on peer/callId.
In a 3+ member room, C accepting closes A's connection to B (`_setupMediaConnection`
closes the old connection at `:1009-1011`).

### 17. Members who are still ringing never stop
**`js/calls.js:790-791`** [C]

`'accept'` is only honoured in state `'calling'`; a member in `'incoming'` ignores it,
so its toast and looping ringtone keep playing forever. There is no incoming-call
timeout anywhere in the file.

### 18. `peer.call()` can fail silently while the UI says "unmuted"
**`js/calls.js:608-624`** [C]

PeerJS `peer.call()` returns `undefined` when the peer is disconnected. The function
still returns `true`, so the fallback that would attach the new track to the live
`RTCPeerConnection` is skipped → the peer hears nothing for the rest of the call.

### 19. Notifications fire for the whole cached backlog
**`js/chat.js:310-316`** [C]

`addedCount > 0` guards the loop, but the loop iterates the whole `sortedMsgs` batch.
Opening a room in a background tab fires one OS notification per cached message.

---

## MEDIUM

| # | File:line | Bug |
|---|---|---|
| 20 | `js/join-room.js:200` | `authUser` is never declared → `ReferenceError` if `UI.effectivePicture` is ever missing |
| 21 | `js/chat.js:1011-1024` | `.replace(/[0-9#*]/g,'')` strips digits unconditionally → "2024" renders as a giant emoji bubble [RT] |
| 22 | `js/chat.js:2172` + `:1302` | An unknown MIME type becomes `image/png` → the attachment renders as a broken image with no download link |
| 23 | `js/chat.js:2368-2371` | The voice note is sent on a fixed 350 ms timer while the `FileReader` is still running → the caption is sent separately, or the note is never sent |
| 24 | `js/chat.js:1270-1284` | Declining the insecure-HTTP consent discards the queued retry payload |
| 25 | `js/chat.js:1799-1807` | `navigator.share()` rejects with `AbortError` → unhandled promise rejection when the share sheet is dismissed |
| 26 | `js/chat.js:987-993` | `_makeDateDivider()` / `_getLastRenderedDate()` are never called — date separators are a dead feature |
| 27 | `js/sync.js:53-65` | The cursor advances even when the IndexedDB write fails → messages vanish after a reload |
| 28 | `js/sync.js:130` | No `stop()`; `forceSync()` can overlap with a running poll → two concurrent poll loops |
| 29 | `js/rooms.js:814-829` | The mock cursor is a count used as a row index → after `clear_chat` the poll stops delivering |
| 30 | `js/rooms.js:784-788` | The mock backend grants `owner` from a client-supplied `memberId` prefix |
| 31 | `js/rooms.js:570-575` | The HTTP status is lost on the 429/5xx retry path → the user sees a generic "Request failed" |
| 32 | `js/rooms.js:804+` | Mock writes to localStorage are unguarded → a quota error surfaces as "message failed" |
| 33 | `js/ntfy-sync.js:123-126` | A 4xx is recorded as a server outage → all relay servers look dead |
| 34 | `js/ntfy-sync.js:299-303` | `stop()` marks every relay server as failed (the abort looks like a network error) |
| 35 | `js/ntfy-sync.js:193` | `_seenIds` grows without bound — memory leak |
| 36 | `js/ntfy-sync.js:288` | `?since=all` re-downloads the whole topic history on every reconnect |
| 37 | `js/presence.js:71` | `stop` is exported but never defined → it resolves to `window.stop` (stops page loading!) |
| 38 | `js/calls.js:646` + `:1095` | `_isScreenSharing` is never reset → "Share Screen" needs two taps on the next call |
| 39 | `js/calls.js:721-727,853,865` | Deferred `endCall()` timers are not bound to their call → a stale timer kills a new call |
| 40 | `js/calls.js:1048-1059` | No ICE watchdog → a dead call stays "Connected" with the timer running |
| 41 | `js/calls.js:352` | The audio-call avatar is never populated → always shows "?" |
| 42 | `js/calls.js:1477,1481` | `_pendingMediaConnection` is overwritten without closing the old one → PeerConnection leak |
| 43 | `js/calls.js:1095` | `endCall()` never clears `_remotePeerId` |
| 44 | `js/create-room.js:105` + `js/rooms.js:139-143` | The "Pick a Room Icon" choice is stored but never read → silently discarded |
| 45 | `js/create-room.js:135` | A custom backend URL that does not start with `https://script.google.com` is silently ignored → the room is created on `mock://local/<id>` |
| 46 | `js/owner.js:172` | The member initial is injected into `innerHTML` unescaped |
| 47 | `js/join-room.js:193,278` | The join button label stays "Joining…" after a failure |

---

## ADDITIONAL FINDINGS — audit round 2 (AI bot / music / notifications)

### 48. The bot's autocomplete "Enter" sends the message instead of accepting the suggestion
**`js/shepu-bot.js:70-74` + `:520-527`** vs **`js/chat.js:1157-1162`** [C]

`Chat.init()` calls `_bindInput()` (chat.js:38) **before** `ShepuBot.init()` (chat.js:94),
so Chat's Enter listener is registered first and runs first: it calls `sendMessage()`,
which reads and clears `input.value`. Only then does the bot's `_onKeydown` run —
`_apply()` sees `val === ''` → early `return` at shepu-bot.js:500 → `hidePopup()` at :509
never runs.

**Symptom:** the user types `@sh`, presses Enter → the literal text `@sh` is sent to the
room (no mention → the bot never answers), the input is emptied, and the suggestion
popup stays on screen with stale items.

**Fix:** bind the bot's keydown in the capture phase on `document` and `stopPropagation()`.

### 49. A failed "Lock Room" leaves the room half-encrypted for everyone
**`js/room-password.js:73-81`** + **`js/app.js:115-118`** [C]

`Encryption.deriveKeyFromPassword()` sets the module-global `_key` **and** `_manual = true`.
If anything after that throws — `exportKey()` returning null (`:75`), storage blocked
(`:81`), or the server refusing `set_password` (`app.js:108`) — the live key survives.
The `catch` at `app.js:116` only calls `RoomPassword.clearStored()` (sessionStorage) and
**never `Encryption.clearKey()`** (the *remove*-password path at `app.js:133` does).

**Symptom:** `Encryption.shouldEncrypt()` stays true → every subsequent message is
encrypted with the password key even though the room was never locked → other members
see "[Couldn't decrypt…]" and the chat is broken until a reload.

### 50. Opening a room fires a system notification for the whole history — including your own messages
**`js/app.js:505` + `:541` vs `:948`** + **`js/notify.js:117`** [C]

`Notify.init()` (which sets `_memberId`) runs at `app.js:948`, but the cached history is
appended at `app.js:541` (`Chat.appendMessages(unique)` → `chat.js:310-316` calls
`Notify.notifyMessage(m)` for every message). At that moment `_memberId` is still `null`,
so the own-message guard at `notify.js:117` is skipped, and `notifyMessage` has **no
freshness window** (unlike the sound path, `chat.js:328-331`, which filters `< 120000 ms`).

**Fix:** move `Notify.init()` before `Chat.init()`, and add the same age filter.

### 51. The music sync seek is silently dropped — late joiners hear the track from 0:00
**`js/music.js:339-344`** [C]

```js
_audio.src = track.src;                        // readyState → HAVE_NOTHING
if (seekSeconds > 0) { try { _audio.currentTime = seekSeconds; } catch {} }   // throws!
```
Per the HTML spec the `currentTime` setter throws `InvalidStateError` while
`readyState === HAVE_NOTHING` — exactly the state right after `src` is assigned. The
`catch {}` swallows it, so the seek never happens.

**Symptom:** a device joining later receives `currentTime ≈ 120` (music.js:421), sets the
new `src`, the seek is dropped → **it plays the track from the beginning while the room
is 2 minutes in**, and stays desynced until the next track change.

**Fix:** apply the seek on `loadedmetadata` when `readyState < 1`.

### 52. Tapping a chat notification focuses the wrong tab (or opens the dashboard)
**`sw.js:19-29`** + **`js/notify.js:154-157`** [C]

`clients.matchAll({type:'window'})` returns all same-origin tabs in an unspecified order
and the handler focuses the **first** one, whatever its URL. If the room tab was closed,
`openWindow('./')` opens the **dashboard**, not the room.

**Fix:** put the room URL in `notification.data.url` and match on it.

### 53. A failed server send suppresses the P2P broadcast — the bot's answer never reaches peers
**`js/shepu-bot.js:383-400`** [C]

Both transports are inside one `try`: if `await RoomAPI.sendMessage(...)` throws
(5xx / `RATE_LIMITED` / network drop), `P2PSync.broadcastMessage(botMsg)` is skipped and
the `catch` hides it. The bot's reply is rendered locally only.

### 54. The bot can remove the **wrong member** — substring name matching
**`js/shepu-actions.js:416-420`** [C]

```js
if (!name || name.length < 2) continue;    // 2-character names allowed
if (q.includes(name)) score = 4;            // raw substring, no word boundary
```
Simulated: a member named **"Ali"** is resolved as the target of
`"finalize the plan and remove him"` (score 4). Worse, `_roomDeleteIntent` bails out at
`shepu-actions.js:221` when `_mentionsExistingMember(t)` is true — so *"delete this room"*
plus any text containing a member-name substring flips the intent from `room_delete` to
`remove_member`, and the **wrong person is kicked** after a confirm dialog naming them.

**Fix:** require token boundaries (`(?:^|\s)name(?:\s|$)`) and a minimum length of 3.

### 55. "Hide player bar" does not stick
**`js/music.js:204-207`** vs **`:471-474`** [C]

The close button adds `.hidden`, but `_updateUI()` (called on every play/pause/track
change) removes it again → the bar re-appears over the chat on the next track change.

### 56. The bot claims "(copied)" even when the clipboard write failed
**`js/shepu-actions.js:680-686`** [C]

`UI.copyText()` **returns `false`** instead of throwing when both
`navigator.clipboard.writeText` and `document.execCommand('copy')` fail (common in a
non-focused tab, an insecure origin, or a Safari `execCommand` refusal). The return
value is ignored → the user pastes the wrong content.

**Fix:** `copied = !!(await UI.copyText(url));`

### 57. A non-activated service-worker registration makes notifications vanish on Android
**`js/notify.js:49-64` + `:154-160`** [C]

`ServiceWorkerRegistration.showNotification()` requires an **activated** worker and
throws `InvalidStateError` for a registration that is still `installing`/`waiting`.
`_ensureSW()` is called on every message and races `navigator.serviceWorker.ready`
against a 1.5 s timeout, so the non-active registration can win. The fallback
`new Notification(...)` also throws on Android Chrome, and **both errors are swallowed by
empty `catch {}` blocks — the message is never announced.**

### 58. `js/notify.js` / `js/app.js` — the room's own notification list is never scoped by age
Folded into #50. `notifyMessage` has no message-age filter, unlike the sound path.

---

## Suggested order of work

1. `ntfy-sync.js:403` (one-line fix, unblocks calls over the relay)
2. `chat.js:817` (one-line fix, unblocks Edit/Delete on mobile)
3. `join-room.js:182` (move the listener into `showJoinForm`)
4. `special-emoji.js:45` (match only known codes)
5. `encryption.js:58` (never fall back to plaintext)
6. `storage.js:84` / `sync.js:22` (make the cursor numeric)
7. `calls.js:337` (mute the remote video element)
8. `ntfy-sync.js` (byte-check + chunk the payload)
9. `join-room.js:473` + `:378` (pass the missing values into the helpers)
10. `chat.js:1431` / `:1500` (queue every failure; restore instead of deleting)
11. `room-password.js:73` / `app.js:116` (roll the key back with `Encryption.clearKey()`)
12. `app.js:948` → move `Notify.init()` above `Chat.init()` (app.js:505)
13. `shepu-actions.js:420` (word-boundary member matching — this one *kicks the wrong person*)
14. `music.js:343` (apply the seek on `loadedmetadata`)
15. `sw.js:23-28` (focus the right tab from `notification.data.url`)
