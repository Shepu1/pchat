# SHEPU ROOMS

> **Create a room. Own the data.**

SHEPU ROOMS is a privacy-first chat platform where every room's data lives in the **room owner's Google Drive**, not in a central platform database.

> 📖 **Product page → [`PRODUCT.md`](PRODUCT.md)**
> A public-facing overview: what the app does, why it's different, how to
> get started, the bot commands, privacy, and the FAQ.

---

## Architecture Overview

```
Guest / Member
  ↓
SHEPU ROOMS frontend (HTML/CSS/JS)
  ├─ Room endpoint (Google Apps Script web app)
  │    └─ Owner's Google Sheet (owner's Drive)   ← chat messages live here
  └─ Firebase Firestore (optional social layer)   ← friends, presence, invites
       · never sees room links, messages, or secrets
       · chat works without Firebase; only Friends degrades if Firebase is down
```

Each room is backed by:
1. A **Google Sheet** in the room owner's Drive (messages, members, config)
2. A **Google Apps Script web app** bound to that Sheet (the room's backend API)
3. A **shareable room link** that embeds the endpoint URL (base64-encoded)

> **Privacy note:** Room data is stored in the room owner's connected Google storage rather than in a central SHEPU ROOMS message database. The platform hosts only the frontend and static assets. The optional Friends layer uses Firebase Firestore for the social graph only — no message content ever reaches Firebase.

---

## Firebase Social Layer Setup (optional)

The Friends / Invite system uses Firebase Spark (free tier). Chat works without it.

1. Create a Firebase project at [console.firebase.google.com](https://console.firebase.google.com) and enable Google Analytics.
2. Enable **Firestore** (Production mode, region `asia-south1`).
3. Enable **Authentication → Google sign-in**.
4. Register a Web app — copy the complete `firebaseConfig` object, including `measurementId`, into `js/firebase-config.js`.
5. In **Authentication → Sign-in method → Google → Safelist client IDs from external projects**, add your GIS client ID.
6. Deploy Firestore rules and indexes:

```bash
npx firebase-tools deploy --only firestore
```

7. Set `FRIENDS_ENABLED: true` and `PRESENCE_ENABLED: true` in `js/config.js` (already the default).

> **Kill switch:** set either flag to `false` in `js/config.js` to disable the social layer without removing script tags. Chat is never affected.

---

## Google Cloud Setup

### 1. Create a Google Cloud Project

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g., `shepu-rooms`)

### 2. Enable APIs

Enable the following APIs in your project:

- **Google Drive API** — `drive.googleapis.com`
- **Google Sheets API** — `sheets.googleapis.com`
- **Apps Script API** — `script.googleapis.com`

```bash
# Using gcloud CLI:
gcloud services enable drive.googleapis.com sheets.googleapis.com script.googleapis.com
```

### 3. OAuth Consent Screen

1. Go to **APIs & Services → OAuth consent screen**
2. Select **External** (for testing) or **Internal** (for Google Workspace)
3. Fill in app name: `SHEPU ROOMS`
4. Add authorized domains: your hosting domain
5. Add scopes:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/script.projects`
   - `https://www.googleapis.com/auth/script.deployments`

### 4. Create OAuth 2.0 Client

1. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
2. Application type: **Web application**
3. Authorized JavaScript origins: `http://localhost:8080` (dev), `https://yourdomain.com` (prod)
4. Copy the **Client ID**

### 5. Configure the App

Edit `js/config.js`:

```js
GOOGLE_CLIENT_ID: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
```

> **Never commit your Client ID to a public repository.** Use environment injection or a config file excluded from git.

### 6. PCHAT Flutter App Sign-In (Android + Desktop)

The Flutter wrapper (`pchat_app`) uses platform-specific Google sign-in:

- **Android** — the phone's own Google account picker via `google_sign_in`
  (Credential Manager). Add an **Android** OAuth client in the **same** Google
  Cloud project as the web client:
  - **Package name:** `com.shepu.pchat`
  - **SHA-1:** fingerprint of the certificate the APK is signed with. For the
    default debug keystore:
    ```bash
    keytool -list -v -keystore ~/.android/debug.keystore \
      -alias androiddebugkey -storepass android -keypass android | grep SHA1
    ```
  - Add the release keystore's SHA-1 too before publishing.
  - The wrapper passes the **web** client ID as `serverClientId`; no client
    secret is used.
  - Missing Android client/SHA-1 can make the picker close immediately (Google
    may report it as a configuration error or as `canceled`). In that case the
    wrapper can still use the browser page below.

- **Desktop (Windows/Linux)** — the wrapper opens
  `/pchat/app-login.html` in the default browser. That page runs the normal GIS
  token flow on the site origin, then posts the token to a one-shot
  `http://127.0.0.1:<random-port>` server inside the app (`state` is validated).
  The app injects the token into its WebView, so the site signs in
  automatically.
  - `app-login.html` must be deployed with the site. Verify:
    ```bash
    curl -I https://pchatshepu.vercel.app/pchat/app-login.html
    # HTTP/2 200
    ```
  - The web OAuth client's **Authorized JavaScript origins** must include the
    site origin (`https://pchatshepu.vercel.app`).
  - If the page is missing or unreachable, the wrapper falls back to its
    embedded sign-in WebView (desktop only).

- **Email/demo logins** remain local-only. Drive/Sheets actions require a real
  Google login, so `Auth.getAccessToken()` no longer hands out fake
  `email_token_…` tokens.

---

## Local Development

Since this is plain HTML/JS/CSS, you just need a static file server.

### Option A: Python

```bash
cd /path/to/PCHAT
python3 -m http.server 8080
```

Then open: `http://localhost:8080`

### Option B: VS Code Live Server

Install the **Live Server** extension and click **Go Live**.

### Option C: npx serve

```bash
npx serve .
```

---

## Production Deployment

Deploy the static files to any static hosting service:

- **GitHub Pages** — push to a `gh-pages` branch
- **Netlify** — drag and drop the folder
- **Vercel** — `vercel --prod`
- **Firebase Hosting** — `firebase deploy`
- **Cloudflare Pages**

Update `js/config.js` with your production domain's Client ID authorized origins.

> **Using the Flutter wrapper?** Deploy `app-login.html` together with the rest
> of the site. The desktop wrapper opens
> `https://<your-domain>/pchat/app-login.html` to finish Google sign-in in the
> default browser. See **Google Cloud Setup → 6. PCHAT Flutter App Sign-In**.

---

## Room Creation Flow

When a user creates a room:

1. **Google Sign-In** — OAuth 2.0 token flow (GIS popup, no server required)
2. **Find/Create Drive Folder** — `SHEPU ROOMS` folder in owner's Drive
3. **Create Google Sheet** — `SHEPU ROOM — {Name}` with 6 tabs: `messages`, `members`, `room_config`, `attachments`, `moderation`, `sync_state`
4. **Initialize Tabs** — write headers and room config
5. **Create Apps Script Project** — bound to the Sheet using the Apps Script API
6. **Upload Code** — uploads `Code.gs` and `appsscript.json` manifest
7. **Create Version + Deployment** — web app deployment as `USER_DEPLOYING` / `ANYONE_ANONYMOUS`
8. **Generate Room Link** — `https://yourdomain.com/join.html?r={roomId}&ep={base64(deploymentUrl)}`

The `ep` parameter encodes the deployment URL so guests can connect without any central lookup service.

### Fallback Manual Setup

If the Apps Script API is blocked (requires Google Workspace or specific Cloud project settings), the app offers a **manual setup wizard**:

1. Copy the generated `Code.gs` to a new Apps Script project
2. Bind it to your spreadsheet
3. Deploy as a web app (`Execute as: Me`, `Who has access: Anyone`)
4. Paste the web app URL back into SHEPU ROOMS

---

## OAuth Scopes

| Scope | Purpose |
|---|---|
| `drive.file` | Create/manage Sheets and Drive folders created by this app |
| `spreadsheets` | Read/write spreadsheet data |
| `script.projects` | Create bound Apps Script projects |
| `script.deployments` | Create web app deployments |
| `openid`, `email`, `profile` | User identity |

---

## Security Model

- **Guests never access the Google Sheet directly** — all operations go through the Apps Script web app endpoint
- **The Apps Script web app executes as the room owner** — it has authority to read/write the Sheet
- **Guests authenticate with a session token** — issued at join time, stored in localStorage
- **Rate limiting** — 20 messages per 10 seconds per member
- **Soft delete** — messages are marked deleted, not permanently removed
- **Room controls** — owner can lock (read-only), disable (no new messages), or delete the room
- **Member moderation** — owner can remove or ban members

### What SHEPU ROOMS Does NOT Do

- Store message content in any SHEPU ROOMS database
- Expose the Google Sheet directly to guests
- Store Google OAuth tokens beyond the browser session
- Log message content in any server logs

---

## Bot Commands (@shepu-ai)

Mention `@shepu-ai` in the chat to talk to the bot. Besides answering
questions, it understands a set of **local room commands** — these are
parsed on-device (never sent to the AI provider) and work in English,
Banglish and Bangla.

| Say | What happens |
|---|---|
| `theme 3` · `theme number 4` · `থিম ৩ করো` | Sets that wallpaper for the whole room |
| `theme change koro` · `random theme dao` · `background badal dao` | Picks a theme for you |
| `which theme is this` · `কোন থিম চালু আছে` | Tells you the current theme |
| `call Rahim` · `audio call koro` | Starts a call (1:1 or room-wide) |
| `remove Rahim` · `Rahim ke ber kore dao` | Removes a member (asks first) |
| `invite link dao` · `room link share koro` | Shares the invite link (copies it) |
| `room lock koro` · `room unlock koro` | Locks / unlocks the room (owner only) |
| `delete room` | Deletes the room (asks first) |
| `koto jon ache` · `member list dao` | Lists the members |
| `gan chalu` · `gan bondho` · `gan chenge` | Room radio: play / stop / next track |
| `password off` | Points you to Settings → Room Password |

Theme and music changes apply to everyone in the room and are relayed to
the other devices, so the whole room sees them.

---

## Message Synchronization

Google Sheets has [API quotas](https://developers.google.com/sheets/api/limits) (read/write requests per minute per project). SHEPU ROOMS is optimized for **small private rooms**, not large-scale public chat.

Optimizations:
- **Incremental sync** — only fetch rows newer than `lastRow` cursor
- **Exponential backoff** — on 429 or 5xx responses
- **IndexedDB caching** — show cached messages immediately on load
- **Throttled presence** — heartbeat every 20s, not on every event
- Recommended: **≤ 20 active users per room** for comfortable quota usage

---

## File Structure

```
PCHAT/
├── index.html          — Home + dashboard (chats, create, join)
├── login.html          — Sign-in page
├── create.html         — Create room flow
├── join.html           — Join room by link
├── room.html           — Chat interface
├── settings.html       — Account settings
├── owner.html          — Owner management panel
├── about.html          — About the app (public product page)
├── help.html           — Help: every feature, generated from the app
├── privacy.html        — Privacy policy (public page, linked from Settings)
│
├── css/
│   ├── base.css        — CSS variables, reset, typography
│   ├── layout.css      — Navbar, page, grid layout
│   ├── components.css  — Buttons, forms, modals, cards, badges
│   ├── chat.css        — Chat feed, bubbles, input bar
│   ├── calls.css       — Call overlay
│   ├── dashboard.css   — Main dashboard & conversation hub styles
│   ├── help.css        — About & Help pages
│   └── responsive.css  — Breakpoints (360px → 1280px+)
│
├── tools/
│   ├── generate-help.js        — Scans the project → js/help-data.js
│   ├── verify-help.js          — Smoke test for the About & Help pages
│   ├── verify-encrypted-reply.js — Encrypted replies and notifications
│   └── verify-emoji-order.js   — Smoke test for emoji picker ordering
│
├── js/
│   ├── config.js       — Central configuration (set CLIENT_ID here)
│   ├── auth.js         — Google OAuth 2.0 via GIS token model
│   ├── google.js       — Base HTTP client for Google REST APIs
│   ├── drive.js        — Drive API: create folder, create Sheet
│   ├── sheets.js       — Sheets API: init tabs, headers, config
│   ├── apps-script.js  — Script API: create project, upload, deploy
│   ├── rooms.js        — Room registry + RoomAPI client (calls Apps Script endpoint)
│   ├── chat.js         — Chat UI: render messages, send, edit, delete, reply
│   ├── members.js      — Member list fetching and caching
│   ├── presence.js     — Throttled presence heartbeat
│   ├── storage.js      — localStorage helpers + IndexedDB wrapper
│   ├── sync.js         — Incremental message sync loop with backoff
│   ├── encryption.js   — AES-GCM encryption module (Phase 3, inactive by default)
│   ├── ui.js           — Toast, modal, DOM utilities
│   ├── owner.js        — Owner panel logic
│   ├── create-room.js  — Create room flow orchestration
│   ├── join-room.js    — Join room flow
│   ├── dashboard.js    — index.html entry point (rooms list, filter, modals)
│   └── app.js          — room.html entry point (session → sync → presence)
│
├── apps-script/
│   ├── Code.gs         — Room backend reference code (same as template in apps-script.js)
│   └── appsscript.json — Apps Script manifest
│
├── assets/
│   └── icons/
│       └── favicon.svg
│
├── README.md
└── .gitignore
```

---

## Known Limitations

1. **Google Sheets quotas** — per-minute read/write limits mean the app is not suitable for large public rooms. Optimized for ≤ 20 users.
2. **Apps Script cold starts** — first request to a web app may take 2–5 seconds.
3. **No real-time push** — uses polling (4-second interval). Not WebSocket-based.
4. **Apps Script API access** — requires the Apps Script API to be enabled and may require manual setup in some Google Workspace environments.
5. **Token lifetime** — GIS implicit flow tokens expire in ~1 hour. The app refreshes automatically.
6. **Encryption** — messages are AES-GCM encrypted at rest using a key derived from the room secret (embedded in the invite link). Anyone with the invite link can derive the key, so it protects data on the ntfy/localStorage layer, not against a malicious invitee. A manual passphrase option is also available in the chat header for an extra layer.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `Google Identity Services library not loaded` | Check network, ensure GIS script tag loads |
| `Apps Script deployment failed` | Enable Apps Script API in Cloud Console; try manual setup |
| `Room Not Found` | Share the full link including `?ep=` parameter |
| `Invalid session` | Session expired; re-join the room |
| `Rate limit exceeded` | Wait 10 seconds; reduce message frequency |
| `Room is disabled` | Contact the room owner |
| Sync stops working | Check browser console for quota errors; try refreshing |

---

## Keeping the Help page honest

`help.html` is **generated from the project itself**, so it can never drift
away from the app. `tools/generate-help.js` scans the source and writes
`js/help-data.js`:

```bash
node tools/generate-help.js           # regenerate js/help-data.js
node tools/generate-help.js --check   # fail if the committed file is stale
node tools/verify-help.js             # smoke test the About & Help pages
```

What it extracts automatically: every screen and every button on it, the
bot commands, the backend API actions, the room operations, the config
values, the browser storage keys, the sheet tabs and their columns, the
relay servers, the encryption parameters and the asset counts.

The generator **refuses to write** if the code contains a feature the
documentation does not mention — add a bot command without documenting it
and the script fails with the name of the missing entry. The narrative
itself lives in the `DOC` map at the top of `tools/generate-help.js`.

---

## Development Phases

| Phase | Status | Description |
|---|---|---|
| 1 — UI | ✅ Done | All pages, dark theme, responsive |
| 2 — Google Auth | ✅ Done | GIS token model, session storage |
| 3 — Drive/Sheets | ✅ Done | Create Sheet, init tabs, write config |
| 4 — Apps Script | ✅ Done | Create project, upload, deploy |
| 5 — Real Chat | ✅ Done | Join, send, receive, sync, history |
| 6 — Room Management | ✅ Done | Members, ban, lock, disable, delete |
| 7 — Performance | ✅ Done | IndexedDB, incremental sync, backoff |
| 8 — Privacy | ✅ Done | Minimal logging, E2EE key derived from room secret |
| 9 — Files | ⏳ Planned | Image/file upload via Drive |
| 10 — PWA | ⏳ Planned | Service worker, offline shell |
| 11 — Quick Rooms | ✅ Done | PeerJS P2P mode, no local server / no sign-in |
| 12 — Resilience | ✅ Done | Ntfy cloud history relay (works when host is offline) |
| 13 — Engagement | ✅ Done | Web push notifications, typing indicator, seen receipts |

---

## License

MIT — See LICENSE file.

> Room data is stored in the room owner's connected Google storage rather than in a central SHEPU ROOMS message database. SHEPU ROOMS is not responsible for data stored in users' Google Drives.
