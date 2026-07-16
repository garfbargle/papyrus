import { invoke as invokeCommand } from "@tauri-apps/api/core";
import type { Category, Note, NoteConflict, NoteListItem, PairingOffer, PairingProgress, SavePayload, SyncStatus } from "../types";
import * as webSync from "./sync";

// Tauri commands reject with a bare string, because the native error type is
// `Result<T, String>`. Callers test `error instanceof Error` and fall back to a
// generic message when it fails, which silently discards every message the
// native side wrote. Rewrap so the real reason survives the boundary.
function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invokeCommand<T>(command, args).catch((error: unknown) => {
    if (error instanceof Error) throw error;
    throw new Error(typeof error === "string" ? error : JSON.stringify(error));
  });
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const preferencesKey = "papyrus-browser-preferences-v1";

function readPreferences(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(preferencesKey) || "{}") as Record<string, string>; } catch { return {}; }
}

// In the browser, sync/crypto/notebook all run locally through the web sync
// stack (src/lib/sync). In the native app, everything is a Tauri command.
export const api = {
  isNativeApp() { return isTauri; },
  async initialize() {
    if (isTauri) return invoke<void>("initialize_database");
    return webSync.initialize();
  },
  async listCategories(): Promise<Category[]> {
    if (isTauri) return invoke<Category[]>("list_categories");
    return webSync.notebook.listCategories();
  },
  async createCategory(name: string): Promise<Category> {
    if (isTauri) return invoke<Category>("create_category", { name });
    return webSync.notebook.createCategory(name);
  },
  async renameCategory(id: string, name: string): Promise<Category> {
    if (isTauri) return invoke<Category>("rename_category", { id, name });
    return webSync.notebook.renameCategory(id, name);
  },
  async moveCategory(id: string, direction: -1 | 1): Promise<Category[]> {
    if (isTauri) return invoke<Category[]>("move_category", { id, direction });
    return webSync.notebook.moveCategory(id, direction);
  },
  async deleteCategory(id: string): Promise<void> {
    if (isTauri) return invoke<void>("delete_category", { id });
    return webSync.notebook.deleteCategory(id);
  },
  async listNotes(filter: "all" | "trash" | string = "all", search = ""): Promise<NoteListItem[]> {
    if (isTauri) return invoke<NoteListItem[]>("list_notes", { filter, search });
    return webSync.notebook.listNotes(filter, search);
  },
  async getNote(id: string): Promise<Note | null> {
    if (isTauri) return invoke<Note | null>("get_note", { id });
    return webSync.notebook.getNote(id);
  },
  async getNoteConflict(id: string): Promise<NoteConflict | null> {
    if (isTauri) return invoke<NoteConflict | null>("get_note_conflict", { id });
    return webSync.notebook.getNoteConflict(id);
  },
  async resolveNoteConflict(id: string, resolution: "current" | "other" | "both"): Promise<Note> {
    if (isTauri) return invoke<Note>("resolve_note_conflict", { id, resolution });
    return webSync.notebook.resolveNoteConflict(id, resolution);
  },
  async saveNote(payload: SavePayload): Promise<Note> {
    if (isTauri) return invoke<Note>("save_note", { note: payload });
    return webSync.notebook.saveNote(payload);
  },
  async moveNote(id: string, categoryId: string | null): Promise<void> {
    if (isTauri) return invoke<void>("move_note", { id, categoryId });
    return webSync.notebook.moveNote(id, categoryId);
  },
  async trashNote(id: string): Promise<void> {
    if (isTauri) return invoke<void>("trash_note", { id });
    return webSync.notebook.trashNote(id);
  },
  async restoreNote(id: string): Promise<void> {
    if (isTauri) return invoke<void>("restore_note", { id });
    return webSync.notebook.restoreNote(id);
  },
  async deleteNote(id: string): Promise<void> {
    if (isTauri) return invoke<void>("delete_note_permanently", { id });
    return webSync.notebook.deleteNote(id);
  },
  async emptyTrash(): Promise<void> {
    if (isTauri) return invoke<void>("empty_trash");
    return webSync.notebook.emptyTrash();
  },
  async duplicateNote(id: string): Promise<Note> {
    if (isTauri) return invoke<Note>("duplicate_note", { id });
    return webSync.notebook.duplicateNote(id);
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
    return webSync.getSyncStatus();
  },
  async syncNow(): Promise<SyncStatus> {
    if (isTauri) return invoke<SyncStatus>("sync_now");
    return webSync.syncNow();
  },
  async renameSyncDevice(name: string): Promise<SyncStatus> {
    if (isTauri) return invoke<SyncStatus>("rename_sync_device", { name });
    return webSync.renameSyncDevice(name);
  },
  async removeSyncDevice(deviceId: string): Promise<SyncStatus> {
    if (isTauri) return invoke<SyncStatus>("remove_sync_device", { deviceId });
    return webSync.removeSyncDevice(deviceId);
  },
  async startPairing(): Promise<PairingOffer> {
    if (isTauri) return invoke<PairingOffer>("start_pairing");
    return webSync.startPairing();
  },
  async acceptPairing(code: string): Promise<PairingProgress> {
    if (isTauri) return invoke<PairingProgress>("accept_pairing", { code });
    return webSync.acceptPairing(code);
  },
  async completePairing(code: string): Promise<PairingProgress> {
    if (isTauri) return invoke<PairingProgress>("complete_pairing", { code });
    return webSync.completePairing(code);
  },
  async finishPairing(code: string): Promise<PairingProgress> {
    if (isTauri) return invoke<PairingProgress>("finish_pairing", { code });
    return webSync.finishPairing(code);
  },
};
