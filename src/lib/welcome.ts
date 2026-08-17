// The tour a brand-new notebook opens with, on every platform: the browser at
// notes.c0di.com, the desktop app, and mobile all seed it through `api`, so the
// content lives here rather than in the Rust or web store.
//
// These are ordinary notes. They can be edited, moved, trashed, and exported like
// anything else, and they are never re-created once this device has seeded them.

import { api } from "./api";
import { titleFromMarkdown } from "./format";
import { themeSwatchesImage } from "./welcome-image";

const SEEDED_SETTING = "welcomeNotesSeeded";

// Fixed ids rather than fresh UUIDs, because a device seeds the tour before it
// knows whether it will later pair with a notebook that already has one. Pairing
// merges this device's notes into the adopted vault and skips ids already present
// there (`replayNotebook` in lib/sync/store.ts, `replay_notebook` in
// src-tauri/src/lib.rs), so a shared id collapses the two copies into one.
const WELCOME_ID = "cc51fdc5-b64f-4be5-a886-946d6674dd4c";
const MARKDOWN_ID = "e11b0c3f-ef3c-4d24-900e-133c7393732c";
const PRIVACY_ID = "bd76f343-f45d-4402-be68-ae511a1e9784";

// Newest first, the way the notes list shows them.
export const welcomeNotes: { id: string; body: string }[] = [
  {
    id: WELCOME_ID,
    body: `# Welcome to Pad

A quiet place for every thought. These three notes are a short tour of what's here. They're ordinary notes — edit them, file them, or send them to Trash when you're done.

## The short version

- Everything you write lives in a **local database on this device**. Editing never waits for the network, and there is no account to make.
- Notes are **plain Markdown**. Type \`## \` or \`- [ ] \` and it becomes one as you go.
- **Sync is optional and end-to-end encrypted.** Pair a second device with a QR code from Settings.

## Try it now

- [ ] Tick this box — it's a real \`- [ ]\` in the Markdown underneath
- [ ] Press ⌘N for a new note, ⌘K to search
- [ ] Right-click this page for headings, lists, links, and images
- [ ] Open Settings and try one of these seven themes

![The seven Pad themes: Pad, Mist, Graphite, Nord, Solarized, Dracula, and Gruvbox](${themeSwatchesImage})

That strip is an image living *inside this note*, not a file sitting next to it. Every image you paste, drop, or add is embedded as a data URL, so a note stays one self-contained piece of Markdown — it syncs, exports, and travels in one piece.
`,
  },
  {
    id: MARKDOWN_ID,
    body: `# Markdown, without the ceremony

No toolbars to hunt. No blocks to summon. You type, and the page keeps up.

## Shortcuts that promote as you type

| Type this | And the line becomes |
| --- | --- |
| \`# \` \`## \` \`### \` | A heading |
| \`- \` | A bullet |
| \`1. \` | A numbered list |
| \`- [ ] \` | A checklist item |

Checklists behave the way you'd hope: Enter continues the list, the caret lands where you left it, and ticking a box writes \`- [x]\` straight into the Markdown.

- [x] Something already done
- [ ] Something still waiting

> Right-click anywhere on the page for headings, lists, links, code, and images.

## When you want to see the machinery

Every note is canonical Markdown underneath. Open the **⋯** menu and choose *Edit Markdown source* to work in the raw text — this note, exactly as stored:

\`\`\`markdown
## Shortcuts that promote as you type
- [ ] A checklist item
![An image](data:image/png;base64,…)
\`\`\`

## Keeping things findable

Folders live in the sidebar under **Folders** — drag notes between them, reorder them, rename them. Search is full-text and instant (⌘K), because it's reading a database on this device rather than asking a server.

Deleted notes rest in **Trash** for 30 days before they go for good.
`,
  },
  {
    id: PRIVACY_ID,
    body: `# Your notes, your keys

Pad is local-first by conviction, not by marketing.

## What that means in practice

- Every device keeps a **complete copy** of your notebook. The app works with the Wi-Fi off.
- Notes are encrypted **on this device** before anything touches the network.
- Private keys live in your OS keychain. The sync relay only ever sees ciphertext and routing ids — not your note titles, not your folder names, not a thing.

## Turning on sync

Settings → **Sync** shows a QR code. Scan it from your other device and the two exchange keys directly; the relay just carries sealed envelopes between them.

When the same note changes in two places at once, nothing is overwritten. Pad shows you both versions and asks: **Keep Current**, **Keep Other**, or **Keep Both**.

## Leaving, whenever you like

Settings → **Export Markdown** hands you a ZIP of readable Markdown, organized by folder, images and all. It's designed to be leaveable — which is, paradoxically, why it's worth staying.
`,
  },
];

type WelcomeNotebook = Pick<typeof api, "getSetting" | "setSetting" | "listNotes" | "saveNote">;

// Seed the tour into a first-run notebook. Returns the note to open, or null when
// this device has already seeded (or has notes of its own and never needed to).
export async function seedWelcomeNotes(notebook: WelcomeNotebook = api): Promise<string | null> {
  if (await notebook.getSetting(SEEDED_SETTING)) return null;

  // Existing notebooks predate the tour and must not have notes appear in them;
  // marking them seeded means this check runs once, not on every launch. Trash
  // counts as content — a notebook emptied on purpose is not a fresh one.
  const [notes, trashed] = await Promise.all([notebook.listNotes("all"), notebook.listNotes("trash")]);
  if (notes.length || trashed.length) {
    await notebook.setSetting(SEEDED_SETTING, "1");
    return null;
  }

  // The list sorts on `updatedAt`, so write these back-to-front: the last one
  // saved is the one that lands at the top.
  for (const note of [...welcomeNotes].reverse()) {
    await notebook.saveNote({ id: note.id, title: titleFromMarkdown(note.body), body: note.body, categoryId: null });
  }
  await notebook.setSetting(SEEDED_SETTING, "1");
  return welcomeNotes[0].id;
}
