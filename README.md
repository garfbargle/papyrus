# Papyrus

Papyrus is a quiet, local-first Markdown notebook built with Tauri 2, React, CodeMirror 6, and SQLite.

## What works now

- Three-pane desktop notebook; focused Categories → Notes → Note navigation on phones
- Local SQLite storage, migrations, full-text search, recency sorting, categories, and 30-day Trash
- Paper-first Markdown editor with direct formatting, autosave, keyboard undo/redo and find. Markdown stays canonical, with a raw-source escape hatch when you want it.
- Familiar Markdown shortcuts such as `## Heading` and `- [ ] Task`, plus a right-click menu for headings, lists, checklists, links, code, and images
- Markdown headings, lists, links, code, tables, blockquotes, and inline image previews
- Inline image insertion for PNG, JPEG, GIF, and WebP (up to 4 MB); images live directly in the Markdown as portable data URLs
- Complete-notebook ZIP export, arranged by category with readable Markdown and YAML metadata
- End-to-end encrypted device sync with one-time QR pairing, immutable revisions, durable retry queues, tombstones, device revocation, and explicit conflict review
- A touch-first mobile Settings and Sync flow, including QR camera scanning and safe folder management

## Run it

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

To package a native macOS app:

```sh
npx tauri build --bundles app
```

The resulting app is written to `src-tauri/target/release/bundle/macos/Papyrus.app`.

## Privacy and scope

Every device keeps a complete SQLite notebook and editing never waits for the network. Sync packages are authenticated and encrypted on-device; the relay sees only opaque routing identifiers, ciphertext, acknowledgements, and expiry times. Markdown export remains available even when sync is never enabled.

See [`relay/README.md`](relay/README.md) for local failure simulation, testing, and deployment.
