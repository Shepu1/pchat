# Pchat × Firebase — Sustainable Free-Tier Plan

> **Status:** Phase 5 complete (2026-10-24). Phase 6 (beta) is next — invite 10–20 users and monitor Firestore reads/writes daily.
> **Scope:** friend requests, in-room friend invites, "active in the last 15 minutes".
> **Constraint:** Firebase **Spark (no-cost)** only. Chat messages never move to Firebase.

## সারসংক্ষেপ (বাংলা)

- Firebase শুধু **social layer** — Auth, friend graph, presence timestamp, encrypted invites.
- Chat/rooms আগের মতোই থাকবে: Google Sheet + Apps Script + P2P/ntfy.
- Message, file, avatar — কিছুই Firebase-এ যাবে না।
- Presence আলাদা doc-এ নয়; `users/{uid}`-এর ভিতরে `lastActiveAt`। Interaction-এ ১২ মিনিট throttle, ১৫ মিনিট active window, listener নেই, ৫ মিনিট cache।
- Invite-এ room link **friend-এর public key দিয়ে encrypt** করে Firestore-এ রাখা হবে; Firebase link পড়তে পারবে না।
- লক্ষ্য: **৪০০–৬০০ DAU** Spark-এর মধ্যে। ৭০% quota-তে alert।
- Firebase down/quota শেষ হলে **chat চলবে**, invite-এ "Copy link" fallback থাকবে।

---

## 1. Goal

Add three features without breaking the product promise ("your data stays in your Drive"):

1. **Friend requests** — search by handle, send/accept/decline, friends list.
2. **In-room invites** — pick friends inside a room and invite them in-app.
3. **Activity status** — friends see "Active now" if the user was in the app within 15 minutes.

Success criteria:

- Chat, rooms, calls, music keep working exactly as today.
- If Firebase is unavailable, only the social layer degrades.
- Spark quota is respected with headroom for ~400–600 DAU.
- Firebase never sees a room's `#k=` secret or message content.

## 2. Non-goals

- No messages, files, voice notes, or room history in Firestore.
- No Firebase Storage (not available on Spark).
- No Cloud Functions in v1 (Blaze-only).
- No background push in v1 (in-app delivery only; ntfy/Blaze later).
- No Firebase Analytics (contradicts the "no tracking" promise).
- No Firebase Hosting for the main app (360 MB/day is too small for `assets/music`).

## 3. Architecture

```
Browser
 ├─ Firebase Auth .............. identity (UID)
 ├─ Firestore .................. friends, presence, encrypted invites
 └─ Google Drive / Sheets ...... rooms, messages (unchanged)
     └─ Apps Script ............ room API (unchanged)
```

Rules of the design:

- Firebase is a **social layer**, not a chat backend.
- The chat path never calls Firebase.
- If Firestore fails, room creation/join/chat continue; friend features show a cached state.
- Firebase project failure must never block the app shell.

## 4. Data model

```
users/{uid}
  name: string
  handle: string                 // immutable in v1, unique via usernames/{handle}
  avatar: string                 // emoji or initial — never an image
  pubKey: object                 // ECDH P-256 public JWK for invite encryption
  friendUids: string[]           // social graph; also used by read rules
  lastActiveAt: timestamp
  flags: { showPresence: bool }
  createdAt: timestamp

usernames/{handle}
  uid: string                    // public search index; no presence data

friendRequests/{fromUid_toUid}
  from, to, status: pending|accepted|declined, createdAt

users/{uid}/invites/{fromUid_roomId}
  from, fromName, iv, epk, ciphertext, createdAt, expiresAt, seen: bool
```

Why `friendUids` lives in the user document:

- Firestore Security Rules `get()` / `exists()` calls are **billed as extra reads**.
- A rule like `request.auth.uid in resource.data.friendUids` costs **zero** extra reads.
- The friend list refresh becomes `1 (own doc) + N (friend docs)` reads, and each friend doc already contains name, avatar, and `lastActiveAt`.
- Cost: friends can read each other's `friendUids` array. Disclose this in the privacy policy (v1). A private-graph variant doubles reads; defer.

Constraints:

- Keep `friendUids` under ~300 entries per user to bound document size and egress.
- Never store images or blobs in a document.
- Field names are stored per document; keep them short.

## 5. Quota budget (Spark)

Daily limits: **50,000 reads / 20,000 writes / 20,000 deletes**, 1 GiB stored, 10 GiB/month egress.

Budget at 400 DAU, 20 visible friends, 3 friend-list refreshes/day:

| Item | Reads/day | Writes/day |
|---|---:|---:|
| Auth/profile bootstrap | 400 | 400 |
| Own profile + friendUids (3/day) | 1,200 | 0 |
| Friend list + presence (20 × 3) | 24,000 | 0 |
| Friend-request listener (3 app opens) | 1,200 | 1,000 |
| Invite listener + invite views | 1,200 | 1,000 |
| Handle search | 400 | 0 |
| Room/dashboard metadata | 1,000 | 500 |
| **Planned total** | **~29,400 (59%)** | **~2,900 (15%)** |
| Presence updates (15/user/day, 12-min throttle) | 0 | 6,000 |
| **Grand total** | **~29,400 (59%)** | **~8,900 (45%)** |

Capacity:

- **400 DAU:** comfortable (59% reads, 45% writes).
- **500 DAU:** ~74% reads, ~56% writes — soft cap + 70% alert.
- **600 DAU:** ~88% reads, ~67% writes — review before growing.
- Friend-list reads are capped at the **visible page (20)**, so users with 500 friends do not multiply the cost.

Important billing facts:

- Every query has a **minimum charge of 1 read**, even with zero results.
- Real-time listeners charge 1 read per added/updated document.
- Rules `get()`/`exists()` add reads — avoid them on hot paths.
- Reads from the local cache are free.
- TTL deletes are **not** covered by the free tier — delete from the client.

## 6. Presence design

Requirement: "active if seen in the app within 10–15 minutes" — a timestamp comparison, not a live green dot.

Write path:

- `lastActiveAt` on the user's own document (1 write, no fan-out).
- **Event-driven, not a fixed timer:** write on app open, tab focus, room join, message send, and meaningful interaction (throttled to 1 per **12 minutes**).
- Stop after **15 minutes without interaction**; the status expires naturally after the 15-minute window.
- This keeps 400-DAU writes around 6,000/day (15 per user) instead of a fixed 10-minute timer, which could exceed 20K/day for heavy users.
- One tab only (leader election via `navigator.locks` or localStorage).
- `updateDoc` with a single field; `serverTimestamp()`.

Read path:

- Read only when the friends panel / invite picker is visible — never on app load.
- Read only the **visible page** (20 friends).
- Cache for 5 minutes in localStorage; show cached status instantly.
- `active = Date.now() - lastActiveAt < 15 * 60 * 1000`.
- No listeners for presence.
- Use Firestore cache (`getDocs(q, { source: 'cache' })`) before the server.

Privacy:

- `users/{uid}` is readable only by self and friends (rule checks `friendUids`).
- `usernames/{handle}` exposes only handle → uid.
- `flags.showPresence = false` stops heartbeat writes; friends see "offline".

Degradation:

- At **70%** of daily writes, increase the throttle to 20 minutes; at **85%**, stop presence writes and show cached status.
- On `resource-exhausted`, stop presence reads/writes, show cached "last seen", keep chat working.
- Exponential backoff; do not retry aggressively.
- Remote Config kill switch (Phase 5).
- Client-side counters for debugging.

## 7. Invite design

Sender:

1. Open the friend picker inside `room.html`.
2. Build the existing invite link (`?r=&ep=&n=&th=#k=`).
3. For each selected friend:
   - ECDH: ephemeral P-256 private key × friend's `pubKey`.
   - HKDF → AES-GCM key; AAD = `from:to:inviteId`.
   - Encrypt `{ roomName, fullLink }`.
4. Write `users/{friendUid}/invites/{fromUid_roomId}` (deterministic ID).
5. Show "Sent to N friends"; failures stay retryable.

Receiver:

1. Global listener (loaded on `index.html`, `room.html`, `settings.html`, `owner.html`):
   `where('seen', '==', false)`.
2. New document → decrypt → toast "Rahim invited you to 'Family Chat'" [Join] [Dismiss].
3. Join → `location.href = fullLink` → existing join flow.
4. Delete the document after handling.
5. Expired invites are ignored and deleted.

Offline / closed app:

- The document waits in Firestore; the next app open delivers it.
- Spark cannot send FCM without a trusted server. v1 is in-app only.
- Later: ntfy poke (best-effort) or Blaze + Cloud Function.
- Always keep a "Copy link / Share" fallback so invites work even when Firestore is down.

Key management:

- Private key in IndexedDB (non-extractable `CryptoKey`).
- Multi-device: wrap the private key with a passphrase-derived key (PBKDF2, same pattern as `room-password.js`) and store the wrapped blob in the user document. One unlock per new device.
- Losing the passphrase loses old invites only; rooms are unaffected.

## 8. Auth integration

Two identities exist today:

- Google Identity Services (GIS) token for Drive/Sheets/Apps Script.
- No stable app identity for the social layer.

Plan:

- Keep GIS for Google API access (no change to room creation).
- After GIS returns an access token, sign in to Firebase with
  `signInWithCredential(auth, GoogleAuthProvider.credential(null, accessToken))`.
- One Google popup, one consent, same UX as today.
- If Firebase rejects the cross-client token, fall back to
  `signInWithPopup(GoogleAuthProvider)` with Drive scopes added.

Phase 0 decision: use the existing OAuth client's Google Cloud project for Firebase (if accessible), or create a new Firebase project and use its Web client ID for GIS.

## 9. Security rules (shape)

```
users/{uid}
  read:   self OR request.auth.uid in resource.data.friendUids
  create: self
  update: self (immutable handle/createdAt)
  delete: self
  friends graph is embedded in the document

usernames/{handle}
  read:   any signed-in user
  create: uid == request.auth.uid
  update/delete: deny (v1)

friendRequests/{id}
  read:   from or to
  create: from == request.auth.uid && status == 'pending'
  update: to (accept/decline)
  delete: from or to

users/{uid}/invites/{id}
  read/delete: self
  create: from == request.auth.uid
          && request.auth.uid in get(users/{uid}).data.friendUids
```

Notes:

- The invite create rule uses one `get()` — acceptable because invites are rare.
- Accepting a request writes both `friendUids` arrays in a batch; the target-side rule verifies the pending request with one `get()`.
- Removing a friend: both sides remove each other; a user may remove **themselves** from another user's array (never add).
- All rules get unit tests in the emulator.

## 10. Phases

### Phase 0 — Setup (owner)

Create the Firebase project, Firestore, Auth, config, CLI login, alerts.
**Done so far:** project + Firestore + Google sign-in + web app config (`js/firebase-config.js`).
**Still open:** `firebase login` on this machine, production domain confirmation, quota alerts.
**Done when:** `firebase projects:list` shows the project and the CLI is authenticated.

### Phase 1 — Foundation (me) — built 2026-10-23

- [x] `js/firebase-config.js` (public config, analytics omitted)
- [x] `js/firebase.js` (lazy SDK loader, auth bridge, profile bootstrap, emulator switch)
- [x] `firestore.rules`, `firestore.indexes.json`, `firebase.json`, `.firebaserc`
- [x] Emulator rules tests — **23/23 pass** (`npm run test:rules`)
- [x] Auth bridge implemented: GIS access token → `signInWithCredential`
- [ ] Live auth-bridge test on `http://localhost:8080/tools/firebase-test.html`
- [ ] Deploy rules/indexes to `pchat-shepu`

**Done when:** Google sign-in creates `users/{uid}`, survives refresh, and the deployed rules match the emulator tests.

### Phase 2 — Friend graph (me)

- Handle setup + search
- Background Firebase bootstrap on `index.html` (login must not wait on Firebase)
- Send/accept/decline requests
- Friends list, unfriend
- Rules tests for cross-user access
**Done when:** two accounts can become friends; a third cannot read their data.

### Phase 3 — Presence (me)

- `lastActiveAt` updates (12-min throttle, visible, active, one tab)
- Friend list presence with 5-min cache and 20-per-page limit
- "Active now / 12m ago" rendering
- Quota guard + cached fallback
**Done when:** status is correct within 15 minutes and simulated 400-DAU usage stays under 30K reads/day.

### Phase 4 — Invites (me)

- Invite picker in `room.html`
- E2EE payload (ECDH + AES-GCM)
- Global listener + toast + badge
- Accept → join link, delete/expiry
- Copy-link fallback
- Multi-device key backup
**Done when:** invite arrives in-app in seconds; offline receiver sees it on next open; the Firestore document contains no readable link.

### Phase 5 — Hardening + docs (me)

- Remote Config kill switches (`friends_enabled`, `presence_enabled`)
- Monitoring alerts at 70% reads / 70% writes
- Privacy policy, `PRODUCT.md`, `README.md`, `about.html`, help data
- `node tools/generate-help.js --check`
- Rules audit + load test
**Done when:** docs pass the generator check and alerts are live.

### Phase 6 — Beta (owner + me)

- 10–20 invited users for one week
- Watch reads/writes daily
- Fix, then 100 users, then 300
- Review at 400–500 DAU: optimize or plan Blaze

## 11. Your Phase 0 checklist (do these in order)

### Step 1 — Create the Firebase project

1. Open <https://console.firebase.google.com>.
2. **Add project** → name `pchat-shepu` (or your choice).
3. **Google Analytics: OFF** (privacy promise).
4. Create.

> If you still have access to the Google Cloud project that owns the existing OAuth client (`199864473289-...`), you may add Firebase to that project instead. That keeps the existing OAuth consent and Drive scopes. Tell me which path you choose.

### Step 2 — Create Firestore

1. **Build → Firestore Database → Create database**.
2. Choose **Production mode** (not test mode).
3. Location: **`asia-south1` (Mumbai)**.
4. Create.

> ⚠️ The location **cannot be changed later**. Mumbai is the best default for Bangladesh. `asia-southeast1` (Singapore) is the alternative.

### Step 3 — Enable Authentication

1. **Build → Authentication → Get started**.
2. **Sign-in method → Google → Enable** → choose a support email → Save.
3. Optional: **Email/Password → Enable** (only if you want non-Google accounts).
4. **Settings → Authorized domains** → add:
   - `localhost`
   - your production domain (e.g. `pchat.example.com`)
   - `pchat-shepu.firebaseapp.com` (usually automatic)

> **Cross-project auth fix:** the GIS client ID belongs to the old Cloud project (`199864473289`), while Firebase is `pchat-shepu`. Open **Authentication → Sign-in method → Google → Safelist client IDs from external projects** and add the GIS web client ID (`199864473289-...apps.googleusercontent.com`). This lets the existing Drive access token become a Firebase credential. If the safelist is not enough, set **Web SDK configuration** to the old client ID + secret instead.

### Step 4 — Register the web app

1. Project overview → gear → **Project settings → General**.
2. **Your apps → Web (`</>`) → Register app**.
3. Nickname: `pchat-web`.
4. Copy the `firebaseConfig` object.
5. Send it to me (it is public — security comes from rules, not the API key).

Do **not** enable Storage, Functions, or Analytics.

### Step 5 — Install the CLI and log in

```bash
npm install -g firebase-tools
firebase login
firebase use --add      # select your project, alias: default
```

Tell me when `firebase projects:list` works.

### Step 6 — Create test accounts

Create 2–3 Google accounts for testing friends and invites (or use the emulator later).

### Step 7 — Approve the product/privacy change

Friends require a central user graph. I will update:

- `privacy.html` — what Firebase stores (uid, name, handle, friend graph, `lastActiveAt`, encrypted invites)
- `PRODUCT.md` / `about.html` — "Friends is optional; rooms still need no account"
- `README.md` — architecture + setup
- `tools/generate-help.js` — documentation entries so `--check` passes

Reply "privacy approved" if you accept this.

### Step 8 — Send me these values

```
1. firebaseConfig JSON
2. projectId
3. Firestore region
4. Auth: Google only / Google + email
5. Hosting: keep current / move to Firebase
6. Production domain
7. Privacy approved: yes/no
8. CLI login done: yes/no
9. Firebase on existing Cloud project: yes/no
```

## 12. What I will build

```
js/firebase-config.js     public Firebase config (you fill the values)
js/firebase.js            lazy SDK loader, init, auth bridge, emulator switch
js/friends.js             handle search, requests, friendships, unfriend
js/social-presence.js     heartbeat, 5-min cache, quota guard
js/invites.js             ECDH + AES-GCM invite create/listen/accept
js/friend-ui.js           friend picker, request badge, invite toast
firestore.rules
firestore.indexes.json
firebase.json
tools/seed-emulator.js
tools/quota-model.js
tests/firestore.rules.test.js
```

Integration points:

- `js/auth.js` — after GIS sign-in, call the Firebase bridge.
- `index.html` — friends panel, request badge, global toast host.
- `room.html` — "Invite friends" button beside the existing Invite.
- `settings.html` — handle, active-status toggle, "delete my social data".
- `js/config.js` — `FIREBASE_ENABLED`, `FIREBASE_EMULATOR`.
- `tools/generate-help.js` — friends/invites/presence docs.

## 13. Monitoring and rollback

Monitoring:

- Firebase Console → Firestore → Usage (reads/writes/storage daily).
- Cloud Monitoring alert at 70% of daily reads and writes.
- Client counters in localStorage for debugging.
- Weekly review during beta.

Rollback:

- Remote Config `friends_enabled=false` hides the UI without deleting data.
- Remove the three script tags to disable the module entirely.
- Chat is independent; no rollback needed there.
- Export/delete script for social data.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Read quota exhausted | Visible-page reads, 5-min cache, no presence listeners, kill switch |
| Rules `get()`/`exists()` cost reads | `friendUids` array rule, no rule reads on hot paths |
| Auth bridge rejected | Spike first; fallback to Firebase Google popup with Drive scopes |
| Room secret leaks via invite | E2EE payload; audit the Firestore document in tests |
| Multi-device key mismatch | Passphrase-wrapped key backup |
| Privacy perception | Opt-in Friends, clear policy, active-status toggle, delete option |
| Free-tier policy change | `FriendsStore` abstraction; data export; Blaze path documented |
| No background push | In-app delivery + copy-link fallback; ntfy/Blaze later |
| Firebase outage | Chat path independent; cached social state |

## 15. Decisions

**Blocking Phase 1**

- D1. Auth bridge: GIS token → Firebase credential (recommended) vs Firebase Google popup with Drive scopes.
- D2. Email/password: off (recommended) vs on.
- D3. Hosting: keep current (recommended) vs Firebase Hosting.
- D4. Firestore region: `asia-south1` (recommended) vs `asia-southeast1`.
- D5. ✅ Resolved: new Firebase project `pchat-shepu` (project number `1019767137930`). The GIS client still belongs to the old Cloud project `199864473289`; the live auth test will show whether the token bridges across projects.

**Can decide later**

- D6. Friend graph visible to friends (v1, recommended) vs private (2× reads).
- D7. Presence default on (recommended) vs off.
- D8. Invite encryption: E2EE (mandatory in this plan).
- D9. Multi-device key backup: passphrase-wrapped (recommended) vs per-device keys.
- D10. Beta size and dates.

---

*Next action: add the GIS client ID to the Google provider's "Safelist client IDs from external projects", deploy `firestore.rules` + indexes, run `tools/firebase-test.html` on `localhost:8080`, and send the log. If the bridge still fails with `auth/invalid-credential`, set the Google provider's Web SDK configuration to the old client, or align the OAuth client with the Firebase project.*
