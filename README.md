# Papyrus

Papyrus is a quiet, local-first Markdown notebook built with Tauri 2, React, CodeMirror 6, and SQLite.

## What works now

- Three-pane desktop notebook; focused Categories → Notes → Note navigation on phones
- Local SQLite storage, migrations, full-text search, recency sorting, categories, and 30-day Trash
- Markdown-native CodeMirror editor with autosave, keyboard undo/redo and find, plus Write, Preview, and desktop Split modes
- Interactive Preview checklists that update ordinary `- [ ]` / `- [x]` Markdown
- Markdown headings, lists, links, code, tables, blockquotes, inline image previews, and a compact formatting aid
- Inline image insertion for PNG, JPEG, GIF, and WebP (up to 4 MB); images live directly in the Markdown as portable data URLs
- Complete-notebook ZIP export, arranged by category with readable Markdown and YAML metadata

## Run it

```sh
npm install
npm run tauri dev
```

To package a native macOS app:

```sh
npx tauri build --bundles app
```

The resulting app is written to `src-tauri/target/release/bundle/macos/Papyrus.app`.

## Privacy and scope

No account or remote service is involved: the live notebook is a SQLite database in the application data directory, and Markdown export is always available.

Encrypted device pairing and relay synchronization are deliberately not presented as complete; the database already records immutable revisions and deletion tombstones so that sync can be added without replacing the local notebook model. Native PDF rendering, file import, and continuing note-sharing are the next portability milestones.
