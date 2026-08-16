import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { renderMarkdown } from "../lib/markdown";
import { imageFilesFrom, readImageFile } from "../lib/images";

type Menu = { left: number; top: number } | null;
type Props = {
  value: string;
  onChange: (markdown: string) => void;
  onInsertImage: () => Promise<string | null>;
  onNotice?: (message: string) => void;
};

const blockSelector = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre";
const commitDelay = 120;
const maxCommitDelay = 400;

function inlineMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent || "").replace(/\uFEFF/g, "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as HTMLElement;
  const children = Array.from(element.childNodes).map(inlineMarkdown).join("");
  switch (element.tagName) {
    case "STRONG": case "B": return `**${children}**`;
    case "EM": case "I": return `*${children}*`;
    case "CODE": return `\`${element.textContent || ""}\``;
    case "A": return `[${children}](${element.getAttribute("href") || ""})`;
    case "IMG": return `![${element.getAttribute("alt") || "Image"}](${element.getAttribute("src") || ""})`;
    case "BR": return "\n";
    case "INPUT": return "";
    default: return children;
  }
}

function blockMarkdown(element: HTMLElement): string {
  const inline = () => Array.from(element.childNodes).map(inlineMarkdown).join("").trim();
  switch (element.tagName) {
    case "H1": return `# ${inline()}\n\n`;
    case "H2": return `## ${inline()}\n\n`;
    case "H3": return `### ${inline()}\n\n`;
    case "H4": return `#### ${inline()}\n\n`;
    case "H5": return `##### ${inline()}\n\n`;
    case "H6": return `###### ${inline()}\n\n`;
    case "P": return `${inline()}\n\n`;
    case "PRE": return `\`\`\`\n${element.textContent?.replace(/\n$/, "") || ""}\n\`\`\`\n\n`;
    case "BLOCKQUOTE": return `${(element.textContent || "").split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    case "UL": return Array.from(element.children).filter((child) => child.tagName === "LI").map((child) => {
      const item = child as HTMLElement;
      const check = item.querySelector<HTMLInputElement>('input[type="checkbox"]');
      const content = Array.from(item.childNodes).filter((node) => !(node instanceof HTMLInputElement)).map(inlineMarkdown).join("").trim();
      return check ? `- [${check.checked ? "x" : " "}] ${content}` : `- ${content}`;
    }).join("\n") + "\n\n";
    case "OL": return Array.from(element.children).filter((child) => child.tagName === "LI").map((child, index) => `${index + 1}. ${inlineMarkdown(child).trim()}`).join("\n") + "\n\n";
    case "HR": return "---\n\n";
    case "TABLE": {
      const rows = Array.from(element.querySelectorAll("tr"));
      if (!rows.length) return "";
      const cells = rows.map((row) => Array.from(row.children).map((cell) => inlineMarkdown(cell).trim()));
      const divider = cells[0].map(() => "---");
      return [cells[0], divider, ...cells.slice(1)].map((row) => `| ${row.join(" | ")} |`).join("\n") + "\n\n";
    }
    case "DIV": return Array.from(element.children).map((child) => blockMarkdown(child as HTMLElement)).join("");
    default: return `${inline()}\n\n`;
  }
}

function markdownFromPaper(root: HTMLElement) {
  if (!root.children.length) return (root.textContent || "").trimEnd();
  return Array.from(root.children).map((element) => blockMarkdown(element as HTMLElement)).join("").replace(/\n{3,}/g, "\n\n").trimEnd();
}

function closestBlock(node: Node | null) {
  const element = node instanceof HTMLElement ? node : node?.parentElement;
  return element?.closest<HTMLElement>(blockSelector) || null;
}

function placeCaretAtEnd(element: HTMLElement) {
  const selection = window.getSelection(); const range = document.createRange();
  range.selectNodeContents(element); range.collapse(false); selection?.removeAllRanges(); selection?.addRange(range);
}

function placeCaretInText(text: Text) {
  const selection = window.getSelection(); const range = document.createRange();
  range.setStart(text, text.data.length); range.collapse(true); selection?.removeAllRanges(); selection?.addRange(range);
}

export default function PaperEditor({ value, onChange, onInsertImage, onNotice }: Props) {
  const paper = useRef<HTMLElement>(null);
  const [dragActive, setDragActive] = useState(false);
  // Start unset so a note opened directly into paper mode is rendered on mount.
  const knownValue = useRef<string | null>(null);
  const savedSelection = useRef<Range | null>(null);
  const pendingCommit = useRef<number | null>(null);
  const dirtySince = useRef<number | null>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<Menu>(null);

  useEffect(() => {
    if (!paper.current || value === knownValue.current) return;
    paper.current.innerHTML = renderMarkdown(value);
    knownValue.current = value;
  }, [value]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: MouseEvent) => {
      if (!menuElement.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", dismiss); document.removeEventListener("keydown", escape); };
  }, [menu]);

  // Keep the menu on-screen: opened at the tap point it can run off the right or
  // bottom edge (badly, on a narrow phone). Measure it and nudge it back inside.
  useLayoutEffect(() => {
    if (!menu || !menuElement.current) return;
    const rect = menuElement.current.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(menu.left, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(menu.top, window.innerHeight - rect.height - margin));
    if (Math.abs(left - menu.left) > 0.5 || Math.abs(top - menu.top) > 0.5) setMenu({ left, top });
  }, [menu]);

  const commit = () => {
    if (pendingCommit.current !== null) {
      window.clearTimeout(pendingCommit.current);
      pendingCommit.current = null;
    }
    dirtySince.current = null;
    if (!paper.current) return;
    const markdown = markdownFromPaper(paper.current);
    if (markdown === knownValue.current) return;
    knownValue.current = markdown;
    onChange(markdown);
  };

  // DOM → Markdown serialization walks the full document. Keep it off the immediate
  // input/keydown path and coalesce a burst of keystrokes, but cap the delay so the
  // React model and autosave never trail a long typing session by more than ~400ms.
  const scheduleCommit = () => {
    const now = performance.now();
    if (dirtySince.current === null) dirtySince.current = now;
    if (pendingCommit.current !== null) window.clearTimeout(pendingCommit.current);
    const elapsed = now - dirtySince.current;
    const delay = elapsed >= maxCommitDelay ? 0 : Math.min(commitDelay, maxCommitDelay - elapsed);
    pendingCommit.current = window.setTimeout(() => {
      pendingCommit.current = null;
      commit();
    }, delay);
  };

  useEffect(() => () => {
    if (pendingCommit.current !== null) window.clearTimeout(pendingCommit.current);
  }, []);

  // Insert dropped/pasted images at the caret. `caret` places the caret first (used by
  // drop, where the caret should land where the file was released).
  const insertImageFiles = async (files: File[], caret?: Range | null) => {
    if (!files.length || !paper.current) return;
    paper.current.focus();
    if (caret) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(caret);
    }
    for (const file of files) {
      try {
        const source = await readImageFile(file);
        document.execCommand("insertImage", false, source);
      } catch (error) {
        onNotice?.(error instanceof Error ? error.message : "Could not add that image.");
      }
    }
    scheduleCommit();
  };

  const rememberSelection = () => {
    const selection = window.getSelection();
    if (!paper.current || !selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const ancestor = range.commonAncestorContainer;
    if (ancestor !== paper.current && !paper.current.contains(ancestor)) return;
    savedSelection.current = range.cloneRange();
  };

  const restoreSelection = () => {
    const selection = window.getSelection();
    const range = savedSelection.current;
    if (!selection || !range || !paper.current) return;
    const ancestor = range.commonAncestorContainer;
    if (ancestor !== paper.current && !paper.current.contains(ancestor)) return;
    selection.removeAllRanges(); selection.addRange(range);
  };

  const selectedBlock = () => {
    const selection = window.getSelection();
    let block = closestBlock(selection?.anchorNode || null);
    if (block || !paper.current || !paper.current.textContent) return block;
    // Only wrap loose text into a paragraph when there is no block structure yet.
    // Never collapse existing blocks — that happens when the caret sits outside any
    // block (e.g. right after toggling a checkbox) and would merge the title away.
    if (paper.current.children.length) return block;
    block = document.createElement("p");
    while (paper.current.firstChild) block.append(paper.current.firstChild);
    paper.current.append(block); placeCaretAtEnd(block);
    return block;
  };

  // Every leaf block the current selection touches, in document order. A collapsed
  // caret yields the single block it sits in; a range spanning several lines yields
  // them all — which is what lets one "Checklist" tap convert a whole list.
  const selectedBlocks = (): HTMLElement[] => {
    const selection = window.getSelection();
    if (!paper.current || !selection?.rangeCount) {
      const single = selectedBlock();
      return single ? [single] : [];
    }
    const range = selection.getRangeAt(0);
    const all = Array.from(paper.current.querySelectorAll<HTMLElement>(blockSelector)).filter((block) => range.intersectsNode(block));
    // Drop container blocks (e.g. a blockquote wrapping selected paragraphs) so we
    // only act on the leaves and never convert the same text twice.
    const leaves = all.filter((block) => !all.some((other) => other !== block && block.contains(other)));
    if (leaves.length) return leaves;
    const single = selectedBlock();
    return single ? [single] : [];
  };

  const ensureCheckbox = (item: HTMLElement, checked = false) => {
    let check = item.querySelector<HTMLInputElement>(':scope > input[type="checkbox"]');
    if (!check) {
      check = document.createElement("input"); check.type = "checkbox"; check.contentEditable = "false";
      item.insertBefore(check, item.firstChild);
    }
    check.checked = checked || check.checked;
    item.classList.add("task-list-item");
  };

  // Build a checklist <li> from any block, carrying its inline content (bold, links,
  // etc.) across rather than flattening to plain text.
  const buildTaskItem = (block: HTMLElement): HTMLLIElement => {
    const item = document.createElement("li"); item.className = "task-list-item";
    const check = document.createElement("input"); check.type = "checkbox"; check.contentEditable = "false";
    const existing = block.querySelector<HTMLInputElement>(':scope > input[type="checkbox"]');
    check.checked = existing?.checked ?? false;
    item.append(check);
    const content = Array.from(block.childNodes).filter((node) => !(node instanceof HTMLInputElement && node.type === "checkbox"));
    if (content.some((node) => (node.textContent || "").trim())) content.forEach((node) => item.append(node));
    else item.append(document.createTextNode("\uFEFF"));
    return item;
  };

  // Merge runs of adjacent top-level <ul> siblings so converting several paragraphs
  // yields one checklist rather than a stack of single-item lists.
  const mergeAdjacentLists = (root: HTMLElement) => {
    let child = root.firstElementChild;
    while (child) {
      const next = child.nextElementSibling;
      if (child.tagName === "UL" && next?.tagName === "UL") {
        while (next.firstChild) child.append(next.firstChild);
        next.remove();
        continue;
      }
      child = next;
    }
  };

  // Returns the task items this block produced, so the caller can land the caret
  // on the real conversion rather than hunting for the last checklist in the note.
  const convertBlockToTask = (block: HTMLElement, processedLists: Set<HTMLElement>): HTMLElement[] => {
    const parent = block.parentElement;
    if (block.tagName === "LI" && parent?.tagName === "UL") { ensureCheckbox(block); return [block]; }
    if (block.tagName === "LI" && parent?.tagName === "OL") {
      // A numbered list can't carry checkboxes in Markdown, so convert the whole
      // list to a bulleted checklist (once, however many of its items were caught).
      if (processedLists.has(parent)) return [];
      processedLists.add(parent);
      const list = document.createElement("ul");
      const items = Array.from(parent.children).filter((child) => child.tagName === "LI") as HTMLElement[];
      items.forEach((item) => { ensureCheckbox(item); list.append(item); });
      parent.replaceWith(list);
      return items;
    }
    const list = document.createElement("ul");
    const item = buildTaskItem(block);
    list.append(item);
    block.replaceWith(list);
    return [item];
  };

  const applyChecklist = () => {
    const blocks = selectedBlocks();
    if (!blocks.length || !paper.current) return;
    const processedLists = new Set<HTMLElement>();
    const converted = blocks.flatMap((block) => convertBlockToTask(block, processedLists));
    mergeAdjacentLists(paper.current);
    const last = converted[converted.length - 1];
    if (last?.isConnected) placeCaretAtEnd(last);
  };

  const promoteToChecklist = (block: HTMLElement, text: string, checked = false) => {
    const check = document.createElement("input"); check.type = "checkbox"; check.checked = checked; check.contentEditable = "false";
    // A zero-width cursor host keeps the caret visibly after a fresh checkbox.
    // It is stripped during Markdown serialization.
    const taskText = document.createTextNode(text || "\uFEFF");
    if (block.tagName === "LI" && block.parentElement?.tagName === "UL") {
      block.className = "task-list-item";
      block.replaceChildren(check, taskText);
      placeCaretInText(taskText);
      return;
    }
    const list = document.createElement("ul"); const item = document.createElement("li");
    item.className = "task-list-item";
    item.append(check, taskText); list.append(item); block.replaceWith(list); placeCaretInText(taskText);
  };

  // Copy/Cut/Paste live in the paper menu because long-press hands us a context
  // menu instead of the browser's native selection toolbar — without these there
  // is no way to copy from the note on a touch device.
  const runClipboard = async (command: "cut" | "copy" | "paste" | "selectall") => {
    if (!paper.current) return;
    if (command === "selectall") {
      const range = document.createRange(); range.selectNodeContents(paper.current);
      const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      return;
    }
    if (command === "paste") {
      try {
        const text = await navigator.clipboard.readText();
        if (text) document.execCommand("insertText", false, text);
      } catch { onNotice?.("Pasting isn't available here — try a long-press paste."); }
      scheduleCommit();
      return;
    }
    try { document.execCommand(command); } catch { onNotice?.(command === "cut" ? "Couldn't cut that selection." : "Couldn't copy that selection."); }
    if (command === "cut") scheduleCommit();
  };

  type Command = "p" | "h1" | "h2" | "h3" | "bold" | "italic" | "link" | "code" | "bullets" | "numbers" | "checklist" | "image" | "cut" | "copy" | "paste" | "selectall";

  const useCommand = async (command: Command) => {
    restoreSelection(); paper.current?.focus();
    if (command === "cut" || command === "copy" || command === "paste" || command === "selectall") {
      await runClipboard(command);
      if (command !== "selectall") setMenu(null);
      return;
    }
    if (command === "checklist") applyChecklist();
    else if (command === "bullets") document.execCommand("insertUnorderedList");
    else if (command === "numbers") document.execCommand("insertOrderedList");
    else if (command === "bold" || command === "italic") document.execCommand(command);
    else if (command === "link") {
      const address = window.prompt("Link address");
      if (address) document.execCommand("createLink", false, address);
    } else if (command === "code") document.execCommand("formatBlock", false, "pre");
    else if (command === "image") {
      const image = await onInsertImage();
      if (image) document.execCommand("insertImage", false, image);
    } else document.execCommand("formatBlock", false, command);
    setMenu(null); scheduleCommit();
  };

  const applyShortcut = () => {
    const block = selectedBlock();
    if (!block) return;
    const text = (block.textContent || "").replace(/\uFEFF/g, "");
    const heading = block.tagName === "P" ? text.match(/^(#{1,3}) (.*)$/) : null;
    if (heading) {
      const replacement = document.createElement(`h${heading[1].length}`);
      if (heading[2]) replacement.textContent = heading[2];
      else replacement.innerHTML = "<br>";
      block.replaceWith(replacement); placeCaretAtEnd(replacement); return;
    }
    const task = text.match(/^- \[([ xX])\] (.*)$/);
    if (task) {
      promoteToChecklist(block, task[2], task[1].toLowerCase() === "x");
    }
  };

  const continueChecklist = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    const item = selectedBlock();
    if (item && /^H[1-6]$/.test(item.tagName)) {
      event.preventDefault();
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!range.collapsed) range.deleteContents();
      const trailing = document.createRange();
      trailing.selectNodeContents(item); trailing.setStart(range.startContainer, range.startOffset);
      const paragraph = document.createElement("p");
      const cursor = document.createTextNode("\uFEFF");
      paragraph.append(cursor, trailing.extractContents()); item.after(paragraph);
      placeCaretInText(cursor); scheduleCommit(); return;
    }
    if (item?.tagName !== "LI" || !item.querySelector('input[type="checkbox"]')) return;
    const list = item.parentElement;
    if (list?.tagName !== "UL") return;
    event.preventDefault();
    const text = (item.textContent || "").replace(/\uFEFF/g, "").trim();
    if (!text) {
      const paragraph = document.createElement("p"); const cursor = document.createTextNode("\uFEFF");
      paragraph.append(cursor); item.remove();
      if (list.children.length) list.after(paragraph); else list.replaceWith(paragraph);
      placeCaretInText(cursor); scheduleCommit(); return;
    }
    const next = document.createElement("li"); const check = document.createElement("input");
    const cursor = document.createTextNode("\uFEFF");
    next.className = "task-list-item"; check.type = "checkbox"; check.contentEditable = "false";
    next.append(check, cursor); list.insertBefore(next, item.nextSibling); placeCaretInText(cursor); scheduleCommit();
  };

  return <>
    <article
      className={`paper-editor markdown-preview${dragActive ? " drag-active" : ""}`}
      ref={paper}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-placeholder="Begin with a thought…"
      onDragOver={(event: ReactDragEvent) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        if (!dragActive) setDragActive(true);
      }}
      onDragLeave={(event: ReactDragEvent) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragActive(false);
      }}
      onDrop={(event: ReactDragEvent) => {
        const files = imageFilesFrom(event.dataTransfer);
        setDragActive(false);
        if (!files.length) return;
        event.preventDefault();
        const point = document.caretRangeFromPoint?.(event.clientX, event.clientY) ?? null;
        void insertImageFiles(files, point);
      }}
      onPaste={(event: ReactClipboardEvent) => {
        const files = imageFilesFrom(event.clipboardData);
        if (!files.length) return;
        event.preventDefault();
        void insertImageFiles(files);
      }}
      onInput={(event) => {
        // A checkbox toggle bubbles an input event whose caret sits outside any block;
        // running the shortcut pass there would reflow the document. It commits via onClick.
        if ((event.target as HTMLElement).matches('input[type="checkbox"]')) return;
        applyShortcut(); scheduleCommit();
      }}
      onBlur={commit}
      onKeyDown={continueChecklist}
      onKeyUp={rememberSelection}
      onMouseUp={rememberSelection}
      onPointerDown={(event) => {
        // Ticking a checkbox shouldn't pull focus into the editable text — on a
        // phone that pops the keyboard and drops the caret onto the tapped line
        // (often the title). Suppressing pointerdown keeps focus and the caret put;
        // the box still flips on click, which we persist below.
        if ((event.target as HTMLElement).matches('input[type="checkbox"]')) event.preventDefault();
      }}
      onClick={(event) => {
        if (!(event.target as HTMLElement).matches('input[type="checkbox"]')) return;
        scheduleCommit();
      }}
      onContextMenu={(event) => { event.preventDefault(); rememberSelection(); setMenu({ left: event.clientX, top: event.clientY }); }}
    />
    {menu && <div className="paper-menu" ref={menuElement} style={{ left: menu.left, top: menu.top }} onMouseDown={(event) => event.preventDefault()}>
      <div className="paper-menu-section"><button onClick={() => void useCommand("cut")}>Cut</button><button onClick={() => void useCommand("copy")}>Copy</button><button onClick={() => void useCommand("paste")}>Paste</button><button onClick={() => void useCommand("selectall")}>Select all</button></div>
      <div className="paper-menu-section"><button onClick={() => void useCommand("p")}>Paragraph</button><button onClick={() => void useCommand("h1")}>Heading 1</button><button onClick={() => void useCommand("h2")}>Heading 2</button><button onClick={() => void useCommand("h3")}>Heading 3</button></div>
      <div className="paper-menu-section"><button onClick={() => void useCommand("checklist")}>Checklist</button><button onClick={() => void useCommand("bullets")}>Bulleted list</button><button onClick={() => void useCommand("numbers")}>Numbered list</button></div>
      <div className="paper-menu-section"><button onClick={() => void useCommand("bold")}><b>Bold</b></button><button onClick={() => void useCommand("italic")}><i>Italic</i></button><button onClick={() => void useCommand("link")}>Link…</button><button onClick={() => void useCommand("code")}>Code block</button><button onClick={() => void useCommand("image")}>Add image…</button></div>
    </div>}
  </>;
}