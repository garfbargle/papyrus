import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";

// No `label`/`labelAfter`: that mode drops the item's last inline token and
// re-emits the item's *raw* Markdown inside a <label>, so any checklist item
// carrying inline formatting rendered its text twice ("Call **Bob** about the
// thing" → "Call Bob Call **Bob** about the thing"), and a link left an unclosed
// <a>. The paper editor serializes the DOM back to Markdown, so that duplication
// saved itself into the note. Nothing styles the label — the checkbox is clickable
// on its own — so the wrapper only ever cost us.
const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: true }).use(taskLists, {
  enabled: true,
});

export function renderMarkdown(source: string) {
  return markdown.render(source);
}

export function renderedText(source: string) {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdown(source);
  return div.textContent || "";
}
