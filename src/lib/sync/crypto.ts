// Papyrus web sync crypto — a byte-for-byte port of the native (Rust) crypto in
// `src-tauri/src/sync.rs`. The relay is a zero-knowledge broker: every note
// operation is XChaCha20Poly1305-encrypted under a shared vault key and signed
// with a per-device Ed25519 key before it leaves the client. Device pairing
// hands the vault key over an X25519/HKDF-sealed channel. WebCrypto lacks
// XChaCha20Poly1305 and has uneven Ed25519/X25519 support, so we use the
// audited @noble/* primitives.
//
// Wire compatibility with existing Rust clients is load-bearing. The following
// must match the Rust byte-for-byte and are covered by the parity test:
//   - AAD strings (`aad`, the pairing-snapshot constant)
//   - the `signable` tuple, serialized as a compact JSON array
//   - the transport-proof message string
//   - `contentHash` (SHA-256 over NUL-separated fields)
//   - URL_SAFE_NO_PAD base64 for all binary fields
// See sync.rs: encrypt_operation / decrypt_operation / transport_proof /
// pairing_key / seal_pairing_payload / open_pairing_payload / content_hash.

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hkdf } from "@noble/hashes/hkdf.js";

const PROTOCOL_VERSION = 1;
const PAIRING_SNAPSHOT_AAD = utf8("papyrus-pairing-snapshot-v1");
const PAIRING_HKDF_INFO = utf8("papyrus-pairing-v1");

// --- Wire types (mirror the serde structs in sync.rs, camelCase field names) --

export interface SyncEnvelope {
  version: number;
  packageId: string;
  vaultId: string;
  senderDeviceId: string;
  senderSigningKey: string; // base64url(ed25519 public key)
  keyEpoch: number;
  createdAt: string;
  nonce: string; // base64url(24 bytes)
  ciphertext: string; // base64url
  signature: string; // base64url(ed25519 signature over `signable`)
}

export interface TransportProof {
  deviceId: string;
  signingKey: string; // base64url(ed25519 public key)
  timestamp: string;
  signature: string; // base64url
}

export interface SealedPairingPayload {
  hostAgreementKey: string; // base64url(x25519 public key of the sealer)
  nonce: string;
  ciphertext: string;
}

// The device's long-lived key material. In the native app this lives in the OS
// keychain; in the browser it is held/derived by the storage layer (out of
// scope for this module). Private keys are raw 32-byte seeds/scalars — the same
// bytes the Rust `StoredIdentity` persists.
export interface SyncIdentity {
  vaultId: string;
  vaultKeyEpoch: number;
  vaultKey: Uint8Array; // 32 bytes, symmetric, shared across paired devices
  deviceId: string;
  signingSeed: Uint8Array; // 32 bytes, ed25519 private seed
  agreementSecret: Uint8Array; // 32 bytes, x25519 private scalar
  previousVaultKeys?: { epoch: number; key: Uint8Array }[];
}

// A `SyncOperation` is an opaque tagged object (`{ kind, state }`) to this
// layer — the sync engine owns its shape. We only wrap/unwrap it.
export type SyncOperation = Record<string, unknown>;

// --- Encoding helpers ---------------------------------------------------------

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function fromUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    normalized.length % 4 === 0
      ? normalized
      : normalized + "=".repeat(4 - (normalized.length % 4));
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function makeId(): string {
  return crypto.randomUUID();
}

// --- Hashing (mirrors sync.rs sha256_hex / content_hash) ----------------------

export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

// content_hash: SHA-256 over title \0 body \0 categoryId \0 deletedAt, where a
// missing categoryId/deletedAt contributes the empty string (Rust
// `unwrap_or_default`). Lowercase hex.
export function contentHash(
  title: string,
  body: string,
  categoryId: string | null | undefined,
  deletedAt: string | null | undefined,
): string {
  const separator = new Uint8Array([0]);
  const parts = [
    utf8(title),
    separator,
    utf8(body),
    separator,
    utf8(categoryId ?? ""),
    separator,
    utf8(deletedAt ?? ""),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }
  return toHex(sha256(buffer));
}

// --- Signing helpers ----------------------------------------------------------

export function signingPublicKey(identity: SyncIdentity): Uint8Array {
  return ed25519.getPublicKey(identity.signingSeed);
}

export function agreementPublicKey(identity: SyncIdentity): Uint8Array {
  return x25519.getPublicKey(identity.agreementSecret);
}

// The AAD binds a ciphertext to its envelope context. Must match Rust `aad`.
export function aadString(envelope: SyncEnvelope): string {
  return `papyrus-sync/${envelope.version}/${envelope.vaultId}:${envelope.packageId}:${envelope.keyEpoch}`;
}

function envelopeAad(envelope: SyncEnvelope): Uint8Array {
  return utf8(aadString(envelope));
}

// The signed message: a compact JSON array of the envelope fields, matching the
// Rust tuple passed to `serde_json::to_vec` in `signable`. Field order and
// compact (space-free) encoding are load-bearing.
export function signableString(envelope: SyncEnvelope): string {
  return JSON.stringify([
    envelope.version,
    envelope.packageId,
    envelope.vaultId,
    envelope.senderDeviceId,
    envelope.senderSigningKey,
    envelope.keyEpoch,
    envelope.createdAt,
    envelope.nonce,
    envelope.ciphertext,
  ]);
}

function signableBytes(envelope: SyncEnvelope): Uint8Array {
  return utf8(signableString(envelope));
}

// The transport-proof signed message (mirrors the format string in Rust
// `transport_proof`). Exposed for parity testing.
export function transportMessage(
  method: string,
  path: string,
  timestamp: string,
  body: Uint8Array,
): string {
  return `papyrus-relay-v1\n${method}\n${path}\n${timestamp}\n${sha256Hex(body)}`;
}

// --- Operation encrypt / decrypt ---------------------------------------------

export interface EncryptOptions {
  // Injectable for deterministic tests; production uses fresh random values.
  packageId?: string;
  operationId?: string;
  nonce?: Uint8Array;
  createdAt?: string;
}

export function encryptOperation(
  identity: SyncIdentity,
  operation: SyncOperation,
  options: EncryptOptions = {},
): SyncEnvelope {
  const nonce = options.nonce ?? randomBytes(24);
  const envelope: SyncEnvelope = {
    version: PROTOCOL_VERSION,
    packageId: options.packageId ?? makeId(),
    vaultId: identity.vaultId,
    senderDeviceId: identity.deviceId,
    senderSigningKey: encodeBase64Url(signingPublicKey(identity)),
    keyEpoch: identity.vaultKeyEpoch,
    createdAt: options.createdAt ?? new Date().toISOString(),
    nonce: encodeBase64Url(nonce),
    ciphertext: "",
    signature: "",
  };

  // SignedOperation uses snake_case keys (the Rust struct has no rename_all).
  const signed = {
    operation_id: options.operationId ?? makeId(),
    author_device_id: identity.deviceId,
    operation,
  };
  const plaintext = utf8(JSON.stringify(signed));

  const cipher = xchacha20poly1305(identity.vaultKey, nonce, envelopeAad(envelope));
  envelope.ciphertext = encodeBase64Url(cipher.encrypt(plaintext));
  envelope.signature = encodeBase64Url(
    ed25519.sign(signableBytes(envelope), identity.signingSeed),
  );
  return envelope;
}

function vaultKeyForEpoch(identity: SyncIdentity, epoch: number): Uint8Array {
  if (epoch === identity.vaultKeyEpoch) {
    return identity.vaultKey;
  }
  const historical = identity.previousVaultKeys?.find((entry) => entry.epoch === epoch);
  if (!historical) {
    throw new Error("This package uses a vault key that is no longer available.");
  }
  return historical.key;
}

export function decryptOperation(
  identity: SyncIdentity,
  envelope: SyncEnvelope,
  expectedSigningKey: Uint8Array,
): SyncOperation {
  if (envelope.version !== PROTOCOL_VERSION || envelope.vaultId !== identity.vaultId) {
    throw new Error("Package belongs to another notebook or protocol version.");
  }
  const publicKey = decodeBase64Url(envelope.senderSigningKey);
  if (!bytesEqual(publicKey, expectedSigningKey)) {
    throw new Error("Package author key does not match this device authorization.");
  }
  const signature = decodeBase64Url(envelope.signature);
  if (!ed25519.verify(signature, signableBytes(envelope), publicKey)) {
    throw new Error("Package signature verification failed.");
  }
  const nonce = decodeBase64Url(envelope.nonce);
  const ciphertext = decodeBase64Url(envelope.ciphertext);
  const key = vaultKeyForEpoch(identity, envelope.keyEpoch);

  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(key, nonce, envelopeAad(envelope)).decrypt(ciphertext);
  } catch {
    throw new Error("Encrypted package authentication failed.");
  }

  let signed: { author_device_id?: unknown; operation?: unknown };
  try {
    signed = JSON.parse(fromUtf8(plaintext));
  } catch {
    throw new Error("Encrypted package content is invalid.");
  }
  if (signed.author_device_id !== envelope.senderDeviceId) {
    throw new Error("Package author identity is invalid.");
  }
  return signed.operation as SyncOperation;
}

// --- Transport authentication (mirrors sync.rs transport_proof) ---------------

export function transportProof(
  identity: SyncIdentity,
  method: string,
  path: string,
  body: Uint8Array,
  timestamp: string = new Date().toISOString(),
): TransportProof {
  const message = utf8(transportMessage(method, path, timestamp, body));
  return {
    deviceId: identity.deviceId,
    signingKey: encodeBase64Url(signingPublicKey(identity)),
    timestamp,
    signature: encodeBase64Url(ed25519.sign(message, identity.signingSeed)),
  };
}

// --- Device pairing (mirrors sync.rs pairing_key / seal / open) ---------------

function pairingKey(
  agreementSecret: Uint8Array,
  peerPublicKey: Uint8Array,
  pairingSecret: Uint8Array,
): Uint8Array {
  const shared = x25519.getSharedSecret(agreementSecret, peerPublicKey);
  // Rust: Hkdf::new(Some(pairingSecret /* salt */), shared /* ikm */).
  return hkdf(sha256, shared, pairingSecret, PAIRING_HKDF_INFO, 32);
}

export function sealPairingPayload(
  identity: SyncIdentity,
  peerPublicKey: Uint8Array,
  pairingSecret: Uint8Array,
  plaintext: Uint8Array,
  nonce: Uint8Array = randomBytes(24),
): SealedPairingPayload {
  const key = pairingKey(identity.agreementSecret, peerPublicKey, pairingSecret);
  const ciphertext = xchacha20poly1305(key, nonce, PAIRING_SNAPSHOT_AAD).encrypt(plaintext);
  return {
    hostAgreementKey: encodeBase64Url(agreementPublicKey(identity)),
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(ciphertext),
  };
}

export function openPairingPayload(
  identity: SyncIdentity,
  payload: SealedPairingPayload,
  pairingSecret: Uint8Array,
): Uint8Array {
  const peerPublicKey = decodeBase64Url(payload.hostAgreementKey);
  const key = pairingKey(identity.agreementSecret, peerPublicKey, pairingSecret);
  const nonce = decodeBase64Url(payload.nonce);
  const ciphertext = decodeBase64Url(payload.ciphertext);
  try {
    return xchacha20poly1305(key, nonce, PAIRING_SNAPSHOT_AAD).decrypt(ciphertext);
  } catch {
    throw new Error("The pairing snapshot could not be authenticated.");
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}
