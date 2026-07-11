import { invoke } from "@tauri-apps/api/core";
import type { Category, Note, NoteListItem, SavePayload } from "../types";
import { newId } from "./ids";
import { plainPreview } from "./format";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const storageKey = "papyrus-browser-notebook-v1";
const preferencesKey = "papyrus-browser-preferences-v1";
type BrowserStore = { notes: Note[]; categories: Category[] };

function now() { return new Date().toISOString(); }
function readBrowserStore(): BrowserStore {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return { notes: [], categories: [] };
  try { return JSON.parse(raw) as BrowserStore; } catch { return { notes: [], categories: [] }; }
}
function writeBrowserStore(store: BrowserStore) { localStorage.setItem(storageKey, JSON.stringify(store)); }
function readPreferences(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(preferencesKey) || "{}") as Record<string, string>; } catch { return {}; }
}
function item(note: Note, categories: Category[]): NoteListItem {
  const category = categories.find((candidate) => candidate.id === note.categoryId);
  const { body: _body, ...listItem } = note;
  return { ...listItem, categoryName: category?.name ?? null, preview: plainPreview(note.body) };
}
function noteWithCategory(note: Note, categories: Category[]): Note {
  const category = categories.find((candidate) => candidate.id === note.categoryId);
  return { ...note, categoryName: category?.name ?? null };
}

export const api = {
  async initialize() {
    if (isTauri) return invoke<void>("initialize_database");
  },
  async listCategories(): Promise<Category[]> {
    if (isTauri) return invoke<Category[]>("list_categories");
    return readBrowserStore().categories.sort((a, b) => a.position - b.position);
  },
  async createCategory(name: string): Promise<Category> {
    if (isTauri) return invoke<Category>("create_category", { name });
    const store = readBrowserStore(); const timestamp = now();
    const category = { id: newId(), name: name.trim(), position: store.categories.length, createdAt: timestamp, updatedAt: timestamp };
    store.categories.push(category); writeBrowserStore(store); return category;
  },
  async listNotes(filter: "all" | "trash" | string = "all", search = ""): Promise<NoteListItem[]> {
    if (isTauri) return invoke<NoteListItem[]>("list_notes", { filter, search });
    const store = readBrowserStore();
    const needle = search.trim().toLocaleLowerCase();
    return store.notes
      .filter((note) => filter === "trash" ? Boolean(note.deletedAt) : filter === "all" ? !note.deletedAt : !note.deletedAt && note.categoryId === filter)
      .filter((note) => !needle || `${note.title} ${note.body} ${store.categories.find((c) => c.id === note.categoryId)?.name ?? ""}`.toLocaleLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((note) => item(note, store.categories));
  },
  async getNote(id: string): Promise<Note | null> {
    if (isTauri) return invoke<Note | null>("get_note", { id });
    const store = readBrowserStore(); const note = store.notes.find((candidate) => candidate.id === id);
    return note ? noteWithCategory(note, store.categories) : null;
  },
  async saveNote(payload: SavePayload): Promise<Note> {
    if (isTauri) return invoke<Note>("save_note", { note: payload });
    const store = readBrowserStore(); const timestamp = now(); const old = store.notes.find((candidate) => candidate.id === payload.id);
    const next: Note = {
      id: payload.id, title: payload.title, body: payload.body, categoryId: payload.categoryId,
      createdAt: old?.createdAt ?? timestamp, updatedAt: timestamp, deletedAt: old?.deletedAt ?? null, revisionId: newId(),
    };
    if (old) Object.assign(old, next); else store.notes.push(next);
    writeBrowserStore(store); return noteWithCategory(next, store.categories);
  },
  async moveNote(id: string, categoryId: string | null): Promise<void> {
    if (isTauri) return invoke<void>("move_note", { id, categoryId });
    const store = readBrowserStore(); const note = store.notes.find((candidate) => candidate.id === id);
    if (note) { note.categoryId = categoryId; note.updatedAt = now(); writeBrowserStore(store); }
  },
  async trashNote(id: string): Promise<void> {
    if (isTauri) return invoke<void>("trash_note", { id });
    const store = readBrowserStore(); const note = store.notes.find((candidate) => candidate.id === id);
    if (note) { note.deletedAt = now(); note.updatedAt = now(); writeBrowserStore(store); }
  },
  async restoreNote(id: string): Promise<void> {
    if (isTauri) return invoke<void>("restore_note", { id });
    const store = readBrowserStore(); const note = store.notes.find((candidate) => candidate.id === id);
    if (note) { note.deletedAt = null; note.updatedAt = now(); writeBrowserStore(store); }
  },
  async deleteNote(id: string): Promise<void> {
    if (isTauri) return invoke<void>("delete_note_permanently", { id });
    const store = readBrowserStore(); store.notes = store.notes.filter((note) => note.id !== id); writeBrowserStore(store);
  },
  async emptyTrash(): Promise<void> {
    if (isTauri) return invoke<void>("empty_trash");
    const store = readBrowserStore(); store.notes = store.notes.filter((note) => !note.deletedAt); writeBrowserStore(store);
  },
  async duplicateNote(id: string): Promise<Note> {
    if (isTauri) return invoke<Note>("duplicate_note", { id });
    const source = await this.getNote(id); if (!source) throw new Error("Note not found");
    return this.saveNote({ id: newId(), title: `${source.title || "Untitled note"} copy`, body: source.body, categoryId: source.categoryId });
  },
  async exportNotebook(destination: string): Promise<void> {
    if (!isTauri) throw new Error("Notebook export is available in the desktop app.");
    return invoke<void>("export_notebook", { destination });
  },
  async embedImage(path: string): Promise<string> {
    if (!isTauri) throw new Error("Choose an image from the installed Papyrus app.");
    return invoke<string>("embed_image", { path });
  },
  async getSetting(key: string): Promise<string | null> {
    if (isTauri) return invoke<string | null>("get_setting", { key });
    return readPreferences()[key] || null;
  },
  async setSetting(key: string, value: string): Promise<void> {
    if (isTauri) return invoke<void>("set_setting", { key, value });
    const preferences = readPreferences(); preferences[key] = value;
    localStorage.setItem(preferencesKey, JSON.stringify(preferences));
  },
};
