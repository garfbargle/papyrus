// Sync operation types — the decrypted payloads that flow through the relay.
// Mirrors the serde enums/structs in `src-tauri/src/sync.rs` exactly (camelCase
// field names, `{ kind, state }` tagging). These are the objects wrapped by
// `encryptOperation` / returned by `decryptOperation`.

export interface NoteRevisionState {
  id: string;
  title: string;
  body: string;
  categoryId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  purgedAt: string | null;
  revisionId: string;
  parentRevisionId: string | null;
}

export interface CategoryRevisionState {
  id: string;
  name: string;
  position: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  revisionId: string;
  parentRevisionId: string | null;
}

export interface DeviceAuthorization {
  deviceId: string;
  displayName: string;
  signingPublicKey: string; // base64url
  agreementPublicKey: string; // base64url
  authorizedAt: string;
}

export interface DeviceRevocation {
  deviceId: string;
  revokedAt: string;
}

export interface VaultKeyRotation {
  epoch: number;
  vaultKey: string; // base64url
  rotatedAt: string;
}

// Tagged union: `#[serde(tag = "kind", content = "state", rename_all = "camelCase")]`.
export type SyncOperation =
  | { kind: "noteRevision"; state: NoteRevisionState }
  | { kind: "categoryRevision"; state: CategoryRevisionState }
  | { kind: "deviceAuthorization"; state: DeviceAuthorization }
  | { kind: "deviceRevocation"; state: DeviceRevocation }
  | { kind: "vaultKeyRotation"; state: VaultKeyRotation };
