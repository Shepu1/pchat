# Pchat · SHEPU ROOMS

### **Create a room. Own the data.**

A private chat app where your conversations live in **your own Google Drive** — not in someone's database, not on our servers.

[Create a room](#getting-started) · [What it does](#what-it-does) · [Privacy](#privacy-and-security) · [FAQ](#faq)

---

## What is Pchat?

Pchat turns a single link into a full chat room.

You create a room, get a link, and send it to whoever you want. They open it, pick a nickname, and you're talking — no signup, no email, no password, no user list, no advertising network.

Here's the part that matters: **the room belongs to you.** If you create it, the messages are written to a Google Sheet inside *your* Google Drive. We never see them. We don't even run a server for your chat — we host the web page and nothing else. If the app disappeared tomorrow, your conversations would still be sitting in your own Drive, readable in a spreadsheet.

Quick rooms are even lighter: there is no server at all. Your messages travel directly between the people in the room, and the room is gone the moment everyone leaves.

---

## Why Pchat

**🗂 Your messages live in your Drive.** Not ours. The room's data is a Google Sheet in the owner's Drive. Read it, back it up, delete it — it's yours.

**🔗 A link is all it takes.** No account, no phone number, no email confirmation. Open the link, choose a name, start talking.

**🔐 Optional end-to-end encryption.** Turn on a room passphrase and everything after it is encrypted on each device before it leaves. We can't read it. Neither can the relay.

**🕵️ No ads, no accounts.** Google Analytics provides aggregate usage measurement; there is no advertising profile or recommendation engine.

**📴 Works on a phone on a weak network.** Quick rooms connect devices directly, and a free relay picks up the slack when a network is too restrictive for a direct connection.

**🎨 Make it yours.** Wallpapers, emoji, a room-wide music player, and a built-in assistant that actually understands room commands.

---

## What it does

### 💬 Chat that behaves properly

- Text, images, files and voice notes
- Reply, edit, delete, react
- Typing indicator and blue "seen" ticks
- Message bubbles that feel right on a phone
- Unread-friendly scrolling, lightbox for images
- If a send fails, the message stays with a **Retry** button — it never silently disappears

### 👥 Know who's here

- Live member list with online / offline state
- Owner controls: rename the room, lock it read-only, disable it, delete it
- Ban or remove a member
- Leave any time

### 📞 Real calls, not a gimmick

- One-to-one **or** ring the whole room
- Video, mute, camera off, screen share
- Minimise and keep chatting while on a call
- A 45-second ring timeout, and a connection that survives a brief network blip instead of dropping

### 🎵 Room radio

One member hits play, everyone hears the same track at the same time. Play, pause, skip, and adjust the volume on your own device.

### 😀 Emoji that feels custom

- 526 hand-picked images across 17 categories, replacing the system emoji set
- A public "Pchat" set with shortcodes like `:v89ca:`
- A **password-locked** pack — unlock it with a password, and the images appear. The pack stays encrypted on disk and is never written anywhere in the clear.

### 🤖 An assistant that lives in the room

Mention `@shepu-ai` and it answers questions — and understands what you mean by *"change the wallpaper"* or *"next song"*.

### 🖥 A proper owner panel

Member statistics, moderation, a link you can regenerate, a QR code, and a CSV export of the whole conversation.

### 🤝 Friends (optional social layer)

- Search for people by @handle and send friend requests
- See who is **active now** (within the last 15 minutes) — a timestamp, not a live tracker
- **Invite friends directly inside a room** — the room link is encrypted end-to-end with their public key before it reaches Firestore; the server never sees the link
- Turn off your active status or delete all social data at any time from Settings → Friends
- Friends is entirely optional: rooms, chat, and calls work without it; only the Friends panel degrades if Firebase is unavailable

---

## How it works

**You create a room.**
Pchat sets up a Google Sheet in your Drive (that's where the messages go) and gives you a private link. The link contains a secret key that never travels to any server — it lives in the part of the URL browsers don't send.

**You share the link.**
Anyone who opens it and picks a name is in. Nothing else is needed. For a quick room there's no setup at all — no Drive, no sign-in, no configuration.

**You talk.**
Messages appear instantly on everyone's screen. In saved rooms the Sheet is the source of truth and is re-read every couple of seconds; in quick rooms messages go device-to-device, with a free public relay as a fallback so the room keeps working when a network blocks direct connections.

The link is also the key. If you have a room passphrase, the passphrase derives the encryption key on each device. If you don't, the link's own secret is used to read any previously-encrypted messages. Either way the server only ever sees what it has to.

---

## Two kinds of room

|  | **Saved room** | **Quick room** |
|---|---|---|
| **Where the messages live** | A Google Sheet in your Drive | On the members' own devices |
| **Sign-in** | Google account | None |
| **Long-term history** | Yes, and you own the file | On each device until the room is cleared |
| **Best for** | Teams, families, anything you want to keep | A quick conversation, right now, no friction |

Both share the same interface, the same bot, the same calls and the same music player.

---

## Getting started

**1 · Open the app and sign in**
Use a Google account if you want a saved room, or skip it entirely for a quick one.

**2 · Create a room**
Give it a name, pick a wallpaper, and get your link and QR code.

**3 · Send the link**
That's it. When people open it, they choose a name and they're in.

Want to make it private? Set a room passphrase before you share the link — the link then carries no key material at all.

---

## The `@shepu-ai` assistant

Ask it anything, or give it a room command in plain language — English, Banglish or বাংলা.

| Say | It does |
|---|---|
| `theme 3` · `theme number 4` · `থিম ৩ করো` | Sets that wallpaper for the whole room |
| `theme change koro` · `background badal dao` | Picks a wallpaper for you |
| `which theme is this` · `কোন থিম চালু আছে` | Tells you the current wallpaper |
| `gan chalu` · `gan bondho` · `gan chenge` | Plays, stops or skips the room track |
| `call Rahim` · `audio call koro` | Starts a call |
| `remove Rahim ke` · `Rahim ke ber kore dao` | Removes a member (asks first) |
| `koto jon ache` · `member list dao` | Lists who's in the room |
| `invite link dao` | Shares the room link |
| `room lock koro` · `room unlock koro` | Locks or unlocks the room |
| `delete room` | Deletes the room (asks first) |
| `what is a binary tree?` | Answers the question |

Room commands are understood on the device — they never reach the AI provider. Everything else is just a normal question.

---

## Privacy and security

**The short version:** your messages are yours, and we can't read them.

**Where the data goes**

|  | Saved room | Quick room |
|---|---|---|
| Message content | Your Google Drive, and nowhere else | Never on a server |
| Who can read it | You (the owner) | The people in the room |
| The relay | Not used for storage | Only sees encrypted payloads |

**What we do**

- Host static web files. That's the entire server footprint.
- Never store, log, index or analyse your messages.
- Never sell or share anything. There is nothing to share — we don't have a database of users.
- Encrypt on the device when a room passphrase is set (AES-GCM, key derived with PBKDF2 at 100,000 rounds).
- Keep the room secret in the URL fragment, which browsers never transmit to a server.
- Derive the relay's channel name from that secret, so the channel can't be guessed without the link.
- Let you rotate your invite link at any time, which invalidates the old one.
- Let you ban, remove, lock or delete a room at any time.

**What we don't do**

- Store your messages in any Pchat database
- Hand out your Google Sheet to guests
- Use your Google token for anything except your own Drive and Apps Script
- Track you across sites, devices or rooms

**A note on links:** anyone holding your room link can read the room. Share it with people you actually want in it. If that list changes, rotate the link.

**A note on encryption:** a room without a passphrase is readable by the relay, because there's no key to encrypt with. If that matters, set a passphrase. A passphrase also can't be recovered later — so keep it somewhere safe.

---

## Good to know

A few honest details, so there are no surprises:

- **A room without a passphrase is not encrypted.** It's a private room, not a secret one. The passphrase option is what makes it secret.
- **Anyone with the link is in the room.** Rotate the link if that stops being true.
- **Google Sheets has usage limits.** Pchat is built for small private rooms — family, friends, a team. It isn't built to run a public channel with thousands of people.
- **A shared computer keeps some local data.** Use *Settings → Privacy → Clear all local data* before handing the device over.
- **Email sign-in is a nickname, not an account.** It identifies you to the room; it doesn't verify who you are. Use Google sign-in if you want a real identity.
- **Calls need a direct path.** If a network blocks peer-to-peer traffic, messages still arrive over the relay, but the call may not connect.
- **You can lose a room if you lose the Drive.** If you delete the sheet, the messages are gone. Save a copy if it matters to you.

---

## FAQ

**Do I need a Google account?**
Only for a saved room. Quick rooms work with nothing.

**Where are my messages stored?**
In a Google Sheet inside the room owner's Google Drive. In a quick room, on each member's own device.

**Can the owner read my messages?**
In a saved room, yes — it's their Drive. In a quick room, no. If you need a room where even the owner can't read you, set a passphrase: the key is derived on your device and never sent.

**Can Pchat staff read my messages?**
No. The app has no server that receives message content, so there is nothing for anyone to read. For a saved room, the data was never with us in the first place.

**How do I keep a message from being read?**
Set a room passphrase from the room menu before you start talking. Everything after that is encrypted on each device.

**What happens if I delete the room?**
The messages are marked deleted. The Sheet itself stays in your Drive until you remove it, so you can still export or delete it yourself.

**How do I leave a room?**
Room menu → Leave. You can rejoin with the same link.

**Does it work on my phone?**
Yes — it's a progressive web app and installs to your home screen. Notifications work on Android and iOS.

**Is it really free?**
Yes. There's no paid tier, because there's no server to pay for.

**Can I use my own server?**
You can host the room's backend on your own Google Apps Script deployment — your own account, your own Sheet, still not our servers. The app only accepts Google Apps Script endpoints and quick-room links, so a stray or hostile invite link can't quietly redirect your chat somewhere else.

---

## বাংলায় দ্রুত শুরু

**১ · রুম বানান** — নাম দিন, wallpaper বাছুন, লিংক পাবেন
**২ · লিংক পাঠান** — যাকে চান, তাকে। অ্যাকাউন্ট লাগবে না
**৩ · লিখুন** — মেসেজ, ছবি, ফাইল, ভয়েস নোট, কল, গান — সবই আছে

**কমান্ড**
- `theme 3` — থিম বদলান
- `gan chalu` — গান চালু করো
- `gan chenge` — পরের গান
- `koto jon ache` — কে কে আছে
- `invite link dao` — লিংক দাও
- `@shepu-ai` — প্রশ্ন করো

**পাসওয়ার্ড দিলে** মেসেজ এনক্রিপ্ট হয় — সার্ভার কিছু পড়তে পারে না।
**লিংক ঘুরিয়ে দিলে** পুরনো লিংক কাজ করে না।

---

## For developers

Setup, deployment, the backend API and the project structure live in the
[`README.md`](README.md). The current defect list and the fix history live
in [`BUGS.md`](BUGS.md).

Inside the app itself there are three more pages: **`help.html`** (every
feature, generated from the app source, so it is never out of date),
**`about.html`** (this page, with live numbers), and **`privacy.html`**
(the plain-language privacy policy, one click from *Settings → Privacy*).

---

<div align="center">

**Create a room. Own the data.**

*Made for people who'd rather not be on someone's server.*

</div>
