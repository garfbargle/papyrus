export type Category = {
  id: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type Note = {
  id: string;
  title: string;
  body: string;
  categoryId: string | null;
  categoryName?: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revisionId: string;
  preview?: string;
};

export type NoteListItem = Omit<Note, "body">;

export type NoteFilter = "all" | "trash" | { categoryId: string };

export type SavePayload = Pick<Note, "id" | "title" | "body" | "categoryId">;

export type SyncDevice = {
  id: string;
  displayName: string;
  isCurrentDevice: boolean;
  revokedAt: string | null;
  lastSeenAt: string | null;
};

export type SyncStatus = {
  status: "Synced" | "Syncing" | "Offline" | "Changes pending" | "Attention required";
  lastSuccessfulSync: string | null;
  pendingOutgoingChanges: number;
  devices: SyncDevice[];
  localDeviceName: string;
  attentionMessage: string | null;
  openConflicts: number;
};

export type ConflictVersion = {
  revisionId: string;
  title: string;
  body: string;
  categoryId: string | null;
  updatedAt: string;
  deviceName: string;
  deletedAt: string | null;
};

export type NoteConflict = {
  id: string;
  noteId: string;
  current: ConflictVersion;
  other: ConflictVersion;
};

export type PairingOffer = { code: string; expiresAt: string };
export type PairingProgress = { ready: boolean; message: string };
