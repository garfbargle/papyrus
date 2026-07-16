// Local notebook store for the web client — the IndexedDB analogue of the
// SQLite notebook + sync bookkeeping in `src-tauri/src/lib.rs`. It owns:
//   - the working copies of notes/categories the UI reads;
//   - the revision DAG (parent-linked) used for conflict detection;
//   - entity heads, tombstones, device authorizations, the outbox, receipts,
//     and conflict records.
//
// Every local mutation records a revision and enqueues an encrypted operation
// (mirrors `record_revision` / `enqueue_operation`). Remote operations are
// applied via `applyRemoteOperation` with the same ancestry-based conflict
// rules as `apply_remote_note` / `apply_remote_category`.

import type { Category, ConflictVersion, Note, NoteConflict, NoteListItem } from "../../types";
import { previewFromMarkdown, titleFromMarkdown } from "../format";
import {
  agreementPublicKey,
  contentHash,
  decodeBase64Url,
  encodeBase64Url,
  encryptOperation,
  signingPublicKey,
  type SyncEnvelope,
} from "./crypto.js";
import type {
  CategoryRevisionState,
  DeviceAuthorization,
  DeviceRevocation,
  NoteRevisionState,
  SyncOperation,
  VaultKeyRotation,
} from "./operations.js";
import type { WebIdentity } from "./identity.js";
import { idbGet, idbGetAll, idbPut, idbWrite, type StoreName } from "./idb.js";

// --- Internal record shapes ---------------------------------------------------

interface NoteRecord {
  id: string;
  title: string;
  body: string;
  categoryId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revisionId: string;
}

interface CategoryRecord {
  id: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revisionId: string;
}

interface NoteRevisionRecord {
  revisionId: string;
  noteId: string;
  parentRevisionId: string | null;
  deviceId: string;
  contentHash: string;
  title: string;
  body: string;
  categoryId: string | null;
  createdAt: string; // = state.updatedAt (matches lib.rs column mapping)
  noteCreatedAt: string; // = state.createdAt
  updatedAt: string;
  deletedAt: string | null;
  purgedAt: string | null;
}

interface CategoryRevisionRecord {
  revisionId: string;
  categoryId: string;
  parentRevisionId: string | null;
  deviceId: string;
  contentHash: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

type EntityType = "note" | "category";
interface EntityHead {
  entityId: string; // `${entityType}:${id}`
  entityType: EntityType;
  revisionId: string;
}

interface DeviceRecord {
  id: string;
  displayName: string;
  signingKey: string; // base64url
  agreementKey: string; // base64url
  createdAt: string;
  isLocal: boolean;
  lastSeenAt: string | null;
}

interface DeviceAuthRecord {
  deviceId: string;
  authorizedAt: string;
  revokedAt: string | null;
}

export interface OutboxRecord {
  id: string;
  revisionId: string;
  packageId: string;
  envelope: SyncEnvelope;
  recipients: string[];
  state: "pending" | "uploaded" | "waiting_for_device";
  attempts: number;
  createdAt: string;
  nextRetryAt: string;
  lastError: string | null;
}

interface TombstoneRecord {
  entityId: string;
  entityType: EntityType;
  revisionId: string;
  deletedAt: string | null;
  purgedAt: string | null;
}

interface ConflictRecord {
  entityId: string;
  entityType: EntityType;
  currentRevisionId: string;
  otherRevisionId: string;
  status: "open" | "resolved";
  createdAt: string;
  resolvedAt: string | null;
}

const MAX_ANCESTRY_DEPTH = 10_000;

function now(): string {
  return new Date().toISOString();
}
function makeId(): string {
  return crypto.randomUUID();
}
function headKey(type: EntityType, id: string): string {
  return `${type}:${id}`;
}

// --- Read side (UI) -----------------------------------------------------------

export async function listCategories(): Promise<Category[]> {
  const rows = await idbGetAll<CategoryRecord>("categories");
  return rows
    .filter((row) => !row.deletedAt)
    .sort((a, b) => a.position - b.position)
    .map(({ id, name, position, createdAt, updatedAt }) => ({ id, name, position, createdAt, updatedAt }));
}

export async function listNotes(filter: string, search: string): Promise<NoteListItem[]> {
  const [notes, categories] = await Promise.all([
    idbGetAll<NoteRecord>("notes"),
    idbGetAll<CategoryRecord>("categories"),
  ]);
  const categoryName = (id: string | null) => categories.find((c) => c.id === id)?.name ?? null;
  const needle = search.trim().toLocaleLowerCase();
  return notes
    .filter((note) =>
      filter === "trash"
        ? Boolean(note.deletedAt)
        : filter === "all"
          ? !note.deletedAt
          : !note.deletedAt && note.categoryId === filter,
    )
    .filter(
      (note) =>
        !needle ||
        `${titleFromMarkdown(note.body) || note.title} ${note.body} ${categoryName(note.categoryId) ?? ""}`
          .toLocaleLowerCase()
          .includes(needle),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((note) => ({
      id: note.id,
      title: titleFromMarkdown(note.body) || note.title,
      categoryId: note.categoryId,
      categoryName: categoryName(note.categoryId),
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      deletedAt: note.deletedAt,
      revisionId: note.revisionId,
      preview: previewFromMarkdown(note.body),
    }));
}

export async function getNote(id: string): Promise<Note | null> {
  const note = await idbGet<NoteRecord>("notes", id);
  if (!note) return null;
  const category = note.categoryId ? await idbGet<CategoryRecord>("categories", note.categoryId) : null;
  return { ...note, categoryName: category?.name ?? null };
}

// --- Local mutations (record revision + enqueue) ------------------------------

async function authorizedRecipients(selfDeviceId: string): Promise<string[]> {
  const auths = await idbGetAll<DeviceAuthRecord>("deviceAuth");
  return auths.filter((a) => !a.revokedAt && a.deviceId !== selfDeviceId).map((a) => a.deviceId);
}

function buildOutbox(
  identity: WebIdentity,
  revisionId: string,
  operation: SyncOperation,
  recipients: string[],
): OutboxRecord {
  const envelope = encryptOperation(identity, operation);
  const timestamp = now();
  return {
    id: makeId(),
    revisionId,
    packageId: envelope.packageId,
    envelope,
    recipients,
    state: "pending",
    attempts: 0,
    createdAt: timestamp,
    nextRetryAt: timestamp,
    lastError: null,
  };
}

function noteRevisionOf(note: NoteRecord, parentRevisionId: string | null, deviceId: string): NoteRevisionRecord {
  return {
    revisionId: note.revisionId,
    noteId: note.id,
    parentRevisionId,
    deviceId,
    contentHash: contentHash(note.title, note.body, note.categoryId, note.deletedAt),
    title: note.title,
    body: note.body,
    categoryId: note.categoryId,
    createdAt: note.updatedAt,
    noteCreatedAt: note.createdAt,
    updatedAt: note.updatedAt,
    deletedAt: note.deletedAt,
    purgedAt: null,
  };
}

function noteOperationOf(revision: NoteRevisionRecord): SyncOperation {
  const state: NoteRevisionState = {
    id: revision.noteId,
    title: revision.title,
    body: revision.body,
    categoryId: revision.categoryId,
    createdAt: revision.noteCreatedAt,
    updatedAt: revision.updatedAt,
    deletedAt: revision.deletedAt,
    purgedAt: revision.purgedAt,
    revisionId: revision.revisionId,
    parentRevisionId: revision.parentRevisionId,
  };
  return { kind: "noteRevision", state };
}

// Record a new local note revision: writes the working copy, the revision node,
// the head, and the outbox package in one transaction.
async function recordNoteRevision(
  identity: WebIdentity,
  note: NoteRecord,
  parentRevisionId: string | null,
  options: { purgedAt?: string } = {},
): Promise<void> {
  const recipients = await authorizedRecipients(identity.deviceId);
  const revision = noteRevisionOf(note, parentRevisionId, identity.deviceId);
  if (options.purgedAt) revision.purgedAt = options.purgedAt;
  const operation = noteOperationOf(revision);
  const outbox = buildOutbox(identity, revision.revisionId, operation, recipients);
  const head: EntityHead = { entityId: headKey("note", note.id), entityType: "note", revisionId: note.revisionId };

  await idbWrite(["notes", "noteRevisions", "entityHeads", "outbox", "tombstones"], (tx) => {
    tx.objectStore("noteRevisions").put(revision);
    tx.objectStore("entityHeads").put(head);
    tx.objectStore("outbox").put(outbox);
    if (options.purgedAt) {
      tx.objectStore("notes").delete(note.id);
      const tombstone: TombstoneRecord = {
        entityId: headKey("note", note.id),
        entityType: "note",
        revisionId: note.revisionId,
        deletedAt: note.deletedAt,
        purgedAt: options.purgedAt,
      };
      tx.objectStore("tombstones").put(tombstone);
    } else {
      tx.objectStore("notes").put(note);
    }
  });
}

export async function saveNote(
  identity: WebIdentity,
  payload: { id: string; title: string; body: string; categoryId: string | null },
): Promise<Note> {
  const previous = await idbGet<NoteRecord>("notes", payload.id);
  const timestamp = now();
  const next: NoteRecord = {
    id: payload.id,
    title: titleFromMarkdown(payload.body) || payload.title,
    body: payload.body,
    categoryId: payload.categoryId,
    createdAt: previous?.createdAt ?? timestamp,
    updatedAt: timestamp,
    deletedAt: previous?.deletedAt ?? null,
    revisionId: makeId(),
  };
  await recordNoteRevision(identity, next, previous?.revisionId ?? null);
  return getNote(next.id) as Promise<Note>;
}

async function mutateNote(
  identity: WebIdentity,
  id: string,
  change: (note: NoteRecord) => void,
): Promise<void> {
  const previous = await idbGet<NoteRecord>("notes", id);
  if (!previous) return;
  const next: NoteRecord = { ...previous, updatedAt: now(), revisionId: makeId() };
  change(next);
  await recordNoteRevision(identity, next, previous.revisionId);
}

export async function moveNote(identity: WebIdentity, id: string, categoryId: string | null): Promise<void> {
  await mutateNote(identity, id, (note) => {
    note.categoryId = categoryId;
  });
}

export async function trashNote(identity: WebIdentity, id: string): Promise<void> {
  await mutateNote(identity, id, (note) => {
    note.deletedAt = now();
  });
}

export async function restoreNote(identity: WebIdentity, id: string): Promise<void> {
  await mutateNote(identity, id, (note) => {
    note.deletedAt = null;
  });
}

export async function deleteNotePermanently(identity: WebIdentity, id: string): Promise<void> {
  const previous = await idbGet<NoteRecord>("notes", id);
  if (!previous) return;
  const purgedAt = now();
  const tombstoned: NoteRecord = { ...previous, updatedAt: purgedAt, revisionId: makeId(), deletedAt: previous.deletedAt ?? purgedAt };
  await recordNoteRevision(identity, tombstoned, previous.revisionId, { purgedAt });
}

export async function emptyTrash(identity: WebIdentity): Promise<void> {
  const notes = await idbGetAll<NoteRecord>("notes");
  for (const note of notes.filter((n) => n.deletedAt)) {
    await deleteNotePermanently(identity, note.id);
  }
}

export async function duplicateNote(identity: WebIdentity, id: string): Promise<Note> {
  const source = await getNote(id);
  if (!source) throw new Error("Note not found");
  return saveNote(identity, {
    id: makeId(),
    title: `${source.title || "Untitled note"} copy`,
    body: source.body,
    categoryId: source.categoryId,
  });
}

// --- Category mutations -------------------------------------------------------

function categoryRevisionOf(
  category: CategoryRecord,
  parentRevisionId: string | null,
  deviceId: string,
): CategoryRevisionRecord {
  return {
    revisionId: category.revisionId,
    categoryId: category.id,
    parentRevisionId,
    deviceId,
    contentHash: contentHash(category.name, String(category.position), null, category.deletedAt),
    name: category.name,
    position: category.position,
    createdAt: category.updatedAt,
    updatedAt: category.updatedAt,
    deletedAt: category.deletedAt,
  };
}

function categoryOperationOf(revision: CategoryRevisionRecord): SyncOperation {
  const state: CategoryRevisionState = {
    id: revision.categoryId,
    name: revision.name,
    position: revision.position,
    createdAt: revision.createdAt,
    updatedAt: revision.updatedAt,
    deletedAt: revision.deletedAt,
    revisionId: revision.revisionId,
    parentRevisionId: revision.parentRevisionId,
  };
  return { kind: "categoryRevision", state };
}

async function recordCategoryRevision(
  identity: WebIdentity,
  category: CategoryRecord,
  parentRevisionId: string | null,
): Promise<void> {
  const recipients = await authorizedRecipients(identity.deviceId);
  const revision = categoryRevisionOf(category, parentRevisionId, identity.deviceId);
  const outbox = buildOutbox(identity, revision.revisionId, categoryOperationOf(revision), recipients);
  const head: EntityHead = {
    entityId: headKey("category", category.id),
    entityType: "category",
    revisionId: category.revisionId,
  };
  await idbWrite(["categories", "categoryRevisions", "entityHeads", "outbox"], (tx) => {
    tx.objectStore("categories").put(category);
    tx.objectStore("categoryRevisions").put(revision);
    tx.objectStore("entityHeads").put(head);
    tx.objectStore("outbox").put(outbox);
  });
}

export async function createCategory(identity: WebIdentity, name: string): Promise<Category> {
  const existing = await idbGetAll<CategoryRecord>("categories");
  const timestamp = now();
  const category: CategoryRecord = {
    id: makeId(),
    name: name.trim(),
    position: existing.filter((c) => !c.deletedAt).length,
    createdAt: timestamp,
    updatedAt: timestamp,
    deletedAt: null,
    revisionId: makeId(),
  };
  await recordCategoryRevision(identity, category, null);
  const { id, name: n, position, createdAt, updatedAt } = category;
  return { id, name: n, position, createdAt, updatedAt };
}

export async function renameCategory(identity: WebIdentity, id: string, name: string): Promise<Category> {
  const previous = await idbGet<CategoryRecord>("categories", id);
  if (!previous) throw new Error("Folder not found");
  const next: CategoryRecord = { ...previous, name: name.trim(), updatedAt: now(), revisionId: makeId() };
  await recordCategoryRevision(identity, next, previous.revisionId);
  const { position, createdAt, updatedAt } = next;
  return { id, name: next.name, position, createdAt, updatedAt };
}

export async function moveCategory(identity: WebIdentity, id: string, direction: -1 | 1): Promise<Category[]> {
  const ordered = (await idbGetAll<CategoryRecord>("categories"))
    .filter((c) => !c.deletedAt)
    .sort((a, b) => a.position - b.position);
  const index = ordered.findIndex((c) => c.id === id);
  const target = index + direction;
  if (index >= 0 && target >= 0 && target < ordered.length) {
    const a = { ...ordered[index], position: ordered[target].position, updatedAt: now(), revisionId: makeId() };
    const b = { ...ordered[target], position: ordered[index].position, updatedAt: now(), revisionId: makeId() };
    await recordCategoryRevision(identity, a, ordered[index].revisionId);
    await recordCategoryRevision(identity, b, ordered[target].revisionId);
  }
  return listCategories();
}

export async function deleteCategory(identity: WebIdentity, id: string): Promise<void> {
  const previous = await idbGet<CategoryRecord>("categories", id);
  if (!previous) return;
  const deleted: CategoryRecord = { ...previous, deletedAt: now(), updatedAt: now(), revisionId: makeId() };
  await recordCategoryRevision(identity, deleted, previous.revisionId);
  // Un-assign notes from the deleted category (each un-assignment is its own revision).
  const notes = await idbGetAll<NoteRecord>("notes");
  for (const note of notes.filter((n) => n.categoryId === id)) {
    await mutateNote(identity, note.id, (n) => {
      n.categoryId = null;
    });
  }
}

// --- Ancestry -----------------------------------------------------------------

async function isAncestor(
  store: "noteRevisions" | "categoryRevisions",
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  let current: string | null = descendant;
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth += 1) {
    if (current === ancestor) return true;
    if (!current) return false;
    const revision: { parentRevisionId: string | null } | undefined = await idbGet(store, current);
    if (!revision) return false;
    current = revision.parentRevisionId;
  }
  throw new Error("Revision history is too deep to compare.");
}

// --- Remote apply -------------------------------------------------------------

// Returns a VaultKeyRotation the caller must adopt, or null. Throws on
// out-of-order dependencies so the engine leaves the package un-acked for retry.
export async function applyRemoteOperation(
  identity: WebIdentity,
  envelope: SyncEnvelope,
  operation: SyncOperation,
): Promise<VaultKeyRotation | null> {
  if (await idbGet("receipts", envelope.packageId)) return null;

  let rotation: VaultKeyRotation | null = null;
  switch (operation.kind) {
    case "noteRevision":
      await applyRemoteNote(operation.state, envelope.senderDeviceId);
      break;
    case "categoryRevision":
      await applyRemoteCategory(operation.state, envelope.senderDeviceId);
      break;
    case "deviceAuthorization":
      await applyDeviceAuthorization(operation.state);
      break;
    case "deviceRevocation":
      await applyDeviceRevocation(operation.state);
      break;
    case "vaultKeyRotation":
      rotation = await applyVaultKeyRotation(identity, operation.state);
      break;
  }
  await idbPut("receipts", { packageId: envelope.packageId, receivedAt: now() });
  return rotation;
}

async function applyRemoteNote(state: NoteRevisionState, senderDeviceId: string): Promise<void> {
  if (await idbGet("noteRevisions", state.revisionId)) return; // dedup
  if (state.parentRevisionId && !(await idbGet("noteRevisions", state.parentRevisionId))) {
    throw new Error("A note package arrived before its parent revision.");
  }

  const revision: NoteRevisionRecord = {
    revisionId: state.revisionId,
    noteId: state.id,
    parentRevisionId: state.parentRevisionId,
    deviceId: senderDeviceId,
    contentHash: contentHash(state.title, state.body, state.categoryId, state.deletedAt),
    title: state.title,
    body: state.body,
    categoryId: state.categoryId,
    createdAt: state.updatedAt,
    noteCreatedAt: state.createdAt,
    updatedAt: state.updatedAt,
    deletedAt: state.deletedAt,
    purgedAt: state.purgedAt,
  };

  const head = await idbGet<EntityHead>("entityHeads", headKey("note", state.id));
  const decision = await decideApply("noteRevisions", head?.revisionId ?? null, state.revisionId, state.parentRevisionId);

  if (decision === "conflict") {
    const conflict: ConflictRecord = {
      entityId: headKey("note", state.id),
      entityType: "note",
      currentRevisionId: head!.revisionId,
      otherRevisionId: state.revisionId,
      status: "open",
      createdAt: now(),
      resolvedAt: null,
    };
    await idbWrite(["noteRevisions", "conflicts"], (tx) => {
      tx.objectStore("noteRevisions").put(revision);
      tx.objectStore("conflicts").put(conflict);
    });
    return;
  }

  if (decision === "skip") {
    await idbPut("noteRevisions", revision);
    return;
  }

  // apply: store revision, update working copy + head.
  await applyNoteWorkingCopy(revision);
}

// Decide how an incoming revision relates to the current head.
async function decideApply(
  store: "noteRevisions" | "categoryRevisions",
  head: string | null,
  incoming: string,
  incomingParent: string | null,
): Promise<"apply" | "skip" | "conflict"> {
  if (!head) return "apply";
  if (incomingParent === head) return "apply"; // fast-forward
  if (await isAncestor(store, head, incoming)) return "apply"; // incoming descends from head
  if (await isAncestor(store, incoming, head)) return "skip"; // incoming is stale
  return "conflict";
}

async function applyNoteWorkingCopy(revision: NoteRevisionRecord): Promise<void> {
  const tombstone = await idbGet<TombstoneRecord>("tombstones", headKey("note", revision.noteId));
  const head: EntityHead = { entityId: headKey("note", revision.noteId), entityType: "note", revisionId: revision.revisionId };

  if (revision.purgedAt) {
    const record: TombstoneRecord = {
      entityId: headKey("note", revision.noteId),
      entityType: "note",
      revisionId: revision.revisionId,
      deletedAt: revision.deletedAt,
      purgedAt: revision.purgedAt,
    };
    await idbWrite(["noteRevisions", "entityHeads", "notes", "tombstones"], (tx) => {
      tx.objectStore("noteRevisions").put(revision);
      tx.objectStore("entityHeads").put(head);
      tx.objectStore("notes").delete(revision.noteId);
      tx.objectStore("tombstones").put(record);
    });
    return;
  }

  // A purge tombstone permanently blocks resurrection.
  if (tombstone?.purgedAt) {
    await idbPut("noteRevisions", revision);
    await idbPut("entityHeads", head);
    return;
  }

  const note: NoteRecord = {
    id: revision.noteId,
    title: revision.title,
    body: revision.body,
    categoryId: revision.categoryId,
    createdAt: revision.noteCreatedAt,
    updatedAt: revision.updatedAt,
    deletedAt: revision.deletedAt,
    revisionId: revision.revisionId,
  };
  await idbWrite(["noteRevisions", "entityHeads", "notes"], (tx) => {
    tx.objectStore("noteRevisions").put(revision);
    tx.objectStore("entityHeads").put(head);
    tx.objectStore("notes").put(note);
  });
}

async function applyRemoteCategory(state: CategoryRevisionState, senderDeviceId: string): Promise<void> {
  if (await idbGet("categoryRevisions", state.revisionId)) return;
  if (state.parentRevisionId && !(await idbGet("categoryRevisions", state.parentRevisionId))) {
    throw new Error("A category package arrived before its parent revision.");
  }

  const revision: CategoryRevisionRecord = {
    revisionId: state.revisionId,
    categoryId: state.id,
    parentRevisionId: state.parentRevisionId,
    deviceId: senderDeviceId,
    contentHash: contentHash(state.name, String(state.position), null, state.deletedAt),
    name: state.name,
    position: state.position,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    deletedAt: state.deletedAt,
  };

  const head = await idbGet<EntityHead>("entityHeads", headKey("category", state.id));
  const decision = await decideApply(
    "categoryRevisions",
    head?.revisionId ?? null,
    state.revisionId,
    state.parentRevisionId,
  );

  if (decision === "conflict") {
    const conflict: ConflictRecord = {
      entityId: headKey("category", state.id),
      entityType: "category",
      currentRevisionId: head!.revisionId,
      otherRevisionId: state.revisionId,
      status: "open",
      createdAt: now(),
      resolvedAt: null,
    };
    await idbWrite(["categoryRevisions", "conflicts"], (tx) => {
      tx.objectStore("categoryRevisions").put(revision);
      tx.objectStore("conflicts").put(conflict);
    });
    return;
  }
  if (decision === "skip") {
    await idbPut("categoryRevisions", revision);
    return;
  }

  const category: CategoryRecord = {
    id: revision.categoryId,
    name: revision.name,
    position: revision.position,
    createdAt: revision.createdAt,
    updatedAt: revision.updatedAt,
    deletedAt: revision.deletedAt,
    revisionId: revision.revisionId,
  };
  const newHead: EntityHead = {
    entityId: headKey("category", revision.categoryId),
    entityType: "category",
    revisionId: revision.revisionId,
  };
  await idbWrite(["categoryRevisions", "entityHeads", "categories"], (tx) => {
    tx.objectStore("categoryRevisions").put(revision);
    tx.objectStore("entityHeads").put(newHead);
    tx.objectStore("categories").put(category);
  });
}

async function applyDeviceAuthorization(state: DeviceAuthorization): Promise<void> {
  const existing = await idbGet<DeviceRecord>("devices", state.deviceId);
  const device: DeviceRecord = {
    id: state.deviceId,
    displayName: state.displayName,
    signingKey: state.signingPublicKey,
    agreementKey: state.agreementPublicKey,
    createdAt: existing?.createdAt ?? state.authorizedAt,
    isLocal: existing?.isLocal ?? false,
    lastSeenAt: existing?.lastSeenAt ?? null,
  };
  const auth: DeviceAuthRecord = { deviceId: state.deviceId, authorizedAt: state.authorizedAt, revokedAt: null };
  await idbWrite(["devices", "deviceAuth"], (tx) => {
    tx.objectStore("devices").put(device);
    tx.objectStore("deviceAuth").put(auth);
  });
}

async function applyDeviceRevocation(state: DeviceRevocation): Promise<void> {
  const auth = await idbGet<DeviceAuthRecord>("deviceAuth", state.deviceId);
  if (!auth) return;
  await idbPut("deviceAuth", { ...auth, revokedAt: state.revokedAt });
}

async function applyVaultKeyRotation(identity: WebIdentity, state: VaultKeyRotation): Promise<VaultKeyRotation | null> {
  if (state.epoch <= identity.vaultKeyEpoch) return null;
  if (state.epoch !== identity.vaultKeyEpoch + 1) {
    throw new Error("A vault-key rotation arrived out of order.");
  }
  return state;
}

// --- Conflicts ----------------------------------------------------------------

async function conflictVersion(revisionId: string): Promise<ConflictVersion> {
  const revision = await idbGet<NoteRevisionRecord>("noteRevisions", revisionId);
  if (!revision) throw new Error("Conflict revision is unavailable.");
  const device = await idbGet<DeviceRecord>("devices", revision.deviceId);
  return {
    revisionId: revision.revisionId,
    title: revision.title,
    body: revision.body,
    categoryId: revision.categoryId,
    updatedAt: revision.updatedAt,
    deviceName: device?.displayName ?? "Another device",
    deletedAt: revision.deletedAt,
  };
}

export async function getNoteConflict(noteId: string): Promise<NoteConflict | null> {
  const conflict = await idbGet<ConflictRecord>("conflicts", headKey("note", noteId));
  if (!conflict || conflict.status !== "open") return null;
  const note = await idbGet<NoteRecord>("notes", noteId);
  const current: ConflictVersion = note
    ? {
        revisionId: note.revisionId,
        title: note.title,
        body: note.body,
        categoryId: note.categoryId,
        updatedAt: note.updatedAt,
        deviceName: "This device",
        deletedAt: note.deletedAt,
      }
    : await conflictVersion(conflict.currentRevisionId);
  return { id: conflict.entityId, noteId, current, other: await conflictVersion(conflict.otherRevisionId) };
}

export async function resolveNoteConflict(
  identity: WebIdentity,
  noteId: string,
  resolution: "current" | "other" | "both",
): Promise<Note> {
  const conflict = await idbGet<ConflictRecord>("conflicts", headKey("note", noteId));
  if (!conflict || conflict.status !== "open") throw new Error("No open conflict to resolve.");
  const note = await idbGet<NoteRecord>("notes", noteId);
  if (!note) throw new Error("Note not found");
  const other = await conflictVersion(conflict.otherRevisionId);

  if (resolution === "both") {
    const heading = `# ${other.title || "Untitled note"} — Conflict from ${other.deviceName}\n\n`;
    await saveNote(identity, {
      id: makeId(),
      title: other.title,
      body: heading + other.body,
      categoryId: other.categoryId,
    });
  }

  const resolved: NoteRecord = { ...note, updatedAt: now(), revisionId: makeId() };
  if (resolution === "other") {
    resolved.title = other.title;
    resolved.body = other.body;
    resolved.categoryId = other.categoryId;
    resolved.deletedAt = other.deletedAt;
  }
  // Parent the resolution to the competing branch so peers converge.
  await recordNoteRevision(identity, resolved, conflict.otherRevisionId);
  await idbPut("conflicts", { ...conflict, status: "resolved", resolvedAt: now() });
  return getNote(noteId) as Promise<Note>;
}

export async function openConflictCount(): Promise<number> {
  const conflicts = await idbGetAll<ConflictRecord>("conflicts");
  return conflicts.filter((c) => c.status === "open").length;
}

// --- Outbox + devices (used by the engine) ------------------------------------

export async function pendingOutbox(): Promise<OutboxRecord[]> {
  const rows = await idbGetAll<OutboxRecord>("outbox");
  const ready = now();
  return rows
    .filter((row) => row.state === "pending" && row.nextRetryAt <= ready)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(0, 32);
}

export async function markOutboxUploaded(id: string): Promise<void> {
  const row = await idbGet<OutboxRecord>("outbox", id);
  if (row) await idbPut("outbox", { ...row, state: "uploaded", lastError: null });
}

export async function markOutboxWaiting(id: string): Promise<void> {
  const row = await idbGet<OutboxRecord>("outbox", id);
  if (row) await idbPut("outbox", { ...row, state: "waiting_for_device" });
}

export async function delayOutbox(id: string, message: string): Promise<void> {
  const row = await idbGet<OutboxRecord>("outbox", id);
  if (!row) return;
  const seconds = Math.min(15 * (row.attempts + 1), 15 * 60);
  const nextRetryAt = new Date(Date.now() + seconds * 1000).toISOString();
  await idbPut("outbox", { ...row, attempts: row.attempts + 1, nextRetryAt, lastError: message });
}

export async function pendingOutboxCount(): Promise<number> {
  const rows = await idbGetAll<OutboxRecord>("outbox");
  return rows.filter((row) => row.state === "pending" || row.state === "waiting_for_device").length;
}

// Refresh recipients on packages that were enqueued before any device existed,
// so a freshly-paired device receives the backlog on the next cycle.
export async function refreshWaitingRecipients(selfDeviceId: string): Promise<void> {
  const recipients = await authorizedRecipients(selfDeviceId);
  if (recipients.length === 0) return;
  const rows = await idbGetAll<OutboxRecord>("outbox");
  for (const row of rows) {
    if (row.state === "waiting_for_device" || (row.state === "pending" && row.recipients.length === 0)) {
      await idbPut("outbox", { ...row, recipients, state: "pending", nextRetryAt: now() });
    }
  }
}

export async function expectedSigningKey(deviceId: string): Promise<Uint8Array | null> {
  const [device, auth] = await Promise.all([
    idbGet<DeviceRecord>("devices", deviceId),
    idbGet<DeviceAuthRecord>("deviceAuth", deviceId),
  ]);
  if (!device || !auth || auth.revokedAt) return null;
  return decodeBase64Url(device.signingKey);
}

export async function authorizedDeviceCount(): Promise<number> {
  const auths = await idbGetAll<DeviceAuthRecord>("deviceAuth");
  return auths.filter((a) => !a.revokedAt).length;
}

export interface StoredDeviceSummary {
  id: string;
  displayName: string;
  isLocal: boolean;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

export async function listDevices(): Promise<StoredDeviceSummary[]> {
  const [devices, auths] = await Promise.all([
    idbGetAll<DeviceRecord>("devices"),
    idbGetAll<DeviceAuthRecord>("deviceAuth"),
  ]);
  const authOf = (id: string) => auths.find((a) => a.deviceId === id);
  return devices.map((device) => ({
    id: device.id,
    displayName: device.displayName,
    isLocal: device.isLocal,
    revokedAt: authOf(device.id)?.revokedAt ?? null,
    lastSeenAt: device.lastSeenAt,
  }));
}

// Register/replace the local device row + self authorization (used on bootstrap
// and when adopting a paired vault). Mirrors the `is_local = 1` device row.
export async function ensureLocalDevice(identity: WebIdentity): Promise<void> {
  const existing = await idbGet<DeviceRecord>("devices", identity.deviceId);
  const device: DeviceRecord = {
    id: identity.deviceId,
    displayName: identity.deviceName,
    signingKey: encodeBase64Url(signingPublicKey(identity)),
    agreementKey: encodeBase64Url(agreementPublicKey(identity)),
    createdAt: existing?.createdAt ?? now(),
    isLocal: true,
    lastSeenAt: existing?.lastSeenAt ?? null,
  };
  const auth: DeviceAuthRecord = { deviceId: identity.deviceId, authorizedAt: now(), revokedAt: null };
  await idbWrite(["devices", "deviceAuth"], (tx) => {
    tx.objectStore("devices").put(device);
    if (!existing) tx.objectStore("deviceAuth").put(auth);
  });
}

export async function renameLocalDevice(deviceId: string, name: string): Promise<void> {
  const device = await idbGet<DeviceRecord>("devices", deviceId);
  if (device) await idbPut("devices", { ...device, displayName: name });
}

export async function markDeviceRevokedLocally(deviceId: string, revokedAt: string): Promise<void> {
  const auth = await idbGet<DeviceAuthRecord>("deviceAuth", deviceId);
  if (auth) await idbPut("deviceAuth", { ...auth, revokedAt });
}

// --- Sync state ---------------------------------------------------------------

interface SyncStateRecord {
  key: string;
  value: string;
}

export async function getSyncState(key: string): Promise<string | null> {
  const row = await idbGet<SyncStateRecord>("meta", `sync:${key}`);
  return row?.value ?? null;
}

export async function setSyncState(key: string, value: string | null): Promise<void> {
  if (value === null) return;
  await idbPut("meta", { key: `sync:${key}`, value });
}

// --- Enqueue + device registration (used by pairing host) ---------------------

// Broadcast an operation to all other authorized devices (mirrors a bare
// `enqueue_operation` call, e.g. the DeviceAuthorization sent when onboarding).
export async function enqueueOperation(identity: WebIdentity, operation: SyncOperation): Promise<void> {
  const recipients = await authorizedRecipients(identity.deviceId);
  const outbox = buildOutbox(identity, makeId(), operation, recipients);
  await idbPut("outbox", outbox);
}

export async function registerAuthorizedDevice(state: DeviceAuthorization): Promise<void> {
  await applyDeviceAuthorization(state);
}

// --- Snapshot (pairing) -------------------------------------------------------

export interface NotebookSnapshot {
  version: number;
  vaultId: string;
  vaultKeyEpoch: number;
  vaultKey: string; // base64url — plaintext inside the sealed pairing payload
  notes: Array<Note & { revisionId: string }>;
  categories: Array<Category & { deletedAt: string | null; revisionId: string }>;
  noteRevisions: Array<{
    id: string;
    noteId: string;
    parentRevisionId: string | null;
    deviceId: string;
    createdAt: string;
    noteCreatedAt: string;
    updatedAt: string;
    contentHash: string;
    title: string;
    body: string;
    categoryId: string | null;
    deletedAt: string | null;
    purgedAt: string | null;
  }>;
  categoryRevisions: Array<{
    id: string;
    categoryId: string;
    parentRevisionId: string | null;
    deviceId: string;
    createdAt: string;
    updatedAt: string;
    contentHash: string;
    name: string;
    position: number;
    deletedAt: string | null;
  }>;
  devices: Array<{
    id: string;
    displayName: string;
    signingKey: string;
    agreementKey: string;
    createdAt: string;
    authorizedAt: string;
    revokedAt: string | null;
    lastSeenAt: string | null;
  }>;
  heads: Array<{ entityType: EntityType; entityId: string; revisionId: string }>;
  tombstones: Array<{ entityType: EntityType; entityId: string; revisionId: string; deletedAt: string | null; purgedAt: string | null }>;
  conflicts: Array<{
    id: string;
    entityType: EntityType;
    entityId: string;
    currentRevisionId: string;
    otherRevisionId: string;
    status: string;
    createdAt: string;
    resolvedAt: string | null;
  }>;
}

const SNAPSHOT_STORES: StoreName[] = [
  "notes",
  "categories",
  "noteRevisions",
  "categoryRevisions",
  "entityHeads",
  "tombstones",
  "conflicts",
  "devices",
  "deviceAuth",
  "outbox",
  "receipts",
];

// Serialize the full notebook for a pairing snapshot (mirrors `build_snapshot`).
export async function exportSnapshot(identity: WebIdentity): Promise<NotebookSnapshot> {
  const [notes, categories, noteRevs, categoryRevs, heads, tombstones, conflicts, devices, auths] =
    await Promise.all([
      idbGetAll<NoteRecord>("notes"),
      idbGetAll<CategoryRecord>("categories"),
      idbGetAll<NoteRevisionRecord>("noteRevisions"),
      idbGetAll<CategoryRevisionRecord>("categoryRevisions"),
      idbGetAll<EntityHead>("entityHeads"),
      idbGetAll<TombstoneRecord>("tombstones"),
      idbGetAll<ConflictRecord>("conflicts"),
      idbGetAll<DeviceRecord>("devices"),
      idbGetAll<DeviceAuthRecord>("deviceAuth"),
    ]);
  const authOf = (id: string) => auths.find((a) => a.deviceId === id);
  return {
    version: 1,
    vaultId: identity.vaultId,
    vaultKeyEpoch: identity.vaultKeyEpoch,
    vaultKey: encodeBase64Url(identity.vaultKey),
    notes: notes.map((n) => ({ ...n, categoryName: null })),
    categories,
    noteRevisions: noteRevs.map((r) => ({
      id: r.revisionId,
      noteId: r.noteId,
      parentRevisionId: r.parentRevisionId,
      deviceId: r.deviceId,
      createdAt: r.createdAt,
      noteCreatedAt: r.noteCreatedAt,
      updatedAt: r.updatedAt,
      contentHash: r.contentHash,
      title: r.title,
      body: r.body,
      categoryId: r.categoryId,
      deletedAt: r.deletedAt,
      purgedAt: r.purgedAt,
    })),
    categoryRevisions: categoryRevs.map((r) => ({
      id: r.revisionId,
      categoryId: r.categoryId,
      parentRevisionId: r.parentRevisionId,
      deviceId: r.deviceId,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      contentHash: r.contentHash,
      name: r.name,
      position: r.position,
      deletedAt: r.deletedAt,
    })),
    devices: devices
      .filter((d) => authOf(d.id))
      .map((d) => ({
        id: d.id,
        displayName: d.displayName,
        signingKey: d.signingKey,
        agreementKey: d.agreementKey,
        createdAt: d.createdAt,
        authorizedAt: authOf(d.id)!.authorizedAt,
        revokedAt: authOf(d.id)!.revokedAt,
        lastSeenAt: d.lastSeenAt,
      })),
    heads: heads.map((h) => ({ entityType: h.entityType, entityId: rawEntityId(h.entityId), revisionId: h.revisionId })),
    tombstones: tombstones.map((t) => ({
      entityType: t.entityType,
      entityId: rawEntityId(t.entityId),
      revisionId: t.revisionId,
      deletedAt: t.deletedAt,
      purgedAt: t.purgedAt,
    })),
    conflicts: conflicts.map((c) => ({
      id: c.entityId,
      entityType: c.entityType,
      entityId: rawEntityId(c.entityId),
      currentRevisionId: c.currentRevisionId,
      otherRevisionId: c.otherRevisionId,
      status: c.status,
      createdAt: c.createdAt,
      resolvedAt: c.resolvedAt,
    })),
  };
}

// The native snapshot uses bare entity ids; our head/tombstone/conflict keys are
// `${type}:${id}`. Strip the prefix on export, re-add on import.
function rawEntityId(prefixed: string): string {
  const index = prefixed.indexOf(":");
  return index === -1 ? prefixed : prefixed.slice(index + 1);
}

// Install a paired snapshot as the local notebook (mirrors `import_snapshot`).
// Requires this device to be authorized in the snapshot. This clears the stores
// it owns, so anything local worth keeping must be collected first
// (`collectLocalNotebook`) and replayed after (`replayNotebook`).
export async function importSnapshot(snapshot: NotebookSnapshot, selfDeviceId: string): Promise<void> {
  if (snapshot.version !== 1) throw new Error("Unsupported notebook snapshot version.");
  const authorized = snapshot.devices.some((d) => d.id === selfDeviceId && !d.revokedAt);
  if (!authorized) throw new Error("The paired notebook did not authorize this device.");

  await idbWrite(SNAPSHOT_STORES, (tx) => {
    for (const store of SNAPSHOT_STORES) tx.objectStore(store).clear();

    for (const category of snapshot.categories) {
      const { id, name, position, createdAt, updatedAt, deletedAt, revisionId } = category;
      tx.objectStore("categories").put({ id, name, position, createdAt, updatedAt, deletedAt, revisionId });
    }
    for (const note of snapshot.notes) {
      const { id, title, body, categoryId, createdAt, updatedAt, deletedAt, revisionId } = note;
      tx.objectStore("notes").put({ id, title, body, categoryId, createdAt, updatedAt, deletedAt, revisionId });
    }
    for (const r of snapshot.noteRevisions) {
      tx.objectStore("noteRevisions").put({
        revisionId: r.id,
        noteId: r.noteId,
        parentRevisionId: r.parentRevisionId,
        deviceId: r.deviceId,
        contentHash: r.contentHash,
        title: r.title,
        body: r.body,
        categoryId: r.categoryId,
        createdAt: r.createdAt,
        noteCreatedAt: r.noteCreatedAt,
        updatedAt: r.updatedAt,
        deletedAt: r.deletedAt,
        purgedAt: r.purgedAt,
      } satisfies NoteRevisionRecord);
    }
    for (const r of snapshot.categoryRevisions) {
      tx.objectStore("categoryRevisions").put({
        revisionId: r.id,
        categoryId: r.categoryId,
        parentRevisionId: r.parentRevisionId,
        deviceId: r.deviceId,
        contentHash: r.contentHash,
        name: r.name,
        position: r.position,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        deletedAt: r.deletedAt,
      } satisfies CategoryRevisionRecord);
    }
    for (const d of snapshot.devices) {
      tx.objectStore("devices").put({
        id: d.id,
        displayName: d.displayName,
        signingKey: d.signingKey,
        agreementKey: d.agreementKey,
        createdAt: d.createdAt,
        isLocal: d.id === selfDeviceId,
        lastSeenAt: d.lastSeenAt,
      } satisfies DeviceRecord);
      tx.objectStore("deviceAuth").put({
        deviceId: d.id,
        authorizedAt: d.authorizedAt,
        revokedAt: d.revokedAt,
      } satisfies DeviceAuthRecord);
    }
    for (const h of snapshot.heads) {
      tx.objectStore("entityHeads").put({
        entityId: headKey(h.entityType, h.entityId),
        entityType: h.entityType,
        revisionId: h.revisionId,
      } satisfies EntityHead);
    }
    for (const t of snapshot.tombstones) {
      tx.objectStore("tombstones").put({
        entityId: headKey(t.entityType, t.entityId),
        entityType: t.entityType,
        revisionId: t.revisionId,
        deletedAt: t.deletedAt,
        purgedAt: t.purgedAt,
      } satisfies TombstoneRecord);
    }
    for (const c of snapshot.conflicts) {
      tx.objectStore("conflicts").put({
        entityId: headKey(c.entityType, c.entityId),
        entityType: c.entityType,
        currentRevisionId: c.currentRevisionId,
        otherRevisionId: c.otherRevisionId,
        status: c.status === "resolved" ? "resolved" : "open",
        createdAt: c.createdAt,
        resolvedAt: c.resolvedAt,
      } satisfies ConflictRecord);
    }
  });
}

// --- Pairing archive + merge --------------------------------------------------

export interface CarriedNotebook {
  notes: NoteRecord[];
  categories: CategoryRecord[];
}

export interface ArchiveRecord {
  id: string;
  createdAt: string;
  reason: string;
  snapshot: NotebookSnapshot;
}

export interface ReplayCounts {
  notes: number;
  categories: number;
}

// The working copies this device owns before it adopts another vault. Trashed
// notes come along too — they belong to the user just as much, and `deletedAt`
// rides through the replay so they land back in the trash.
export async function collectLocalNotebook(): Promise<CarriedNotebook> {
  const [notes, categories] = await Promise.all([
    idbGetAll<NoteRecord>("notes"),
    idbGetAll<CategoryRecord>("categories"),
  ]);
  return { notes, categories };
}

// A full pre-pairing copy, written to a store `importSnapshot` does not clear, so
// a merge that fails halfway leaves the old notebook recoverable.
export async function archiveNotebook(identity: WebIdentity, reason: string): Promise<string> {
  const record: ArchiveRecord = {
    id: makeId(),
    createdAt: now(),
    reason,
    snapshot: await exportSnapshot(identity),
  };
  await idbPut("archives", record);
  return record.id;
}

export async function listArchives(): Promise<ArchiveRecord[]> {
  const archives = await idbGetAll<ArchiveRecord>("archives");
  return archives.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// Re-record a carried notebook as fresh root revisions under the adopted vault,
// which also enqueues them for the vault's other devices.
//
// The carried revision ancestry is deliberately dropped: it only ever existed on
// this device, so no peer could resolve it — `applyRemoteNote` rejects a revision
// whose parent it has never seen. A root revision (no parent) applies cleanly on
// every device instead. Entity ids are UUIDs, so they cannot collide with the
// adopted vault's own notes; an id that somehow does already exist is left alone
// rather than forked into a conflict.
export async function replayNotebook(
  identity: WebIdentity,
  carried: CarriedNotebook,
): Promise<ReplayCounts> {
  const existingCategories = await idbGetAll<CategoryRecord>("categories");
  const takenCategoryIds = new Set(existingCategories.map((c) => c.id));
  const positionOffset = existingCategories.reduce((max, c) => Math.max(max, c.position), -1) + 1;
  const counts: ReplayCounts = { notes: 0, categories: 0 };

  const carriedCategories = carried.categories.filter((c) => !takenCategoryIds.has(c.id));
  for (const [index, category] of carriedCategories.entries()) {
    await recordCategoryRevision(
      identity,
      { ...category, position: positionOffset + index, revisionId: makeId() },
      null,
    );
    counts.categories += 1;
  }

  const takenNoteIds = new Set((await idbGetAll<NoteRecord>("notes")).map((n) => n.id));
  for (const note of carried.notes.filter((n) => !takenNoteIds.has(n.id))) {
    await recordNoteRevision(identity, { ...note, revisionId: makeId() }, null);
    counts.notes += 1;
  }
  return counts;
}
