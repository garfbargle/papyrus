import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Icon } from "./components/Icon";
import PaperEditor from "./components/PaperEditor";
import SyncSettings from "./components/SyncSettings";
import { api } from "./lib/api";
import { newId } from "./lib/ids";
import { readImageFile } from "./lib/images";
import { noteTitle, relativeTime, titleFromMarkdown } from "./lib/format";
import { seedWelcomeNotes } from "./lib/welcome";
import type { Category, Note, NoteConflict, NoteListItem, SyncStatus } from "./types";

type NoteView = "notes" | "trash";
type ListMode = "all" | "folders";
type MobileScreen = "list" | "note";
type ThemeId = "papyrus" | "mist" | "graphite" | "nord" | "solarized" | "dracula" | "gruvbox";
type FontId = "inter" | "manrope" | "dm-sans";

const MarkdownEditor = lazy(() => import("./components/MarkdownEditor"));

const themes: { id: ThemeId; name: string; description: string; colors: [string, string, string] }[] = [
  { id: "papyrus", name: "Papyrus", description: "Warm parchment and sepia", colors: ["#f9f2e6", "#f4ecdc", "#9d6d38"] },
  { id: "mist", name: "Mist", description: "Cool grey and white", colors: ["#f6f7f9", "#eef1f5", "#5d6a7d"] },
  { id: "graphite", name: "Graphite", description: "Near-black night mode", colors: ["#191a1d", "#22242a", "#c7d0de"] },
  { id: "nord", name: "Nord", description: "Calm blue-grey", colors: ["#eceff4", "#e5e9f0", "#5e81ac"] },
  { id: "solarized", name: "Solarized", description: "Warm, low contrast", colors: ["#fdf6e3", "#eee8d5", "#268bd2"] },
  { id: "dracula", name: "Dracula", description: "Classic violet dark", colors: ["#282a36", "#343746", "#bd93f9"] },
  { id: "gruvbox", name: "Gruvbox", description: "Soft amber dark", colors: ["#282828", "#3c3836", "#fabd2f"] },
];

const fonts: { id: FontId; name: string; description: string }[] = [
  { id: "inter", name: "Inter", description: "Crisp and quietly neutral" },
  { id: "manrope", name: "Manrope", description: "Soft, open, and modern" },
  { id: "dm-sans", name: "DM Sans", description: "Friendly with a little character" },
];

const freshNote = (): Note => ({
  id: newId(), title: "", body: "", categoryId: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, revisionId: newId(),
});

function placeLegacyTitleInBody(note: Note) {
  const storedTitle = note.title.trim();
  if (!storedTitle || titleFromMarkdown(note.body) === storedTitle) return note;
  const heading = `# ${storedTitle}`;
  return { ...note, body: note.body.trim() ? `${heading}\n\n${note.body}` : heading };
}

function App() {
  // Embed hosts can open straight into a blank composer with ?new=1. The note
  // remains local-only until it has content, just like clicking “New note”.
  const forceNewNote = new URLSearchParams(window.location.search).get("new") === "1";
  const initialDraft = useRef<Note | null>(forceNewNote ? freshNote() : null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [view, setView] = useState<NoteView>("notes");
  const [mode, setMode] = useState<ListMode>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activeFolderId, setActiveFolderId] = useState<string | null>(null);
  const [noteMenu, setNoteMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [current, setCurrent] = useState<Note | null>(() => initialDraft.current);
  const [sourceMode, setSourceMode] = useState(false);
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>(forceNewNote ? "note" : "list");
  const [loading, setLoading] = useState(true);
  const [newCategory, setNewCategory] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryMenu, setCategoryMenu] = useState<string | null>(null);
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null);
  const [renameCategoryName, setRenameCategoryName] = useState("");
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [moveMenu, setMoveMenu] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeId>("papyrus");
  const [font, setFont] = useState<FontId>("inter");
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [noteConflict, setNoteConflict] = useState<NoteConflict | null>(null);
  const [reviewConflict, setReviewConflict] = useState(false);
  const editor = useRef<EditorView | null>(null);
  const pendingSaveTimers = useRef(new Map<string, number>());
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const dirtyDrafts = useRef(new Map<string, Note>());
  const pendingSync = useRef<number | null>(null);
  const syncInFlight = useRef(false);
  const syncQueued = useRef(false);
  const openRequest = useRef(0);
  // Auto-sync only matters once this device is paired with at least one other —
  // a cycle with no peers is a pure no-op. Mirror that into a ref so the timers
  // and event listeners can read it without being torn down on every status tick.
  const autoSyncEnabled = useRef(false);
  const currentRef = useRef<Note | null>(initialDraft.current);
  // New notes are rendered before they exist in storage. Keep refreshes from
  // treating that short-lived, local-only state as a deleted note.
  const unsavedNoteIds = useRef(new Set(initialDraft.current ? [initialDraft.current.id] : []));

  const filter = view === "trash" ? "trash" : "all";
  const searching = search.trim().length > 0;
  const uncategorized = useMemo(() => notes.filter((note) => !note.categoryId), [notes]);

  const loadNotes = useCallback(async (place = filter, query = search) => {
    const list = await api.listNotes(place, query);
    setNotes(list);
  }, [filter, search]);

  const refreshNotebook = useCallback(async () => {
    const [loadedCategories, loadedNotes] = await Promise.all([api.listCategories(), api.listNotes(filter, search)]);
    setCategories(loadedCategories); setNotes(loadedNotes);
    const openId = currentRef.current?.id;
    if (openId) {
      const [refreshed, conflict] = await Promise.all([api.getNote(openId), api.getNoteConflict(openId)]);
      // The user may have opened another note while the reads were in flight. Never
      // let a slow refresh from the old note replace the new editor state.
      if (currentRef.current?.id !== openId) return;
      setNoteConflict(conflict);
      // A local draft remains authoritative until its save finishes — even if a
      // concurrent sync temporarily reports the stored note as missing.
      if (dirtyDrafts.current.has(openId)) return;
      if (refreshed) {
        const documentNote = placeLegacyTitleInBody(refreshed);
        currentRef.current = documentNote; setCurrent(documentNote);
      } else if (!unsavedNoteIds.current.has(openId)) {
        currentRef.current = null; setCurrent(null); setNoteConflict(null); setReviewConflict(false);
      }
    }
  }, [filter, search]);

  // A sync cycle pushes and pulls in one pass, so overlapping runs would double-
  // drain the outbox. Serialize them: if one is in flight, remember that another
  // was asked for and run exactly once more when it finishes (so the latest local
  // change is never left behind).
  const runSync = useCallback(async () => {
    if (syncInFlight.current) { syncQueued.current = true; return; }
    syncInFlight.current = true;
    setSyncStatus((status) => status ? { ...status, status: "Syncing" } : status);
    try { const next = await api.syncNow(); setSyncStatus(next); await refreshNotebook(); }
    catch { try { setSyncStatus(await api.getSyncStatus()); } catch { /* editing remains local */ } }
    finally {
      syncInFlight.current = false;
      if (syncQueued.current) { syncQueued.current = false; void runSync(); }
    }
  }, [refreshNotebook]);

  // Coalesce a burst of edits into one push: sync ~15s after the last change.
  // The foreground poll below is the safety net while editing continuously.
  const scheduleSync = useCallback(() => {
    if (!autoSyncEnabled.current) return;
    if (pendingSync.current) window.clearTimeout(pendingSync.current);
    pendingSync.current = window.setTimeout(() => { pendingSync.current = null; void runSync(); }, 15 * 1000);
  }, [runSync]);

  useEffect(() => {
    (async () => {
      try {
        await api.initialize();
        // A first-run notebook gets the welcome tour, opened to its first note.
        // It is a nicety, so a notebook that opens fine but cannot be seeded is
        // still a notebook: fall through to the usual empty state.
        const welcomeNoteId = await seedWelcomeNotes().catch(() => null);
        const [loadedCategories, loadedNotes, savedTheme, savedFont, savedMode, loadedSyncStatus] = await Promise.all([api.listCategories(), api.listNotes("all"), api.getSetting("theme"), api.getSetting("font"), api.getSetting("listMode"), api.getSyncStatus()]);
        setCategories(loadedCategories); setNotes(loadedNotes);
        setSyncStatus(loadedSyncStatus);
        if (themes.some((item) => item.id === savedTheme)) setTheme(savedTheme as ThemeId);
        if (fonts.some((item) => item.id === savedFont)) setFont(savedFont as FontId);
        if (savedMode === "all" || savedMode === "folders") setMode(savedMode);
        if (!forceNewNote && welcomeNoteId) await openNote(welcomeNoteId);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Papyrus could not open the notebook.");
      } finally { setLoading(false); }
    })();
  }, []);

  // Keep the auto-sync gate in sync with the device list without re-arming the
  // timers below (which depend only on `loading`).
  useEffect(() => { autoSyncEnabled.current = (syncStatus?.devices.length ?? 0) > 1; }, [syncStatus]);

  useEffect(() => {
    if (loading) return;
    const trigger = () => { if (autoSyncEnabled.current && document.visibilityState === "visible") void runSync(); };
    const interval = window.setInterval(trigger, 60 * 1000);
    document.addEventListener("visibilitychange", trigger); window.addEventListener("focus", trigger); window.addEventListener("online", trigger);
    const launch = window.setTimeout(trigger, 500);
    return () => { window.clearInterval(interval); window.clearTimeout(launch); document.removeEventListener("visibilitychange", trigger); window.removeEventListener("focus", trigger); window.removeEventListener("online", trigger); };
  }, [loading, runSync]);

  useEffect(() => {
    if (loading) return;
    const id = window.setTimeout(() => { void loadNotes(); }, search ? 120 : 0);
    return () => window.clearTimeout(id);
  }, [view, search, loading, loadNotes]);

  useEffect(() => () => {
    for (const timer of pendingSaveTimers.current.values()) window.clearTimeout(timer);
    pendingSaveTimers.current.clear();
    if (pendingSync.current) window.clearTimeout(pendingSync.current);
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { document.documentElement.dataset.font = font; }, [font]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".search input")?.focus();
      }
      if (event.key.toLowerCase() === "n") { event.preventDefault(); createNote(); }
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  });

  useEffect(() => {
    if (!categoryMenu && !noteMenu && !overflow) return;
    const dismiss = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".pop-menu, .folder-more, .menu-wrap")) return;
      setCategoryMenu(null); setNoteMenu(null); setOverflow(false); setMoveMenu(false);
    };
    window.addEventListener("mousedown", dismiss);
    return () => window.removeEventListener("mousedown", dismiss);
  }, [categoryMenu, noteMenu, overflow]);

  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (deletingCategory) { setDeletingCategory(null); return; }
      setCategoryMenu(null); setNoteMenu(null); setOverflow(false); setMoveMenu(false);
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [deletingCategory]);

  // Save operations are serialized. Besides avoiding revision-parent races in the
  // local store, this makes their completion order deterministic. Most importantly,
  // an older save may update storage metadata but can never replace a newer draft in
  // React state — the body/category must still match the snapshot that was saved.
  const persist = useCallback((note: Note): Promise<boolean> => {
    if (!note.body.trim() && unsavedNoteIds.current.has(note.id)) {
      dirtyDrafts.current.delete(note.id);
      return Promise.resolve(true);
    }
    const task = saveChain.current.then(async () => {
      const title = titleFromMarkdown(note.body);
      try {
        const saved = await api.saveNote({ id: note.id, title, body: note.body, categoryId: note.categoryId });
        unsavedNoteIds.current.delete(note.id);
        const latestDraft = dirtyDrafts.current.get(note.id);
        if (latestDraft?.body === note.body && latestDraft.categoryId === note.categoryId) dirtyDrafts.current.delete(note.id);
        const openNote = currentRef.current;
        if (openNote?.id === note.id && openNote.body === note.body && openNote.categoryId === note.categoryId) {
          const combined = { ...openNote, ...saved, title, body: openNote.body, categoryId: openNote.categoryId };
          currentRef.current = combined; setCurrent(combined);
        }
        window.setTimeout(() => { void loadNotes(); }, 350);
        scheduleSync();
        return true;
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Could not save this note.");
        return false;
      }
    });
    saveChain.current = task.then(() => undefined);
    return task;
  }, [loadNotes, scheduleSync]);

  const clearPendingSave = (id: string, discardDraft = false) => {
    const timer = pendingSaveTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    pendingSaveTimers.current.delete(id);
    if (discardDraft) dirtyDrafts.current.delete(id);
  };

  const schedulePersist = (note: Note) => {
    dirtyDrafts.current.set(note.id, note);
    clearPendingSave(note.id);
    const timer = window.setTimeout(() => {
      pendingSaveTimers.current.delete(note.id);
      const latest = dirtyDrafts.current.get(note.id);
      if (latest) void persist(latest);
    }, 480);
    pendingSaveTimers.current.set(note.id, timer);
  };

  const flushPersist = async (id: string) => {
    clearPendingSave(id);
    const latest = dirtyDrafts.current.get(id);
    if (!latest) return true;
    const saved = await persist(latest);
    if (!saved && dirtyDrafts.current.has(id)) schedulePersist(dirtyDrafts.current.get(id)!);
    return saved;
  };

  const changeCurrent = (change: Partial<Pick<Note, "body" | "categoryId">>) => {
    const existing = currentRef.current; if (!existing || existing.deletedAt) return;
    const body = change.body ?? existing.body;
    const next = { ...existing, ...change, body, title: titleFromMarkdown(body), updatedAt: new Date().toISOString() };
    currentRef.current = next; setCurrent(next); schedulePersist(next);
  };

  const openNote = async (id: string) => {
    const request = ++openRequest.current;
    setOverflow(false); setMoveMenu(false);
    try {
      const [note, conflict] = await Promise.all([api.getNote(id), api.getNoteConflict(id)]);
      if (request !== openRequest.current) return;
      const localDraft = dirtyDrafts.current.get(id);
      if (note || localDraft) {
        const documentNote = localDraft ?? placeLegacyTitleInBody(note!);
        currentRef.current = documentNote; setCurrent(documentNote); setNoteConflict(conflict); setReviewConflict(false); setSourceMode(false); setMobileScreen("note");
        if (!localDraft && note && documentNote.body !== note.body) void persist(documentNote);
      }
    } catch { if (request === openRequest.current) setNotice("Could not open this note."); }
  };

  const startNote = (categoryId: string | null) => {
    openRequest.current += 1;
    const note = { ...freshNote(), categoryId };
    unsavedNoteIds.current.add(note.id);
    currentRef.current = note; setCurrent(note); setNoteConflict(null); setReviewConflict(false); setOverflow(false); setNoteMenu(null); setMobileScreen("note"); setSourceMode(false);
    if (categoryId) { setActiveFolderId(categoryId); setExpanded((prev) => new Set(prev).add(categoryId)); }
    window.setTimeout(() => document.querySelector<HTMLElement>(".paper-editor")?.focus(), 50);
  };

  const createNote = () => startNote(view === "notes" ? activeFolderId : null);

  const moveNoteToFolder = async (id: string, categoryId: string | null) => {
    const note = notes.find((candidate) => candidate.id === id);
    if (note && note.categoryId === categoryId) return;
    if (dirtyDrafts.current.has(id) && !(await flushPersist(id))) return;
    try {
      await api.moveNote(id, categoryId);
      const name = categoryId ? categories.find((category) => category.id === categoryId)?.name ?? null : null;
      if (currentRef.current?.id === id) { const next = { ...currentRef.current, categoryId, categoryName: name }; currentRef.current = next; setCurrent(next); }
      if (categoryId) setExpanded((prev) => new Set(prev).add(categoryId));
      await loadNotes(); scheduleSync(); setNotice(categoryId ? `Moved to ${name ?? "folder"}` : "Moved out of folder");
    } catch { setNotice("Could not move that note."); }
  };

  const changeMode = (next: ListMode) => {
    setMode(next); setView("notes"); if (next === "all") setActiveFolderId(null);
    void api.setSetting("listMode", next).catch(() => { /* preference stays in memory */ });
  };

  const openTrash = () => {
    openRequest.current += 1;
    setView("trash"); setSettingsOpen(false); setSearch(""); setCurrent(null); currentRef.current = null; setActiveFolderId(null);
    setNoteConflict(null); setReviewConflict(false); setOverflow(false); setMobileScreen("list");
  };

  const toggleFolder = (id: string) => setExpanded((prev) => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });

  const selectFolder = (id: string) => { setActiveFolderId(id); toggleFolder(id); };

  const addCategory = async () => {
    const name = categoryName.trim(); if (!name) return;
    try {
      const category = await api.createCategory(name);
      setCategories((all) => [...all, category]); setCategoryName(""); setNewCategory(false);
      setMode("folders"); setView("notes"); setActiveFolderId(category.id); setExpanded((prev) => new Set(prev).add(category.id)); scheduleSync();
    } catch { setNotice("Could not create that folder."); }
  };

  const renameFolder = async () => {
    if (!renamingCategory || !renameCategoryName.trim()) return;
    try {
      const updated = await api.renameCategory(renamingCategory, renameCategoryName);
      setCategories((all) => all.map((category) => category.id === updated.id ? updated : category));
      setRenamingCategory(null); setCategoryMenu(null); scheduleSync();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not rename that folder."); }
  };

  const moveFolder = async (id: string, direction: -1 | 1) => {
    try { setCategories(await api.moveCategory(id, direction)); setCategoryMenu(null); scheduleSync(); }
    catch { setNotice("Could not reorder that folder."); }
  };

  const deleteFolder = async () => {
    if (!deletingCategory) return;
    try {
      await api.deleteCategory(deletingCategory.id);
      setExpanded((prev) => { const next = new Set(prev); next.delete(deletingCategory.id); return next; });
      setActiveFolderId((current) => current === deletingCategory.id ? null : current);
      setCategories((all) => all.filter((category) => category.id !== deletingCategory.id));
      setDeletingCategory(null); setCategoryMenu(null); await loadNotes("all", ""); scheduleSync(); setNotice("Folder removed; its notes are still safe");
    } catch { setNotice("Could not remove that folder."); }
  };

  const moveTo = async (categoryId: string | null) => {
    const active = currentRef.current; if (!active) return;
    if (dirtyDrafts.current.has(active.id) && !(await flushPersist(active.id))) return;
    try {
      await api.moveNote(active.id, categoryId);
      const name = categoryId ? categories.find((category) => category.id === categoryId)?.name ?? null : null;
      if (currentRef.current?.id === active.id) {
        const next = { ...currentRef.current, categoryId, categoryName: name, updatedAt: new Date().toISOString() };
        currentRef.current = next; setCurrent(next);
      }
      setMoveMenu(false); setOverflow(false); await loadNotes(); scheduleSync();
    } catch { setNotice("Could not move this note."); }
  };

  const trashCurrent = async () => {
    const active = currentRef.current; if (!active) return;
    if (!active.body.trim() && unsavedNoteIds.current.has(active.id)) {
      clearPendingSave(active.id, true); unsavedNoteIds.current.delete(active.id);
      if (currentRef.current?.id === active.id) { setCurrent(null); currentRef.current = null; setMobileScreen("list"); }
      return;
    }
    if (!(await flushPersist(active.id))) return;
    await api.trashNote(active.id); clearPendingSave(active.id, true);
    if (currentRef.current?.id === active.id) {
      setCurrent(null); currentRef.current = null; setNoteConflict(null); setOverflow(false); setMobileScreen("list");
    }
    await loadNotes(); scheduleSync(); setNotice("Moved to Trash");
  };

  const restoreCurrent = async () => {
    const active = currentRef.current; if (!active) return;
    await api.restoreNote(active.id);
    if (currentRef.current?.id === active.id) {
      setCurrent(null); currentRef.current = null; setNoteConflict(null); setOverflow(false); setMobileScreen("list");
    }
    await loadNotes(); scheduleSync(); setNotice("Note restored");
  };

  const deleteCurrent = async () => {
    const active = currentRef.current; if (!active) return;
    clearPendingSave(active.id, true); await saveChain.current;
    await api.deleteNote(active.id); unsavedNoteIds.current.delete(active.id);
    if (currentRef.current?.id === active.id) {
      setCurrent(null); currentRef.current = null; setNoteConflict(null); setOverflow(false); setMobileScreen("list");
    }
    await loadNotes(); scheduleSync(); setNotice("Permanently deleted");
  };

  const duplicateCurrent = async () => {
    const active = currentRef.current; if (!active) return;
    const request = openRequest.current;
    if (dirtyDrafts.current.has(active.id) && !(await flushPersist(active.id))) return;
    const savedDuplicate = await api.duplicateNote(active.id);
    const duplicate = placeLegacyTitleInBody(savedDuplicate);
    if (duplicate.body !== savedDuplicate.body) void persist(duplicate);
    if (currentRef.current?.id === active.id && request === openRequest.current) {
      currentRef.current = duplicate; setCurrent(duplicate); setOverflow(false);
    }
    await loadNotes(); scheduleSync();
  };

  const trashNoteId = async (id: string) => {
    setNoteMenu(null); if (dirtyDrafts.current.has(id) && !(await flushPersist(id))) return; await api.trashNote(id); clearPendingSave(id, true);
    if (currentRef.current?.id === id) { setCurrent(null); currentRef.current = null; setNoteConflict(null); setMobileScreen("list"); }
    await loadNotes(); scheduleSync(); setNotice("Moved to Trash");
  };

  const restoreNoteId = async (id: string) => {
    setNoteMenu(null); await api.restoreNote(id);
    if (currentRef.current?.id === id) { setCurrent(null); currentRef.current = null; setMobileScreen("list"); }
    await loadNotes(); scheduleSync(); setNotice("Note restored");
  };

  const deleteNoteId = async (id: string) => {
    setNoteMenu(null); clearPendingSave(id, true); await saveChain.current; await api.deleteNote(id); unsavedNoteIds.current.delete(id);
    if (currentRef.current?.id === id) { setCurrent(null); currentRef.current = null; setMobileScreen("list"); }
    await loadNotes(); scheduleSync(); setNotice("Permanently deleted");
  };

  const duplicateNoteId = async (id: string) => {
    setNoteMenu(null);
    const request = ++openRequest.current;
    try {
      if (dirtyDrafts.current.has(id) && !(await flushPersist(id))) return;
      const duplicate = placeLegacyTitleInBody(await api.duplicateNote(id));
      if (request !== openRequest.current) { await loadNotes(); scheduleSync(); return; }
      currentRef.current = duplicate; setCurrent(duplicate); setNoteConflict(null); setMobileScreen("note"); setSourceMode(false);
      await loadNotes(); scheduleSync();
    } catch { if (request === openRequest.current) setNotice("Could not duplicate this note."); }
  };

  const resolveConflict = async (resolution: "current" | "other" | "both") => {
    const active = currentRef.current; if (!active || !noteConflict) return;
    try {
      if (dirtyDrafts.current.has(active.id) && !(await flushPersist(active.id))) return;
      const resolved = placeLegacyTitleInBody(await api.resolveNoteConflict(active.id, resolution));
      if (currentRef.current?.id === active.id) {
        currentRef.current = resolved; setCurrent(resolved); setNoteConflict(null); setReviewConflict(false);
      }
      await loadNotes(); scheduleSync(); setNotice(resolution === "both" ? "Both versions kept" : "Conflict resolved");
      setSyncStatus(await api.getSyncStatus());
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not resolve this conflict."); }
  };

  const copy = async (content: string, message: string) => {
    await navigator.clipboard?.writeText(content); setOverflow(false); setNotice(message);
  };

  const share = async () => {
    const active = currentRef.current; if (!active) return;
    const content = active.body;
    if (navigator.share) { try { await navigator.share({ title: noteTitle(active), text: content }); } catch { /* share cancellation */ } }
    else await copy(content, "Markdown copied");
  };

  const exportNotebook = async () => {
    try {
      const destination = await save({ defaultPath: "Papyrus Notes.zip", filters: [{ name: "ZIP archive", extensions: ["zip"] }] });
      if (destination) { await api.exportNotebook(destination); setNotice("Notebook exported"); }
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not export notebook."); }
  };

  const changeTheme = (nextTheme: ThemeId) => {
    setTheme(nextTheme);
    void api.setSetting("theme", nextTheme).catch(() => setNotice("Could not save that theme preference."));
  };

  const changeFont = (nextFont: FontId) => {
    setFont(nextFont);
    void api.setSetting("font", nextFont).catch(() => setNotice("Could not save that font preference."));
  };

  const pickImageInBrowser = (): Promise<string | null> => new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/gif,image/webp";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      readImageFile(file).then(resolve).catch((error) => { setNotice(error instanceof Error ? error.message : "Could not read that image."); resolve(null); });
    };
    input.click();
  });

  const addImage = async (): Promise<string | null> => {
    try {
      if (!api.isNativeApp()) return await pickImageInBrowser();
      const source = await open({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] });
      if (!source || Array.isArray(source)) return null;
      return await api.embedImage(source);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not add that image."); return null; }
  };

  const currentCategory = categories.find((category) => category.id === current?.categoryId);
  const pairedDeviceCount = (syncStatus?.devices.length || 0) - 1;
  const sidebarSyncLabel = syncStatus?.status === "Offline" && pairedDeviceCount <= 0 ? "Not set up" : syncStatus?.status;

  const noteRow = (note: NoteListItem, variant: "rich" | "compact") => (
    <button key={note.id} className={`note-row ${variant}${current?.id === note.id ? " selected" : ""}${draggingId === note.id ? " dragging" : ""}`} onClick={() => void openNote(note.id)} draggable={view !== "trash"} onDragStart={(event) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", note.id); setDraggingId(note.id); setNoteMenu(null); }} onDragEnd={() => { setDraggingId(null); setDropTarget(null); }} onContextMenu={(event) => { event.preventDefault(); setOverflow(false); setCategoryMenu(null); setNoteMenu({ id: note.id, x: Math.min(event.clientX, window.innerWidth - 200), y: Math.min(event.clientY, window.innerHeight - 160) }); }}>
      <span className="note-row-title">{noteTitle(note)}</span>
      {variant === "rich" && <span className="note-row-preview">{note.preview || "No additional text"}</span>}
      <span className="note-row-meta">{variant === "rich" && <span>{note.categoryName || (view === "trash" ? "In Trash" : "")}</span>}<time>{relativeTime(note.updatedAt)}</time></span>
    </button>
  );

  return (
    <main className={`app ${railCollapsed ? "rail-collapsed" : ""} ${mobileScreen === "note" ? "show-note" : "show-list"}`}>
      <aside className="rail">
        <div className="rail-head">
          <div className="brand"><span>Papyrus</span></div>
          <button className="new-note-button" onClick={createNote}><Icon name="plus" size={16} /><span>New note</span></button>
        </div>

        {view === "trash" ? <div className="trash-bar">
          <button className="trash-back" onClick={() => setView("notes")}><Icon name="arrowLeft" size={16} /><span>Notes</span></button>
          <strong>Trash</strong>
          {notes.length > 0 ? <button className="text-button" onClick={() => { void api.emptyTrash().then(async () => { await loadNotes(); scheduleSync(); }); }}>Empty</button> : <span className="trash-spacer" />}
        </div> : <div className="segmented" role="tablist" aria-label="Note list mode">
          <button role="tab" aria-selected={mode === "all"} className={mode === "all" ? "active" : ""} onClick={() => changeMode("all")}><Icon name="all" size={15} />All Notes</button>
          <button role="tab" aria-selected={mode === "folders"} className={mode === "folders" ? "active" : ""} onClick={() => changeMode("folders")}><Icon name="folder" size={15} />Folders</button>
        </div>}

        <label className="search"><Icon name="search" size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search notes" aria-label="Search notes" /><kbd>⌘ K</kbd></label>

        <div className="rail-list">
          {loading ? <ListSkeleton />
            : searching || view === "trash" || mode === "all"
              ? (notes.length ? notes.map((note) => noteRow(note, "rich")) : <ListEmpty view={view} searching={searching} onCreate={createNote} onClearSearch={() => setSearch("")} />)
              : <>
                {categories.map((category, index) => {
                  const items = notes.filter((note) => note.categoryId === category.id);
                  const open = expanded.has(category.id);
                  const openMenu = () => setCategoryMenu((shown) => shown === category.id ? null : category.id);
                  return <div className="folder-group" key={category.id}>
                    <div className={`folder-head${activeFolderId === category.id ? " active" : ""}${dropTarget === category.id ? " drop-target" : ""}`} onContextMenu={(event) => { if (renamingCategory === category.id) return; event.preventDefault(); setNoteMenu(null); setActiveFolderId(category.id); setCategoryMenu(category.id); }} onDragOver={(event) => { if (!draggingId) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget(category.id); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget((target) => target === category.id ? null : target); }} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain") || draggingId; setDraggingId(null); setDropTarget(null); if (id) void moveNoteToFolder(id, category.id); }}>
                      {renamingCategory === category.id
                        ? <form className="folder-rename" onSubmit={(event) => { event.preventDefault(); void renameFolder(); }}><Icon name="folder" size={16} /><input autoFocus value={renameCategoryName} maxLength={80} onChange={(event) => setRenameCategoryName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenamingCategory(null); }} onBlur={() => { if (!renameCategoryName.trim()) setRenamingCategory(null); }} /></form>
                        : <button className="folder-toggle" onClick={() => selectFolder(category.id)} aria-expanded={open}>
                            <Icon name="chevronDown" size={15} className={open ? "chevron" : "chevron collapsed"} />
                            <Icon name="folder" size={16} className="folder-icon" />
                            <span className="folder-name">{category.name}</span>
                            <span className="folder-count">{items.length}</span>
                          </button>}
                      {renamingCategory !== category.id && <><button className="folder-add" onClick={() => startNote(category.id)} aria-label={`New note in ${category.name}`} title={`New note in ${category.name}`}><Icon name="plus" size={15} /></button><button className="folder-more" onClick={openMenu} aria-label={`Folder actions for ${category.name}`}><Icon name="dots" size={15} /></button></>}
                      {categoryMenu === category.id && <div className="folder-menu pop-menu">
                        <button onClick={() => { setRenamingCategory(category.id); setRenameCategoryName(category.name); setCategoryMenu(null); }}><Icon name="pen" />Rename</button>
                        <button disabled={index === 0} onClick={() => void moveFolder(category.id, -1)}><Icon name="arrowLeft" />Move up</button>
                        <button disabled={index === categories.length - 1} onClick={() => void moveFolder(category.id, 1)}><Icon name="arrowLeft" />Move down</button>
                        <button className="danger" onClick={() => { setDeletingCategory(category); setCategoryMenu(null); }}><Icon name="trash" />Remove folder</button>
                      </div>}
                    </div>
                    {open && <div className="folder-notes">{items.length ? items.map((note) => noteRow(note, "compact")) : <div className="folder-empty">No notes yet</div>}</div>}
                  </div>;
                })}
                {uncategorized.length > 0 && <div className="loose-notes">{uncategorized.map((note) => noteRow(note, "rich"))}</div>}
                {draggingId && notes.find((note) => note.id === draggingId)?.categoryId && <div className={`unfiled-dropzone${dropTarget === "__none__" ? " drop-target" : ""}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDropTarget("__none__"); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget((target) => target === "__none__" ? null : target); }} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("text/plain") || draggingId; setDraggingId(null); setDropTarget(null); if (id) void moveNoteToFolder(id, null); }}><Icon name="file" size={15} />Move out of folder</div>}
                {newCategory
                  ? <form className="folder-rename new" onSubmit={(event) => { event.preventDefault(); void addCategory(); }}><Icon name="folderPlus" size={16} /><input autoFocus value={categoryName} onChange={(event) => setCategoryName(event.target.value)} onBlur={() => { if (!categoryName.trim()) setNewCategory(false); }} placeholder="Folder name" /></form>
                  : <button className="add-folder" onClick={() => setNewCategory(true)}><Icon name="plus" size={15} />New Folder</button>}
              </>}
        </div>

        <div className="rail-footer">
          {syncStatus && <button className="sidebar-sync" onClick={() => setSettingsOpen(true)} aria-label={`Sync: ${sidebarSyncLabel}`}><i className={syncStatus.status.toLowerCase().replaceAll(" ", "-")} /><span>{sidebarSyncLabel}</span>{syncStatus.pendingOutgoingChanges > 0 && <b title={`${syncStatus.pendingOutgoingChanges} changes ready to upload`}>{syncStatus.pendingOutgoingChanges}</b>}</button>}
          <button className={view === "trash" ? "nav-item active" : "nav-item"} onClick={openTrash}><Icon name="trash" />Trash</button>
          <button className="nav-item" onClick={() => setSettingsOpen(true)}><Icon name="sun" />Settings</button>
        </div>
      </aside>

      <section className="note-pane">
        {current ? <>
          <header className="note-header">
            <button className="mobile-back icon-button" onClick={() => setMobileScreen("list")} aria-label="Back to notes"><Icon name="arrowLeft" /><span>Notes</span></button>
            <button className="icon-button editor-expand-toggle" onClick={() => setRailCollapsed((collapsed) => !collapsed)} aria-label={railCollapsed ? "Show notes list" : "Hide notes list"} title={railCollapsed ? "Show notes list" : "Focus editor"}><Icon name={railCollapsed ? "panelRight" : "panelLeft"} /></button>
            <div className="note-breadcrumb"><Icon name={currentCategory ? "folder" : "file"} size={15} /><span>{currentCategory?.name || "No folder"}</span></div>
            <div className="note-actions">
              {!current.deletedAt && <button className="icon-button" onClick={() => void share()} aria-label="Share note"><Icon name="share" /></button>}
              <div className="menu-wrap"><button className="icon-button" onClick={() => setOverflow((shown) => !shown)} aria-label="More note actions"><Icon name="dots" /></button>
                {overflow && <div className="pop-menu note-menu">
                  {current.deletedAt ? <><button onClick={() => void restoreCurrent()}><Icon name="undo" />Restore</button><button className="danger" onClick={() => void deleteCurrent()}><Icon name="trash" />Delete permanently</button></> : <><div className="submenu-wrap"><button onClick={() => setMoveMenu((shown) => !shown)}><Icon name="folder" />Move to…<Icon name="chevronDown" size={15} /></button>{moveMenu && <div className="sub-menu"><button onClick={() => void moveTo(null)}>No folder</button>{categories.map((category) => <button onClick={() => void moveTo(category.id)} key={category.id}>{category.name}</button>)}</div>}</div><button onClick={() => { setSourceMode((shown) => !shown); setOverflow(false); }}>{sourceMode ? "Return to paper" : "Edit Markdown source"}</button><button onClick={() => void duplicateCurrent()}><Icon name="copy" />Duplicate</button><button onClick={() => void copy(currentRef.current?.body ?? current.body, "Markdown copied")}><Icon name="file" />Copy Markdown</button><button className="danger" onClick={() => void trashCurrent()}><Icon name="trash" />Move to Trash</button></>}
                </div>}
              </div>
            </div>
          </header>
          {current.deletedAt ? <div className="trashed-note"><div><Icon name="trash" size={20} /><strong>This note is in Trash</strong><span>It will be permanently removed after 30 days.</span></div><button className="primary-button" onClick={() => void restoreCurrent()}>Restore Note</button></div> : <>
            {noteConflict && <div className="conflict-banner"><span><i>!</i><span><strong>Two versions need your attention</strong><small>Both are safe. Choose which one to keep.</small></span></span><button onClick={() => setReviewConflict(true)}>Review Versions</button></div>}
            <div className={`document ${sourceMode ? "source" : "paper"}`}>
              {sourceMode ? <div className="writing-surface source-surface"><Suspense fallback={<div className="editor-loading">Opening Markdown source…</div>}><MarkdownEditor value={current.body} onChange={(body) => changeCurrent({ body })} onReady={(view) => { editor.current = view; }} /></Suspense></div> : <PaperEditor value={current.body} onChange={(body) => changeCurrent({ body })} onInsertImage={addImage} onNotice={setNotice} />}
            </div>
          </>}
        </> : <EmptyNote onCreate={createNote} />}
      </section>

      {noteMenu && <div className="pop-menu context-menu" style={{ top: noteMenu.y, left: noteMenu.x }}>
        <button onClick={() => void openNote(noteMenu.id)}><Icon name="file" />Open</button>
        {view === "trash"
          ? <><button onClick={() => void restoreNoteId(noteMenu.id)}><Icon name="undo" />Restore</button><button className="danger" onClick={() => void deleteNoteId(noteMenu.id)}><Icon name="trash" />Delete permanently</button></>
          : <><button onClick={() => void duplicateNoteId(noteMenu.id)}><Icon name="copy" />Duplicate</button><button className="danger" onClick={() => void trashNoteId(noteMenu.id)}><Icon name="trash" />Move to Trash</button></>}
      </div>}

      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} onExport={exportNotebook} theme={theme} onThemeChange={changeTheme} font={font} onFontChange={changeFont} syncStatus={syncStatus} onSyncStatusChange={setSyncStatus} onNotebookChanged={refreshNotebook} onNotice={setNotice} />}
      {reviewConflict && noteConflict && <ConflictReview conflict={noteConflict} onClose={() => setReviewConflict(false)} onResolve={(choice) => void resolveConflict(choice)} />}
      {deletingCategory && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeletingCategory(null); }}><div className="pair-dialog compact" role="alertdialog" aria-modal="true" aria-labelledby="delete-folder-title"><span className="dialog-kicker danger">Remove folder</span><h2 id="delete-folder-title">Remove {deletingCategory.name}?</h2><p>The notes inside stay in your notebook and move to “No folder.” This change syncs to your other devices.</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setDeletingCategory(null)}>Cancel</button><button className="danger-button" onClick={() => void deleteFolder()}>Remove Folder</button></div></div></div>}
      {notice && <button className="toast" onClick={() => setNotice(null)} role="status" aria-live="polite"><Icon name="check" size={16} />{notice}</button>}
    </main>
  );
}

function ConflictReview({ conflict, onClose, onResolve }: { conflict: NoteConflict; onClose: () => void; onResolve: (choice: "current" | "other" | "both") => void }) {
  return <div className="modal-backdrop conflict-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <header><div><span className="dialog-kicker">Nothing was overwritten</span><h2 id="conflict-title">Review both versions</h2><p>These edits happened independently while devices were offline.</p></div><button className="dialog-close" onClick={onClose} aria-label="Close conflict review"><span>×</span></button></header>
      <div className="conflict-versions">
        <article><div className="version-label"><span>Current</span><small>{conflict.current.deletedAt ? "In Trash · " : ""}{conflict.current.deviceName} · {relativeTime(conflict.current.updatedAt)}</small></div><h3>{conflict.current.title || "Untitled note"}</h3><pre>{conflict.current.body || "Empty note"}</pre><button className="secondary-button wide" onClick={() => onResolve("current")}>Keep Current</button></article>
        <article><div className="version-label"><span>Other</span><small>{conflict.other.deletedAt ? "In Trash · " : ""}{conflict.other.deviceName} · {relativeTime(conflict.other.updatedAt)}</small></div><h3>{conflict.other.title || "Untitled note"}</h3><pre>{conflict.other.body || "Empty note"}</pre><button className="secondary-button wide" onClick={() => onResolve("other")}>Keep Other</button></article>
      </div>
      <footer><div><strong>Need something from each?</strong><span>Keep Both creates a clearly named copy of the other version.</span></div><button className="primary-button" onClick={() => onResolve("both")}><Icon name="copy" size={16} />Keep Both</button></footer>
    </div>
  </div>;
}

function EmptyNote({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-note"><span className="paper-glyph">✦</span><h2>A quiet place for every thought.</h2><p>Notes are private, stored locally, and written in ordinary Markdown.</p><button className="primary-button" onClick={onCreate}><Icon name="plus" size={17} />New note</button></div>;
}

function ListSkeleton() {
  return <div className="list-skeleton" role="status" aria-label="Opening your notebook">
    <i /><i /><i />
    <span>Opening your notebook…</span>
  </div>;
}

function ListEmpty({ view, searching, onCreate, onClearSearch }: { view: NoteView; searching: boolean; onCreate: () => void; onClearSearch: () => void }) {
  const isTrash = view === "trash";
  const title = searching ? "No matching notes" : isTrash ? "Trash is empty" : "Start your notebook";
  const message = searching ? "Try a different word, or clear the search to see every note." : isTrash ? "Notes you remove will stay here for 30 days." : "Capture an idea, a task, or the beginning of something larger.";
  return <div className="list-empty">
    <span className="list-empty-icon"><Icon name={searching ? "search" : isTrash ? "trash" : "file"} size={19} /></span>
    <strong>{title}</strong><p>{message}</p>
    {searching ? <button className="secondary-button" onClick={onClearSearch}>Clear search</button> : !isTrash && <button className="primary-button" onClick={onCreate}><Icon name="plus" size={16} />New note</button>}
  </div>;
}

type SettingsProps = {
  onClose: () => void;
  onExport: () => void;
  theme: ThemeId;
  onThemeChange: (theme: ThemeId) => void;
  font: FontId;
  onFontChange: (font: FontId) => void;
  syncStatus: SyncStatus | null;
  onSyncStatusChange: (status: SyncStatus) => void;
  onNotebookChanged: () => Promise<void>;
  onNotice: (message: string) => void;
};

function Settings({ onClose, onExport, theme, onThemeChange, font, onFontChange, syncStatus, onSyncStatusChange, onNotebookChanged, onNotice }: SettingsProps) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="settings-overlay" role="dialog" aria-modal="true" aria-label="Settings">
    <div className="settings-topbar"><button className="icon-button" onClick={onClose} aria-label="Close settings"><Icon name="arrowLeft" /></button><strong>Settings</strong></div>
    <div className="settings-scroll"><div className="settings">
      <header><span className="eyebrow">Notebook</span><h1>Settings</h1><p>Your notes stay local-first, readable, and yours—now with private sync when you want it.</p></header>
      <SyncSettings status={syncStatus} onStatusChange={onSyncStatusChange} onNotebookChanged={onNotebookChanged} onNotice={onNotice} />
      <section className="theme-section"><div><strong>Editor appearance</strong><span>Choose a comfortable colour palette for writing.</span></div><div className="theme-grid" role="group" aria-label="Editor appearance">{themes.map((option) => <button className={theme === option.id ? "theme-card selected" : "theme-card"} key={option.id} onClick={() => onThemeChange(option.id)} aria-pressed={theme === option.id}><span className="theme-preview" style={{ background: option.colors[0] }}><i style={{ background: option.colors[1] }} /><b style={{ background: option.colors[2] }} /></span><span><strong>{option.name}</strong><small>{option.description}</small></span>{theme === option.id && <Icon name="check" size={15} />}</button>)}</div></section>
      <section className="font-section"><div><strong>Writing font</strong><span>Use a clean sans serif throughout your notebook.</span></div><div className="font-options" role="group" aria-label="Writing font">{fonts.map((option) => <button className={font === option.id ? "font-option selected" : "font-option"} key={option.id} onClick={() => onFontChange(option.id)} aria-pressed={font === option.id}><span>{option.name}</span><small>{option.description}</small>{font === option.id && <Icon name="check" size={14} />}</button>)}</div></section>
      <section><div><strong>Export your notebook</strong><span>Create a ZIP of readable Markdown files, organized by folder.</span></div><button className="secondary-button" onClick={onExport}><Icon name="archive" size={17} />Export Markdown</button></section>
      <section><div><strong>Private by default</strong><span>Your relay transports encrypted packages only. Notes and keys remain unreadable there.</span></div><span className="status-pill"><i />Local-first</span></section>
    </div></div>
  </div>;
}

export default App;