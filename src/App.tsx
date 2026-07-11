import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Icon } from "./components/Icon";
import MarkdownEditor from "./components/MarkdownEditor";
import { api } from "./lib/api";
import { newId } from "./lib/ids";
import { noteTitle, relativeTime } from "./lib/format";
import { renderMarkdown, renderedText } from "./lib/markdown";
import type { Category, Note, NoteListItem } from "./types";

type ActivePlace = "all" | "trash" | "settings" | string;
type Display = "write" | "preview" | "split";
type MobileScreen = "categories" | "notes" | "note";

const freshNote = (): Note => ({
  id: newId(), title: "", body: "", categoryId: null,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null, revisionId: newId(),
});

function App() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [notes, setNotes] = useState<NoteListItem[]>([]);
  const [activePlace, setActivePlace] = useState<ActivePlace>("all");
  const [search, setSearch] = useState("");
  const [current, setCurrent] = useState<Note | null>(null);
  const [display, setDisplay] = useState<Display>("write");
  const [mobileScreen, setMobileScreen] = useState<MobileScreen>("categories");
  const [loading, setLoading] = useState(true);
  const [newCategory, setNewCategory] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [overflow, setOverflow] = useState(false);
  const [moveMenu, setMoveMenu] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const editor = useRef<EditorView | null>(null);
  const pendingSave = useRef<number | null>(null);
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

  useEffect(() => {
    (async () => {
      try {
        await api.initialize();
        const [loadedCategories, loadedNotes] = await Promise.all([api.listCategories(), api.listNotes("all")]);
        setCategories(loadedCategories); setNotes(loadedNotes);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Papyrus could not open the notebook.");
      } finally { setLoading(false); }
    })();
  }, []);

  useEffect(() => {
    if (loading) return;
    const id = window.setTimeout(() => { void loadNotes(); }, search ? 120 : 0);
    return () => window.clearTimeout(id);
  }, [activePlace, search, loading, loadNotes]);

  useEffect(() => () => { if (pendingSave.current) window.clearTimeout(pendingSave.current); }, []);

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
    if (!note.title.trim() && !note.body.trim()) return;
    try {
      const saved = await api.saveNote({ id: note.id, title: note.title, body: note.body, categoryId: note.categoryId });
      if (currentRef.current?.id === note.id) {
        const combined = { ...note, ...saved, body: saved.body ?? note.body };
        currentRef.current = combined; setCurrent(combined);
      }
      window.setTimeout(() => { void loadNotes(); }, 350);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not save this note."); }
  }, [loadNotes]);

  const changeCurrent = (change: Partial<Pick<Note, "title" | "body" | "categoryId">>) => {
    const existing = currentRef.current; if (!existing || existing.deletedAt) return;
    const next = { ...existing, ...change, updatedAt: new Date().toISOString() };
    currentRef.current = next; setCurrent(next);
    if (pendingSave.current) window.clearTimeout(pendingSave.current);
    pendingSave.current = window.setTimeout(() => { void persist(next); }, 480);
  };

  const openNote = async (id: string) => {
    setOverflow(false); setMoveMenu(false);
    try {
      const note = await api.getNote(id);
      if (note) { currentRef.current = note; setCurrent(note); setMobileScreen("note"); }
    } catch { setNotice("Could not open this note."); }
  };

  const createNote = () => {
    if (pendingSave.current) window.clearTimeout(pendingSave.current);
    const note = { ...freshNote(), categoryId: activePlace !== "all" && activePlace !== "trash" && activePlace !== "settings" ? activePlace : null };
    currentRef.current = note; setCurrent(note); setOverflow(false); setMobileScreen("note"); setDisplay("write");
    window.setTimeout(() => document.querySelector<HTMLInputElement>(".note-title")?.focus(), 50);
  };

  const switchPlace = (place: ActivePlace) => {
    setActivePlace(place); setSearch(""); setCurrent(null); currentRef.current = null; setOverflow(false); setMobileScreen("notes");
  };

  const addCategory = async () => {
    const name = categoryName.trim(); if (!name) return;
    try {
      const category = await api.createCategory(name);
      setCategories((all) => [...all, category]); setCategoryName(""); setNewCategory(false); switchPlace(category.id);
    } catch { setNotice("Could not create that category."); }
  };

  const moveTo = async (categoryId: string | null) => {
    if (!current) return;
    const next = { ...current, categoryId, updatedAt: new Date().toISOString() };
    currentRef.current = next; setCurrent(next); setMoveMenu(false); setOverflow(false);
    await api.moveNote(next.id, categoryId); await loadNotes();
  };

  const trashCurrent = async () => {
    if (!current) return;
    if (!current.title.trim() && !current.body.trim()) { setCurrent(null); currentRef.current = null; return; }
    await api.trashNote(current.id); setCurrent(null); currentRef.current = null; setOverflow(false); await loadNotes();
    setNotice("Moved to Trash");
  };

  const restoreCurrent = async () => {
    if (!current) return;
    await api.restoreNote(current.id); setCurrent(null); currentRef.current = null; setOverflow(false); await loadNotes(); setNotice("Note restored");
  };

  const deleteCurrent = async () => {
    if (!current) return;
    await api.deleteNote(current.id); setCurrent(null); currentRef.current = null; setOverflow(false); await loadNotes(); setNotice("Permanently deleted");
  };

  const duplicateCurrent = async () => {
    if (!current) return;
    const duplicate = await api.duplicateNote(current.id); currentRef.current = duplicate; setCurrent(duplicate); setOverflow(false); await loadNotes();
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

  const applyFormat = (kind: "heading" | "bold" | "link" | "checklist" | "code") => {
    const view = editor.current; if (!view) return;
    const range = view.state.selection.main; const selection = view.state.sliceDoc(range.from, range.to);
    const wrappers = {
      heading: ["## ", ""], bold: ["**", "**"], link: ["[", "](https://)"], checklist: ["- [ ] ", ""], code: ["`", "`"],
    } as const;
    const [before, after] = wrappers[kind];
    view.dispatch({ changes: { from: range.from, to: range.to, insert: `${before}${selection || (kind === "link" ? "link text" : kind === "checklist" ? "Task" : "text")}${after}` }, selection: { anchor: range.from + before.length, head: range.from + before.length + (selection || (kind === "link" ? "link text" : kind === "checklist" ? "Task" : "text")).length } });
    view.focus();
  };

  const addImage = async () => {
    try {
      const source = await open({ multiple: false, filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] });
      if (!source || Array.isArray(source)) return;
      const image = await api.embedImage(source);
      const view = editor.current; if (!view) return;
      const range = view.state.selection.main; const insertion = `\n![Image](${image})\n`;
      view.dispatch({ changes: { from: range.from, to: range.to, insert: insertion }, selection: { anchor: range.from + insertion.length } });
      view.focus();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not add that image."); }
  };

  const toggleTask = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLInputElement;
    if (target.tagName !== "INPUT" || target.type !== "checkbox" || !current) return;
    event.preventDefault();
    const boxes = Array.from(event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
    const index = boxes.indexOf(target); let count = -1;
    const body = current.body.replace(/- \[([ xX])\]/g, (match, state) => {
      count += 1; return count === index ? `- [${state.toLowerCase() === "x" ? " " : "x"}]` : match;
    });
    changeCurrent({ body });
  };

  const showEditor = current && !current.deletedAt;
  const currentCategory = categories.find((category) => category.id === current?.categoryId);

  return (
    <main className={`app ${mobileScreen === "categories" ? "show-categories" : mobileScreen === "notes" ? "show-notes" : "show-note"}`}>
      <aside className="sidebar categories-pane">
        <div className="brand"><span className="brand-mark">P</span><span>Papyrus</span></div>
        <nav className="nav-list" aria-label="Notebook navigation">
          <button className={activePlace === "all" ? "nav-item active" : "nav-item"} onClick={() => switchPlace("all")}><Icon name="all" />All Notes</button>
          <div className="nav-section-label">Categories</div>
          {categories.map((category) => <button className={activePlace === category.id ? "nav-item active" : "nav-item"} onClick={() => switchPlace(category.id)} key={category.id}><Icon name="folder" />{category.name}</button>)}
          {newCategory ? <form className="new-category" onSubmit={(event) => { event.preventDefault(); void addCategory(); }}><Icon name="folderPlus" /><input autoFocus value={categoryName} onChange={(event) => setCategoryName(event.target.value)} onBlur={() => { if (!categoryName.trim()) setNewCategory(false); }} placeholder="Category name" /></form> : <button className="nav-item quiet" onClick={() => setNewCategory(true)}><Icon name="plus" />Add Category</button>}
        </nav>
        <div className="sidebar-footer">
          <button className={activePlace === "trash" ? "nav-item active" : "nav-item"} onClick={() => switchPlace("trash")}><Icon name="trash" />Trash</button>
          <button className={activePlace === "settings" ? "nav-item active" : "nav-item"} onClick={() => switchPlace("settings")}><Icon name="sun" />Settings</button>
        </div>
      </aside>

      <section className="notes-pane">
        <header className="notes-header">
          <button className="mobile-back icon-button" onClick={() => setMobileScreen("categories")} aria-label="Back to categories"><Icon name="arrowLeft" /></button>
          <h1>{activeLabel}</h1>
          {activePlace === "trash" && notes.length > 0 ? <button className="text-button" onClick={() => { void api.emptyTrash().then(() => loadNotes()); }}>Empty</button> : <button className="new-note-button" onClick={createNote}><Icon name="plus" size={16} /><span>New</span></button>}
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
        {activePlace === "settings" ? <Settings onExport={exportNotebook} /> : current ? <>
          <header className="note-header">
            <button className="mobile-back icon-button" onClick={() => setMobileScreen("notes")} aria-label="Back to notes"><Icon name="arrowLeft" /></button>
            <div className="note-breadcrumb"><Icon name={currentCategory ? "folder" : "file"} size={15} /><span>{currentCategory?.name || "Uncategorized"}</span></div>
            <div className="note-actions">
              {!current.deletedAt && <button className="icon-button" onClick={() => void share()} aria-label="Share note"><Icon name="share" /></button>}
              <div className="menu-wrap"><button className="icon-button" onClick={() => setOverflow((shown) => !shown)} aria-label="More note actions"><Icon name="dots" /></button>
                {overflow && <div className="pop-menu note-menu">
                  {current.deletedAt ? <><button onClick={() => void restoreCurrent()}><Icon name="undo" />Restore</button><button className="danger" onClick={() => void deleteCurrent()}><Icon name="trash" />Delete permanently</button></> : <><div className="submenu-wrap"><button onClick={() => setMoveMenu((shown) => !shown)}><Icon name="folder" />Move to…<Icon name="chevronDown" size={15} /></button>{moveMenu && <div className="sub-menu"><button onClick={() => void moveTo(null)}>Uncategorized</button>{categories.map((category) => <button onClick={() => void moveTo(category.id)} key={category.id}>{category.name}</button>)}</div>}</div><button onClick={() => void duplicateCurrent()}><Icon name="copy" />Duplicate</button><button onClick={() => void copy(current.body, "Markdown copied")}><Icon name="file" />Copy Markdown</button><button className="danger" onClick={() => void trashCurrent()}><Icon name="trash" />Move to Trash</button></>}
                </div>}
              </div>
            </div>
          </header>
          {current.deletedAt ? <div className="trashed-note"><div><Icon name="trash" size={20} /><strong>This note is in Trash</strong><span>It will be permanently removed after 30 days.</span></div><button className="primary-button" onClick={() => void restoreCurrent()}>Restore Note</button></div> : <>
            <div className="title-wrap"><input className="note-title" value={current.title} onChange={(event) => changeCurrent({ title: event.target.value })} placeholder="Title" aria-label="Note title" /><span className="autosave">Saved locally</span></div>
            <div className="editor-controls">
              <div className="format-tools" aria-label="Markdown formatting"><button onClick={() => applyFormat("heading")} title="Heading">H</button><button onClick={() => applyFormat("bold")} title="Bold"><b>B</b></button><button onClick={() => applyFormat("link")} title="Link"><Icon name="link" size={16} /></button><button onClick={() => applyFormat("checklist")} title="Checklist"><Icon name="check" size={16} /></button><button onClick={() => applyFormat("code")} title="Code"><Icon name="code" size={16} /></button><button onClick={() => void addImage()} title="Add image"><Icon name="paperclip" size={16} /></button></div>
              <div className="mode-switch" role="group" aria-label="Editor mode"><button className={display === "write" ? "selected" : ""} onClick={() => setDisplay("write")}>Write</button><button className={display === "preview" ? "selected" : ""} onClick={() => setDisplay("preview")}>Preview</button><button className={display === "split" ? "selected split-button" : "split-button"} onClick={() => setDisplay("split")}><Icon name="split" size={14} /><span>Split</span></button></div>
            </div>
            <div className={`document ${display}`}>
              {(display === "write" || display === "split") && <div className="writing-surface"><MarkdownEditor value={current.body} onChange={(body) => changeCurrent({ body })} onReady={(view) => { editor.current = view; }} /></div>}
              {(display === "preview" || display === "split") && <article className="markdown-preview" onClick={toggleTask} dangerouslySetInnerHTML={{ __html: renderMarkdown(current.body || "_Nothing written yet._") }} />}
            </div>
          </>}
        </> : <EmptyNote onCreate={createNote} activePlace={activePlace} />}
      </section>
      {notice && <button className="toast" onClick={() => setNotice(null)}><Icon name="check" size={16} />{notice}</button>}
    </main>
  );
}

function EmptyNote({ onCreate, activePlace }: { onCreate: () => void; activePlace: ActivePlace }) {
  if (activePlace === "trash") return <div className="empty-note"><Icon name="trash" size={30} /><h2>Your trash is empty</h2><p>Notes you delete stay here for 30 days.</p></div>;
  return <div className="empty-note"><span className="paper-glyph">✦</span><h2>A quiet place for every thought.</h2><p>Notes are private, stored locally, and written in ordinary Markdown.</p><button className="primary-button" onClick={onCreate}><Icon name="plus" size={17} />New note</button></div>;
}

function Settings({ onExport }: { onExport: () => void }) {
  return <div className="settings"><header><span className="eyebrow">Notebook</span><h1>Settings</h1><p>Your notes live on this device and are always yours to take with you.</p></header><section><div><strong>Export your notebook</strong><span>Create a ZIP of readable Markdown files, organized by category.</span></div><button className="secondary-button" onClick={onExport}><Icon name="archive" size={17} />Export Markdown</button></section><section><div><strong>Private by default</strong><span>No account, server, or tracking is needed to write and organize your notes.</span></div><span className="status-pill"><i />Stored locally</span></section><section><div><strong>Appearance</strong><span>Papyrus follows your system light or dark appearance.</span></div><Icon name="sun" /></section></div>;
}

export default App;
