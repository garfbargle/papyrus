import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { renderMarkdown } from "../lib/markdown";

type Menu = { left: number; top: number } | null;
type Props = {
  value: string;
  onChange: (markdown: string) => void;
  onInsertImage: () => Promise<string | null>;
};

const blockSelector = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre";

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

export default function PaperEditor({ value, onChange, onInsertImage }: Props) {
  const paper = useRef<HTMLElement>(null);
  // Start unset so a note opened directly into paper mode is rendered on mount.
  const knownValue = useRef<string | null>(null);
  const savedSelection = useRef<Range | null>(null);
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

  const commit = () => {
    if (!paper.current) return;
    const markdown = markdownFromPaper(paper.current);
    knownValue.current = markdown;
    onChange(markdown);
  };

  const rememberSelection = () => {
    const selection = window.getSelection();
    if (selection?.rangeCount) savedSelection.current = selection.getRangeAt(0).cloneRange();
  };

  const restoreSelection = () => {
    const selection = window.getSelection();
    if (!selection || !savedSelection.current) return;
    selection.removeAllRanges(); selection.addRange(savedSelection.current);
  };

  const selectedBlock = () => {
    const selection = window.getSelection();
    let block = closestBlock(selection?.anchorNode || null);
    if (block || !paper.current || !paper.current.textContent) return block;
    block = document.createElement("p");
    while (paper.current.firstChild) block.append(paper.current.firstChild);
    paper.current.append(block); placeCaretAtEnd(block);
    return block;
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

  const replaceWithChecklist = () => {
    const block = selectedBlock();
    if (block) promoteToChecklist(block, block.textContent || "");
  };

  const useCommand = async (command: "p" | "h1" | "h2" | "h3" | "bold" | "italic" | "link" | "code" | "bullets" | "numbers" | "checklist" | "image") => {
    restoreSelection(); paper.current?.focus();
    if (command === "checklist") replaceWithChecklist();
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
    setMenu(null); requestAnimationFrame(commit);
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
      placeCaretInText(cursor); commit(); return;
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
      placeCaretInText(cursor); commit(); return;
    }
    const next = document.createElement("li"); const check = document.createElement("input");
    const cursor = document.createTextNode("\uFEFF");
    next.className = "task-list-item"; check.type = "checkbox"; check.contentEditable = "false";
    next.append(check, cursor); list.insertBefore(next, item.nextSibling); placeCaretInText(cursor); commit();
  };

  return <>
    <article
      className="paper-editor markdown-preview"
      ref={paper}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      data-placeholder="Begin with a thought…"
      onInput={() => { applyShortcut(); commit(); }}
      onKeyDown={continueChecklist}
      onKeyUp={rememberSelection}
      onMouseUp={rememberSelection}
      onClick={(event) => { if ((event.target as HTMLElement).matches('input[type="checkbox"]')) window.setTimeout(commit, 0); }}
      onContextMenu={(event) => { event.preventDefault(); rememberSelection(); setMenu({ left: event.clientX, top: event.clientY }); }}
    />
    {menu && <div className="paper-menu" ref={menuElement} style={{ left: menu.left, top: menu.top }} onMouseDown={(event) => event.preventDefault()}>
      <div className="paper-menu-section"><button onClick={() => void useCommand("p")}>Paragraph</button><button onClick={() => void useCommand("h1")}>Heading 1</button><button onClick={() => void useCommand("h2")}>Heading 2</button><button onClick={() => void useCommand("h3")}>Heading 3</button></div>
      <div className="paper-menu-section"><button onClick={() => void useCommand("checklist")}>Checklist</button><button onClick={() => void useCommand("bullets")}>Bulleted list</button><button onClick={() => void useCommand("numbers")}>Numbered list</button></div>
      <div className="paper-menu-section"><button onClick={() => void useCommand("bold")}><b>Bold</b></button><button onClick={() => void useCommand("italic")}><i>Italic</i></button><button onClick={() => void useCommand("link")}>Link…</button><button onClick={() => void useCommand("code")}>Code block</button><button onClick={() => void useCommand("image")}>Add image…</button></div>
    </div>}
  </>;
}
