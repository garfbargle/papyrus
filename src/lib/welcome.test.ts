import { describe, expect, it } from "vitest";
import type { NoteListItem, SavePayload } from "../types";
import { titleFromMarkdown } from "./format";
import { seedWelcomeNotes, welcomeNotes } from "./welcome";

// A notebook stub standing in for `api`: enough of it for the seeder, and it
// records what got written so the tests can assert on order.
function fakeNotebook(existing: { notes?: number; trashed?: number } = {}) {
  const settings = new Map<string, string>();
  const saved: SavePayload[] = [];
  const rows = (count = 0) => Array.from({ length: count }, (_, index) => ({ id: `existing-${index}` }) as NoteListItem);
  return {
    saved,
    settings,
    async getSetting(key: string) { return settings.get(key) ?? null; },
    async setSetting(key: string, value: string) { settings.set(key, value); },
    async listNotes(filter = "all") { return rows(filter === "trash" ? existing.trashed : existing.notes); },
    async saveNote(payload: SavePayload) { saved.push(payload); return payload as never; },
  };
}

describe("seedWelcomeNotes", () => {
  it("seeds the tour into an empty notebook and opens its first note", async () => {
    const notebook = fakeNotebook();
    const opened = await seedWelcomeNotes(notebook);

    expect(notebook.saved).toHaveLength(welcomeNotes.length);
    expect(opened).toBe(welcomeNotes[0].id);
    expect(notebook.settings.get("welcomeNotesSeeded")).toBe("1");
  });

  it("saves back-to-front so the welcome note is the most recently updated", async () => {
    const notebook = fakeNotebook();
    await seedWelcomeNotes(notebook);

    expect(notebook.saved.map((note) => note.id)).toEqual([...welcomeNotes].reverse().map((note) => note.id));
  });

  it("gives each seeded note the title its Markdown implies", async () => {
    const notebook = fakeNotebook();
    await seedWelcomeNotes(notebook);

    expect(notebook.saved.map((note) => note.title)).toEqual(
      [...welcomeNotes].reverse().map((note) => titleFromMarkdown(note.body)),
    );
    expect(notebook.saved.every((note) => note.title.length > 0)).toBe(true);
  });

  it("never seeds a second time on the same device", async () => {
    const notebook = fakeNotebook();
    await seedWelcomeNotes(notebook);
    notebook.saved.length = 0;

    expect(await seedWelcomeNotes(notebook)).toBeNull();
    expect(notebook.saved).toHaveLength(0);
  });

  it("leaves an existing notebook alone, and stops checking it", async () => {
    const notebook = fakeNotebook({ notes: 3 });

    expect(await seedWelcomeNotes(notebook)).toBeNull();
    expect(notebook.saved).toHaveLength(0);
    expect(notebook.settings.get("welcomeNotesSeeded")).toBe("1");
  });

  it("treats a notebook whose only notes are in Trash as already used", async () => {
    const notebook = fakeNotebook({ trashed: 1 });

    expect(await seedWelcomeNotes(notebook)).toBeNull();
    expect(notebook.saved).toHaveLength(0);
  });

  it("embeds an image the note bodies can carry anywhere", async () => {
    const bodies = welcomeNotes.map((note) => note.body).join("\n");
    const embedded = bodies.match(/!\[[^\]]+\]\((data:image\/png;base64,[A-Za-z0-9+/=]+)\)/);

    expect(embedded).not.toBeNull();
    expect(embedded?.[1].length).toBeGreaterThan(1000);
  });
});
