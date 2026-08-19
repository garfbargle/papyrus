<div align="center">

# ✦ Pad

### Start anywhere. Pick up everywhere.

**A local-first Markdown notebook that follows you between your devices.**
Private, end-to-end encrypted, and instant whether you are online or not.

[![Made with Tauri 2](https://img.shields.io/badge/built_with-Tauri_2-9d6d38?style=flat-square&labelColor=3f3626)](https://tauri.app)
[![React 19](https://img.shields.io/badge/React-19-9d6d38?style=flat-square&labelColor=3f3626)](https://react.dev)
[![SQLite](https://img.shields.io/badge/storage-SQLite-9d6d38?style=flat-square&labelColor=3f3626)](https://sqlite.org)
[![End-to-end encrypted](https://img.shields.io/badge/sync-end--to--end_encrypted-49a479?style=flat-square&labelColor=3f3626)](#-your-notes-your-keys-nobody-elses-business)
[![notes.c0di.com](https://img.shields.io/badge/web-notes.c0di.com-9d6d38?style=flat-square&labelColor=3f3626)](https://notes.c0di.com)

</div>

---

## The pitch

Most notes apps want to become your operating system. Pad just wants to keep your notebook with you.

Write a grocery list on your phone, then open it on your desktop or on the web. Start a meeting note at your desk and finish it on the couch. Pad keeps a complete local notebook on every paired device, so editing and search are instant and nothing waits for the network.

It is a **paper-first** Markdown notebook: type `## Heading` or `- [ ] Task` and it quietly becomes one—no toolbars to hunt or blocks to summon. Pair a second device with a QR code and Pad syncs in the background with **end-to-end encryption**. The relay only sees ciphertext and routing IDs, never your notes or folder names.

> *"Your notes, where you are."*

---

## ✦ What's in the box

- **📝 Paper-first editor** — WYSIWYG feel, canonical Markdown underneath. Right-click for headings, lists, checklists, links, code, and images. There's a raw-source CodeMirror escape hatch for when you want to see the machinery.
- **☑️ Checklists that actually behave** — `- [ ]` toggles, continues on Enter, and the caret lands exactly where you'd expect.
- **⚡ Markdown shortcuts** — `## `, `- `, `1. `, `- [ ] ` auto-promote as you type.
- **🗂️ Folders that make sense** — expandable tree, drag-and-drop notes between folders, reorder, rename, per-folder counts.
- **🔍 Instant full-text search** — SQLite FTS, recency sorting, `⌘K` to jump, `⌘N` for a fresh page.
- **🖼️ Inline images** — PNG, JPEG, GIF, WebP up to 4 MB, embedded as portable data URLs. Your Markdown stays a single self-contained file.
- **📦 Whole-notebook export** — one ZIP, organized by folder, readable Markdown with YAML metadata. Your notes can always walk out the front door.
- **🗑️ 30-day Trash** — restore, permanent delete, or empty. Mistakes get a grace period.
- **🎨 7 themes, 3 fonts** — Pad (warm parchment with real paper-fiber grain), Mist, Graphite, Nord, Solarized, Dracula, Gruvbox.
- **🔐 Sync everywhere** — QR pairing across phone, desktop, and web; end-to-end encryption; immutable revisions; conflict review that *never overwrites* (Keep Current / Keep Other / Keep Both); and device revocation.
- **📴 Offline-first, always** — autosave, background sync every couple minutes and on focus, but editing never once waits for a network round-trip.
- **📱 Genuinely cross-platform** — macOS, Windows, Linux, **native iOS and Android**, plus the web at [notes.c0di.com](https://notes.c0di.com).

---

## 🔒 Your notes, your keys, wherever you are

Pad is local-first by conviction, not marketing.

- Every device keeps a **complete SQLite copy** of your notebook. The app is fully functional with the Wi-Fi off.
- Notes are encrypted on-device with **XChaCha20-Poly1305**, signed with **Ed25519**, before anything touches the wire.
- Pairing a new device does an **X25519** key exchange seeded by the QR secret, runs it through **HKDF-SHA256**, and hands the vault key straight from device to device. The relay is never in the loop.
- Private keys live in your **OS keychain**; secrets are zeroized in memory after use.
- The [sync relay](relay/README.md) is a Cloudflare Worker that stores only opaque IDs, ciphertext, acknowledgements, and expiry times.

Even if you never turn sync on, Markdown export is always there. Pad is designed to be leaveable — which, paradoxically, is why you'll stay.

---

## 🛠️ Built with

| Layer | Tech |
|---|---|
| Shell | **Tauri 2** (Rust + system webview) — desktop and mobile |
| Frontend | **React 19** · TypeScript · Vite 6 |
| Editors | Custom paper WYSIWYG · **CodeMirror 6** · markdown-it |
| Storage | **SQLite** (bundled, via rusqlite) with FTS |
| Crypto | XChaCha20-Poly1305 · Ed25519 · X25519 · HKDF-SHA256 |
| Sync relay | **Cloudflare Workers** + D1 + R2 |
| Web | Static React build on Cloudflare → `notes.c0di.com` |

---

## 🚀 Run it

```sh
npm install
npm run tauri dev
```

For local sync development, start the relay in another terminal:

```sh
cd relay
npm install
npx wrangler d1 migrations apply papyrus-sync-relay --local
npm run dev
```

Package a native macOS app:

```sh
npx tauri build --bundles app
# → src-tauri/target/release/bundle/macos/Pad.app
```

Deploy the web app and sync relay (after authenticating with Cloudflare):

```sh
npx wrangler login
npm run deploy          # web app → notes.c0di.com
npm run deploy:relay    # applies D1 migrations, then deploys the relay
npm run deploy:all      # relay, then web app
```

See [`relay/README.md`](relay/README.md) for failure simulation, testing, and deployment of the sync relay.

---

## Rebrand compatibility

Pad was previously named Papyrus. Existing app IDs, storage names, keychain services, pairing/wire constants, Cloudflare resources, environment variables, and a few build identifiers intentionally retain `papyrus` so current installs and paired devices keep working.

See [`BRANDING.md`](BRANDING.md) before changing any remaining `papyrus` identifier.

---

<div align="center">

**Pad** — your notes, where you are.

<sub>Write it once. Find it wherever you are.</sub>

</div>
