export function relativeTime(timestamp: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 45) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.round(seconds / 86400)}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(timestamp));
}

export function plainPreview(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!?(\[[^\]]*\]\([^)]*\))/g, "$1")
    .replace(/[>#*_`|]/g, "")
    .replace(/- \[[ xX]\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function titleFromMarkdown(markdown: string) {
  const firstLine = markdown
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "")
    .split(/\r?\n/)
    .find((line) => line.trim());

  if (!firstLine) return "";

  return firstLine
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, "$1")
    .replace(/(`+)(.*?)\1/g, "$2")
    .replace(/(\*{1,3}|_{1,3}|~~)(.*?)\1/g, "$2")
    .replace(/\\([\\`*{}\[\]<>#+\-.!_])/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

export function previewFromMarkdown(markdown: string) {
  const lines = markdown.split(/\r?\n/);
  const firstContent = lines.findIndex((line) => line.trim());
  return plainPreview(firstContent === -1 ? "" : lines.slice(firstContent + 1).join("\n"));
}

export function noteTitle(note: Pick<import("../types").Note, "title"> & { body?: string }) {
  return titleFromMarkdown(note.body || "") || note.title.trim() || "Untitled note";
}
