import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Icon } from "./components/Icon";
import PaperEditor from "./components/PaperEditor";
import SyncSettings from "./components/SyncSettings";
import { api } from "./lib/api";
import { newId } from "./lib/ids";
import { noteTitle, relativeTime, titleFromMarkdown } from "./lib/format";
import type { Category, Note, NoteConflict, NoteListItem, SyncStatus } from "./types";

type ActivePlace = "all" | "trash" | "settings" | string;
type MobileScreen = "categories" | "notes" | "note";
type ThemeId = "mist" | "graphite" | "nord" | "solarized" | "dracula" | "gruvbox";
type FontId = "inter" | "manrope" | "dm-sans";

const MarkdownEditor = lazy(() => import("./components/MarkdownEditor"));

const themes: { id: ThemeId; name: string; description: string; colors: [string, string, string] }[] = [
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
  const [categories, setCategories] = useState<Category[]>([]);
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [activePlace, setActivePlace] = useState<ActivePlace>("all");
  const [search, setSearch] = useState("");
  const [current, setCurrent] = useState<Note | null>(null);
  const [sourceMode, setSourceMode] = useState(false);
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>("categories");
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
  const [theme, setTheme] = useState<ThemeId>("mist");
  const [font, setFont] = useState<FontId>("inter");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [editorExpanded, setEditorExpanded] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [noteConflict, setNoteConflict] = useState<NoteConflict | null>(null);
  const [reviewConflict, setReviewConflict] = useState(false);
  const editor = useRef<EditorView | null>(null);
  const pendingSave = useRef<number | null>(null);
  const pendingSync = useRef<number | null>(null);
  const currentRef = useRef<Note | null>(null);

  const filter = activePlace === "settings" ? "all" : activePlace;
  const activeLabel = useMemo(() => {
    if (activePlace === "all") return search ? "Search" : "All Notes";
    if (activePlace === "trash") return "Trash";
    if (activePlace === "settings") return "Settings";
    return categories.find((category) => category.id === activePlace)?.name || "Notes";
  }, [activePlace, categories, search]);

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
      setNoteConflict(conflict);
      if (refreshed) { const documentNote = placeLegacyTitleInBody(refreshed); currentRef.current = documentNote; setCurrent(documentNote); }
      else { currentRef.current = null; setCurrent(null); setNoteConflict(null); setReviewConflict(false); }
    }
  }, [filter, search]);

  const runSync = useCallback(async () => {
    if (!api.isNativeApp()) return;
    setSyncStatus((status) => status ? { ...status, status: "Syncing" } : status);
    try { const next = await api.syncNow(); setSyncStatus(next); await refreshNotebook(); }
    catch { try { setSyncStatus(await api.getSyncStatus()); } catch { /* editing remains local */ } }
  }, [refreshNotebook]);

  const scheduleSync = useCallback(() => {
    if (!api.isNativeApp()) return;
    if (pendingSync.current) window.clearTimeout(pendingSync.current);
    pendingSync.current = window.setTimeout(() => { pendingSync.current = null; void runSync(); }, 750);
  }, [runSync]);

  useEffect(() => {
    (async () => {
      try {
        await api.initialize();
        const [loadedCategories, loadedNotes, savedTheme, savedFont, loadedSyncStatus] = await Promise.all([api.listCategories(), api.listNotes("all"), api.getSetting("theme"), api.getSetting("font"), api.getSyncStatus()]);
        setCategories(loadedCategories); setNotes(loadedNotes);
        setSyncStatus(loadedSyncStatus);
        if (themes.some((item) => item.id === savedTheme)) setTheme(savedTheme as ThemeId);
        if (fonts.some((item) => item.id === savedFont)) setFont(savedFont as FontId);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Papyrus could not open the notebook.");
      } finally { setLoading(false); }
    })();
  }, []);

  useEffect(() => {
    if (loading || !api.isNativeApp()) return;
    const trigger = () => { if (document.visibilityState === "visible") void runSync(); };
    const interval = window.setInterval(trigger, 2 * 60 * 1000);
    document.addEventListener("visibilitychange", trigger); window.addEventListener("focus", trigger); window.addEventListener("online", trigger);
    const launch = window.setTimeout(trigger, 500);
    return () => { window.clearInterval(interval); window.clearTimeout(launch); document.removeEventListener("visibilitychange", trigger); window.removeEventListener("focus", trigger); window.removeEventListener("online", trigger); };
  }, [loading, runSync]);

  useEffect(() => {
    if (loading) return;
    const id = window.setTimeout(() => { void loadNotes(); }, search ? 120 : 0);
    return () => window.clearTimeout(id);
  }, [activePlace, search, loading, loadNotes]);

  useEffect(() => () => {
    if (pendingSave.current) window.clearTimeout(pendingSave.current);
    if (pendingSync.current) window.clearTimeout(pendingSync.current);
  }, []);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useEffect(() => { document.documentElement.dataset.font = font; }, [font]);

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

  const persist = useCallback(async (note: Note) => {
    if (!note.body.trim()) return;
    const title = titleFromMarkdown(note.body);
    try {
      const saved = await api.saveNote({ id: note.id, title, body: note.body, categoryId: note.categoryId });
      if (currentRef.current?.id === note.id) {
        const combined = { ...note, ...saved, title, body: saved.body ?? note.body };
        currentRef.current = combined; setCurrent(combined);
      }
      window.setTimeout(() => { void loadNotes(); }, 350);
      scheduleSync();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not save this note."); }
  }, [loadNotes, scheduleSync]);

  const changeCurrent = (change: Partial<Pick<Note, "body" | "categoryId">>) => {
    const existing = currentRef.current; if (!existing || existing.deletedAt) return;
    const body = change.body ?? existing.body;
    const next = { ...existing, ...change, body, title: titleFromMarkdown(body), updatedAt: new Date().toISOString() };
    currentRef.current = next; setCurrent(next);
    if (pendingSave.current) window.clearTimeout(pendingSave.current);
    pendingSave.current = window.setTimeout(() => { void persist(next); }, 480);
  };

  const openNote = async (id: string) => {
    setOverflow(false); setMoveMenu(false);
    try {
      const [note, conflict] = await Promise.all([api.getNote(id), api.getNoteConflict(id)]);
      if (note) {
        const documentNote = placeLegacyTitleInBody(note);
        currentRef.current = documentNote; setCurrent(documentNote); setNoteConflict(conflict); setReviewConflict(false); setSourceMode(false); setMobileScreen("note");
        if (documentNote.body !== note.body) void persist(documentNote);
      }
    } catch { setNotice("Could not open this note."); }
  };

  const createNote = () => {
    if (pendingSave.current) window.clearTimeout(pendingSave.current);
    const note = { ...freshNote(), categoryId: activePlace !== "all" && activePlace !== "trash" && activePlace !== "settings" ? activePlace : null };
    currentRef.current = note; setCurrent(note); setNoteConflict(null); setReviewConflict(false); setOverflow(false); setMobileScreen("note"); setSourceMode(false);
    window.setTimeout(() => document.querySelector<HTMLElement>(".paper-editor")?.focus(), 50);
  };

  const switchPlace = (place: ActivePlace) => {
    setActivePlace(place); setSearch(""); setCurrent(null); currentRef.current = null; setNoteConflict(null); setReviewConflict(false); setOverflow(false); setEditorExpanded(false); setMobileScreen(place === "settings" ? "note" : "notes");
  };

  const addCategory = async () => {
    const name = categoryName.trim(); if (!name) return;
    try {
      const category = await api.createCategory(name);
      setCategories((all) => [...all, category]); setCategoryName(""); setNewCategory(false); switchPlace(category.id); scheduleSync();
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
      if (activePlace === deletingCategory.id) switchPlace("all");
      setCategories((all) => all.filter((category) => category.id !== deletingCategory.id));
      setDeletingCategory(null); setCategoryMenu(null); await loadNotes("all", ""); scheduleSync(); setNotice("Folder removed; its notes are still safe");
    } catch { setNotice("Could not remove that folder."); }
  };

  const moveTo = async (categoryId: string | null) => {
    if (!current) return;
    const next = { ...current, categoryId, updatedAt: new Date().toISOString() };
    currentRef.current = next; setCurrent(next); setMoveMenu(false); setOverflow(false);
    await api.moveNote(next.id, categoryId); await loadNotes(); scheduleSync();
  };

  const trashCurrent = async () => {
    if (!current) return;
    if (!current.body.trim()) { setCurrent(null); currentRef.current = null; return; }
    await api.trashNote(current.id); setCurrent(null); currentRef.current = null; setNoteConflict(null); setOverflow(false); await loadNotes(); scheduleSync();
    setNotice("Moved to Trash");
  };

  const restoreCurrent = async () => {
    if (!current) return;
    await api.restoreNote(current.id); setCurrent(null); currentRef.current = null; setNoteConflict(null); setOverflow(false); await loadNotes(); scheduleSync(); setNotice("Note restored");
  };

  const deleteCurrent = async () => {
    if (!current) return;
    await api.deleteNote(current.id); setCurrent(null); currentRef.current = null; setNoteConflict(null); setOverflow(false); await loadNotes(); scheduleSync(); setNotice("Permanently deleted");
  };

  const duplicateCurrent = async () => {
    if (!current) return;
    const savedDuplicate = await api.duplicateNote(current.id);
    const duplicate = placeLegacyTitleInBody(savedDuplicate); currentRef.current = duplicate; setCurrent(duplicate); setOverflow(false);
    if (duplicate.body !== savedDuplicate.body) void persist(duplicate);
    await loadNotes(); scheduleSync();
  };

  const resolveConflict = async (resolution: "current" | "other" | "both") => {
    if (!current || !noteConflict) return;
    try {
      const resolved = placeLegacyTitleInBody(await api.resolveNoteConflict(current.id, resolution));
      currentRef.current = resolved; setCurrent(resolved); setNoteConflict(null); setReviewConflict(false);
      await loadNotes(); scheduleSync(); setNotice(resolution === "both" ? "Both versions kept" : "Conflict resolved");
      setSyncStatus(await api.getSyncStatus());
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not resolve this conflict."); }
  };

  const copy = async (content: string, message: string) => {
    await navigator.clipboard?.writeText(content); setOverflow(false); setNotice(message);
  };

  const share = async () => {
    if (!current) return;
    const content = current.body;
    if (navigator.share) { try { await navigator.share({ title: noteTitle(current), text: content }); } catch { /* share cancellation */ } }
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

  const addImage = async (): Promise<string | null> => {
    try {
      const source = await open({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] });
      if (!source || Array.isArray(source)) return null;
      return await api.embedImage(source);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not add that image."); return null; }
  };

  const currentCategory = categories.find((category) => category.id === current?.categoryId);

  return (
    <main className={`app ${sidebarCollapsed ? "sidebar-collapsed" : ""} ${editorExpanded ? "editor-expanded" : ""} ${mobileScreen === "categories" ? "show-categories" : mobileScreen === "notes" ? "show-notes" : "show-note"}`}>
      <aside className="sidebar categories-pane">
        <div className="brand"><span className="brand-mark" aria-hidden="true" /><span>Papyrus</span></div>
        <nav className="nav-list" aria-label="Notebook navigation">
          <button className={activePlace === "all" ? "nav-item active" : "nav-item"} onClick={() => switchPlace("all")}><Icon name="all" />All Notes</button>
          <div className="nav-section-label">Folders</div>
          {categories.map((category, index) => <div className="category-nav-row" key={category.id}>
            {renamingCategory === category.id ? <form className="rename-category" onSubmit={(event) => { event.preventDefault(); void renameFolder(); }}><Icon name="folder" /><input autoFocus value={renameCategoryName} maxLength={80} onChange={(event) => setRenameCategoryName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setRenamingCategory(null); }} onBlur={() => { if (!renameCategoryName.trim()) setRenamingCategory(null); }} /></form> : <button className={activePlace === category.id ? "nav-item active" : "nav-item"} onClick={() => switchPlace(category.id)}><Icon name="folder" /><span>{category.name}</span></button>}
            {renamingCategory !== category.id && <button className="category-menu-button" onClick={() => setCategoryMenu((open) => open === category.id ? null : category.id)} aria-label={`Folder actions for ${category.name}`}><Icon name="dots" size={15} /></button>}
            {categoryMenu === category.id && <div className="category-menu pop-menu">
              <button onClick={() => { setRenamingCategory(category.id); setRenameCategoryName(category.name); setCategoryMenu(null); }}><Icon name="file" />Rename</button>
              <button disabled={index === 0} onClick={() => void moveFolder(category.id, -1)}><Icon name="arrowLeft" />Move up</button>
              <button disabled={index === categories.length - 1} onClick={() => void moveFolder(category.id, 1)}><Icon name="arrowLeft" />Move down</button>
              <button className="danger" onClick={() => { setDeletingCategory(category); setCategoryMenu(null); }}><Icon name="trash" />Remove folder</button>
            </div>}
          </div>)}
          {newCategory ? <form className="new-category" onSubmit={(event) => { event.preventDefault(); void addCategory(); }}><Icon name="folderPlus" /><input autoFocus value={categoryName} onChange={(event) => setCategoryName(event.target.value)} onBlur={() => { if (!categoryName.trim()) setNewCategory(false); }} placeholder="Folder name" /></form> : <button className="nav-item quiet" onClick={() => setNewCategory(true)}><Icon name="plus" />Add Folder</button>}
        </nav>
        <div className="sidebar-footer">
          {syncStatus && <button className="sidebar-sync" onClick={() => switchPlace("settings")} aria-label={`Sync: ${syncStatus.status}`}><i className={syncStatus.status.toLowerCase().replaceAll(" ", "-")} /><span>{syncStatus.status}</span>{syncStatus.pendingOutgoingChanges > 0 && <b>{syncStatus.pendingOutgoingChanges}</b>}</button>}
          <button className={activePlace === "trash" ? "nav-item active" : "nav-item"} onClick={() => switchPlace("trash")}><Icon name="trash" />Trash</button>
          <button className={activePlace === "settings" ? "nav-item active" : "nav-item"} onClick={() => switchPlace("settings")}><Icon name="sun" />Settings</button>
        </div>
      </aside>

      <section className="notes-pane">
        <header className="notes-header">
          <button className="mobile-back icon-button" onClick={() => setMobileScreen("categories")} aria-label="Back to folders"><Icon name="arrowLeft" /></button>
          <button className="icon-button sidebar-toggle" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-label={sidebarCollapsed ? "Show folders sidebar" : "Hide folders sidebar"} title={sidebarCollapsed ? "Show folders sidebar" : "Hide folders sidebar"}><Icon name="menu" /></button>
          <h1>{activeLabel}</h1>
          {activePlace === "trash" && notes.length > 0 ? <button className="text-button" onClick={() => { void api.emptyTrash().then(async () => { await loadNotes(); scheduleSync(); }); }}>Empty</button> : <button className="new-note-button" onClick={createNote}><Icon name="plus" size={16} /><span>New</span></button>}
        </header>
        <label className="search"><Icon name="search" size={17} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search notes" aria-label="Search notes" /><kbd>⌘ K</kbd></label>
        <div className="notes-list">
          {loading ? <div className="list-message">Opening your notebook…</div> : notes.length === 0 ? <div className="list-message">{search ? "No notes match that search." : activePlace === "trash" ? "Trash is empty." : "No notes here yet."}</div> : notes.map((note) => <button key={note.id} className={current?.id === note.id ? "note-row selected" : "note-row"} onClick={() => void openNote(note.id)}>
            <span className="note-row-title">{noteTitle(note)}</span>
            <span className="note-row-preview">{note.preview || "No additional text"}</span>
            <span className="note-row-meta"><span>{note.categoryName || (activePlace === "trash" ? "In Trash" : "")}</span><time>{relativeTime(note.updatedAt)}</time></span>
          </button>)}
        </div>
      </section>

      <section className="note-pane">
        {activePlace === "settings" ? <Settings onBack={() => setMobileScreen("categories")} onExport={exportNotebook} theme={theme} onThemeChange={changeTheme} font={font} onFontChange={changeFont} syncStatus={syncStatus} onSyncStatusChange={setSyncStatus} onNotebookChanged={refreshNotebook} onNotice={setNotice} /> : current ? <>
          <header className="note-header">
            <button className="mobile-back icon-button" onClick={() => setMobileScreen("notes")} aria-label="Back to notes"><Icon name="arrowLeft" /></button>
            <button className="icon-button editor-expand-toggle" onClick={() => setEditorExpanded((expanded) => !expanded)} aria-label={editorExpanded ? "Show notes list" : "Expand editor and hide notes list"} title={editorExpanded ? "Show notes list" : "Expand editor"}><Icon name={editorExpanded ? "panelRight" : "panelLeft"} /></button>
            <div className="note-breadcrumb"><Icon name={currentCategory ? "folder" : "file"} size={15} /><span>{currentCategory?.name || "No folder"}</span></div>
            <div className="note-actions">
              {!current.deletedAt && <button className="icon-button" onClick={() => void share()} aria-label="Share note"><Icon name="share" /></button>}
              <div className="menu-wrap"><button className="icon-button" onClick={() => setOverflow((shown) => !shown)} aria-label="More note actions"><Icon name="dots" /></button>
                {overflow && <div className="pop-menu note-menu">
                  {current.deletedAt ? <><button onClick={() => void restoreCurrent()}><Icon name="undo" />Restore</button><button className="danger" onClick={() => void deleteCurrent()}><Icon name="trash" />Delete permanently</button></> : <><div className="submenu-wrap"><button onClick={() => setMoveMenu((shown) => !shown)}><Icon name="folder" />Move to…<Icon name="chevronDown" size={15} /></button>{moveMenu && <div className="sub-menu"><button onClick={() => void moveTo(null)}>No folder</button>{categories.map((category) => <button onClick={() => void moveTo(category.id)} key={category.id}>{category.name}</button>)}</div>}</div><button onClick={() => { setSourceMode((shown) => !shown); setOverflow(false); }}>{sourceMode ? "Return to paper" : "Edit Markdown source"}</button><button onClick={() => void duplicateCurrent()}><Icon name="copy" />Duplicate</button><button onClick={() => void copy(current.body, "Markdown copied")}><Icon name="file" />Copy Markdown</button><button className="danger" onClick={() => void trashCurrent()}><Icon name="trash" />Move to Trash</button></>}
                </div>}
              </div>
            </div>
          </header>
          {current.deletedAt ? <div className="trashed-note"><div><Icon name="trash" size={20} /><strong>This note is in Trash</strong><span>It will be permanently removed after 30 days.</span></div><button className="primary-button" onClick={() => void restoreCurrent()}>Restore Note</button></div> : <>
            {noteConflict && <div className="conflict-banner"><span><i>!</i><span><strong>Two versions need your attention</strong><small>Both are safe. Choose which one to keep.</small></span></span><button onClick={() => setReviewConflict(true)}>Review Versions</button></div>}
            <div className={`document ${sourceMode ? "source" : "paper"}`}>
              {sourceMode ? <div className="writing-surface source-surface"><Suspense fallback={<div className="editor-loading">Opening Markdown source…</div>}><MarkdownEditor value={current.body} onChange={(body) => changeCurrent({ body })} onReady={(view) => { editor.current = view; }} /></Suspense></div> : <PaperEditor value={current.body} onChange={(body) => changeCurrent({ body })} onInsertImage={addImage} />}
            </div>
          </>}
        </> : <EmptyNote onCreate={createNote} activePlace={activePlace} />}
      </section>
      {reviewConflict && noteConflict && <ConflictReview conflict={noteConflict} onClose={() => setReviewConflict(false)} onResolve={(choice) => void resolveConflict(choice)} />}
      {deletingCategory && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeletingCategory(null); }}><div className="pair-dialog compact" role="alertdialog" aria-modal="true" aria-labelledby="delete-folder-title"><span className="dialog-kicker danger">Remove folder</span><h2 id="delete-folder-title">Remove {deletingCategory.name}?</h2><p>The notes inside stay in your notebook and move to “No folder.” This change syncs to your other devices.</p><div className="dialog-actions"><button className="secondary-button" onClick={() => setDeletingCategory(null)}>Cancel</button><button className="danger-button" onClick={() => void deleteFolder()}>Remove Folder</button></div></div></div>}
      {notice && <button className="toast" onClick={() => setNotice(null)}><Icon name="check" size={16} />{notice}</button>}
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

function EmptyNote({ onCreate, activePlace }: { onCreate: () => void; activePlace: ActivePlace }) {
  if (activePlace === "trash") return <div className="empty-note"><Icon name="trash" size={30} /><h2>Your trash is empty</h2><p>Notes you delete stay here for 30 days.</p></div>;
  return <div className="empty-note"><span className="paper-glyph">✦</span><h2>A quiet place for every thought.</h2><p>Notes are private, stored locally, and written in ordinary Markdown.</p><button className="primary-button" onClick={onCreate}><Icon name="plus" size={17} />New note</button></div>;
}

type SettingsProps = {
  onBack: () => void;
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

function Settings({ onBack, onExport, theme, onThemeChange, font, onFontChange, syncStatus, onSyncStatusChange, onNotebookChanged, onNotice }: SettingsProps) {
  return <div className="settings-shell">
    <div className="settings-mobile-bar"><button className="icon-button" onClick={onBack} aria-label="Back to notebook"><Icon name="arrowLeft" /></button><strong>Settings</strong></div>
    <div className="settings">
      <header><span className="eyebrow">Notebook</span><h1>Settings</h1><p>Your notes stay local-first, readable, and yours—now with private sync when you want it.</p></header>
      <SyncSettings status={syncStatus} onStatusChange={onSyncStatusChange} onNotebookChanged={onNotebookChanged} onNotice={onNotice} />
      <section className="theme-section"><div><strong>Editor appearance</strong><span>Choose a comfortable colour palette for writing.</span></div><div className="theme-grid" role="group" aria-label="Editor appearance">{themes.map((option) => <button className={theme === option.id ? "theme-card selected" : "theme-card"} key={option.id} onClick={() => onThemeChange(option.id)} aria-pressed={theme === option.id}><span className="theme-preview" style={{ background: option.colors[0] }}><i style={{ background: option.colors[1] }} /><b style={{ background: option.colors[2] }} /></span><span><strong>{option.name}</strong><small>{option.description}</small></span>{theme === option.id && <Icon name="check" size={15} />}</button>)}</div></section>
      <section className="font-section"><div><strong>Writing font</strong><span>Use a clean sans serif throughout your notebook.</span></div><div className="font-options" role="group" aria-label="Writing font">{fonts.map((option) => <button className={font === option.id ? "font-option selected" : "font-option"} key={option.id} onClick={() => onFontChange(option.id)} aria-pressed={font === option.id}><span>{option.name}</span><small>{option.description}</small>{font === option.id && <Icon name="check" size={14} />}</button>)}</div></section>
      <section><div><strong>Export your notebook</strong><span>Create a ZIP of readable Markdown files, organized by folder.</span></div><button className="secondary-button" onClick={onExport}><Icon name="archive" size={17} />Export Markdown</button></section>
      <section><div><strong>Private by default</strong><span>Your relay transports encrypted packages only. Notes and keys remain unreadable there.</span></div><span className="status-pill"><i />Local-first</span></section>
    </div>
  </div>;
}

export default App;
