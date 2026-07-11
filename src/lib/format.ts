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

export function noteTitle(note: Pick<import("../types").Note, "title"> & { body?: string }) {
  return note.title.trim() || plainPreview(note.body || "").slice(0, 54) || "Untitled note";
}
