// Inline images are always stored as base64 data URLs in the note body, on both
// web and native (see embed_image in src-tauri/src/lib.rs). These helpers keep the
// file picker, drag-and-drop, and paste paths validating the same way.

const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE_SIZE = 4 * 1024 * 1024;

export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_TYPES.has(file.type)) { reject(new Error("Choose a PNG, JPEG, GIF, or WebP image.")); return; }
    if (file.size > MAX_INLINE_IMAGE_SIZE) { reject(new Error("Choose an image smaller than 4 MB for inline use.")); return; }
    const reader = new FileReader();
    reader.onload = () => (typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read that image.")));
    reader.onerror = () => reject(new Error("Could not read that image."));
    reader.readAsDataURL(file);
  });
}

export function imageFilesFrom(transfer: DataTransfer | null): File[] {
  if (!transfer) return [];
  const files = Array.from(transfer.files || []).filter((file) => file.type.startsWith("image/"));
  if (files.length) return files;
  // Pasted screenshots often arrive as items rather than files.
  return Array.from(transfer.items || [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
}
