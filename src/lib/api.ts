import { invoke } from "@tauri-apps/api/core";
import type { Category, Note, NoteConflict, NoteListItem, PairingOffer, PairingProgress, SavePayload, SyncStatus } from "../types";
import { newId } from "./ids";
import { previewFromMarkdown, titleFromMarkdown } from "./format";

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
  return { ...listItem, title: titleFromMarkdown(note.body) || note.title, categoryName: category?.name ?? null, preview: previewFromMarkdown(note.body) };
}
function noteWithCategory(note: Note, categories: Category[]): Note {
  const category = categories.find((candidate) => candidate.id === note.categoryId);
  return { ...note, categoryName: category?.name ?? null };
}

export const api = {
  isNativeApp() { return isTauri; },
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
  async renameCategory(id: string, name: string): Promise<Category> {
    if (isTauri) return invoke<Category>("rename_category", { id, name });
    const store = readBrowserStore(); const category = store.categories.find((candidate) => candidate.id === id);
    if (!category) throw new Error("Folder not found"); category.name = name.trim(); category.updatedAt = now(); writeBrowserStore(store); return category;
  },
  async moveCategory(id: string, direction: -1 | 1): Promise<Category[]> {
    if (isTauri) return invoke<Category[]>("move_category", { id, direction });
    const store = readBrowserStore(); const ordered = store.categories.sort((a, b) => a.position - b.position); const index = ordered.findIndex((candidate) => candidate.id === id); const target = index + direction;
    if (index >= 0 && target >= 0 && target < ordered.length) { [ordered[index].position, ordered[target].position] = [ordered[target].position, ordered[index].position]; writeBrowserStore(store); }
    return ordered.sort((a, b) => a.position - b.position);
  },
  async deleteCategory(id: string): Promise<void> {
    if (isTauri) return invoke<void>("delete_category", { id });
    const store = readBrowserStore(); store.categories = store.categories.filter((candidate) => candidate.id !== id); for (const note of store.notes) if (note.categoryId === id) note.categoryId = null; writeBrowserStore(store);
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
  async getNoteConflict(id: string): Promise<NoteConflict | null> {
    if (isTauri) return invoke<NoteConflict | null>("get_note_conflict", { id });
    return null;
  },
  async resolveNoteConflict(id: string, resolution: "current" | "other" | "both"): Promise<Note> {
    if (isTauri) return invoke<Note>("resolve_note_conflict", { id, resolution });
    throw new Error("Sync conflict review is available in the installed Papyrus app.");
  },
  async saveNote(payload: SavePayload): Promise<Note> {
    if (isTauri) return invoke<Note>("save_note", { note: payload });
    const store = readBrowserStore(); const timestamp = now(); const old = store.notes.find((candidate) => candidate.id === payload.id);
    const title = titleFromMarkdown(payload.body) || payload.title;
    const next: Note = {
      id: payload.id, title, body: payload.body, categoryId: payload.categoryId,
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
  async getSyncStatus(): Promise<SyncStatus> {
    if (isTauri) return invoke<SyncStatus>("get_sync_status");
    return { status: "Offline", lastSuccessfulSync: null, pendingOutgoingChanges: 0, devices: [], localDeviceName: "This browser", attentionMessage: "Install Papyrus to use encrypted device sync.", openConflicts: 0 };
  },
  async syncNow(): Promise<SyncStatus> {
    if (isTauri) return invoke<SyncStatus>("sync_now");
    return this.getSyncStatus();
  },
  async renameSyncDevice(name: string): Promise<SyncStatus> {
    if (isTauri) return invoke<SyncStatus>("rename_sync_device", { name });
    throw new Error("Device sync is available in the installed Papyrus app.");
  },
  async removeSyncDevice(deviceId: string): Promise<SyncStatus> {
    if (isTauri) return invoke<SyncStatus>("remove_sync_device", { deviceId });
    throw new Error("Device sync is available in the installed Papyrus app.");
  },
  async startPairing(): Promise<PairingOffer> {
    if (isTauri) return invoke<PairingOffer>("start_pairing");
    throw new Error("Device pairing is available in the installed Papyrus app.");
  },
  async acceptPairing(code: string): Promise<PairingProgress> {
    if (isTauri) return invoke<PairingProgress>("accept_pairing", { code });
    throw new Error("Device pairing is available in the installed Papyrus app.");
  },
  async completePairing(code: string): Promise<PairingProgress> {
    if (isTauri) return invoke<PairingProgress>("complete_pairing", { code });
    throw new Error("Device pairing is available in the installed Papyrus app.");
  },
  async finishPairing(code: string): Promise<PairingProgress> {
    if (isTauri) return invoke<PairingProgress>("finish_pairing", { code });
    throw new Error("Device pairing is available in the installed Papyrus app.");
  },
};
