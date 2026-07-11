import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";

const markdown = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: true }).use(taskLists, {
  enabled: true,
  label: true,
  labelAfter: true,
});

export function renderMarkdown(source: string) {
  return markdown.render(source);
}

export function renderedText(source: string) {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdown(source);
  return div.textContent || "";
}
