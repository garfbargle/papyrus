// Device identity + key storage for the web client. Per the project decision,
// keys are held raw in IndexedDB, mirroring the native app's "trust this device"
// model (the native app uses the OS keychain; the browser has no equivalent).
//
// This is the web analogue of `bootstrap_identity` / `adopt_vault` in
// `src-tauri/src/sync.rs`:
//   - a fresh notebook mints a random vault key (NOT derived from a passphrase),
//     a per-device Ed25519 signing seed, and a per-device X25519 agreement key;
//   - a device that joins an existing vault via pairing keeps its own device
//     keys but adopts the shared vault key + epoch from the host's snapshot.

import { randomBytes, type SyncIdentity } from "./crypto.js";
import { idbGet, idbPut } from "./idb.js";

const IDENTITY_KEY = "identity";

// Serializable form stored in IndexedDB. Uint8Array is structured-cloneable, so
// we persist the raw bytes directly.
interface StoredIdentity {
  key: typeof IDENTITY_KEY;
  vaultId: string;
  vaultKeyEpoch: number;
  vaultKey: Uint8Array;
  deviceId: string;
  deviceName: string;
  signingSeed: Uint8Array;
  agreementSecret: Uint8Array;
  previousVaultKeys: { epoch: number; key: Uint8Array }[];
}

export interface WebIdentity extends SyncIdentity {
  deviceName: string;
}

function toStored(identity: WebIdentity): StoredIdentity {
  return {
    key: IDENTITY_KEY,
    vaultId: identity.vaultId,
    vaultKeyEpoch: identity.vaultKeyEpoch,
    vaultKey: identity.vaultKey,
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    signingSeed: identity.signingSeed,
    agreementSecret: identity.agreementSecret,
    previousVaultKeys: identity.previousVaultKeys ?? [],
  };
}

function fromStored(stored: StoredIdentity): WebIdentity {
  return {
    vaultId: stored.vaultId,
    vaultKeyEpoch: stored.vaultKeyEpoch,
    vaultKey: stored.vaultKey,
    deviceId: stored.deviceId,
    deviceName: stored.deviceName,
    signingSeed: stored.signingSeed,
    agreementSecret: stored.agreementSecret,
    previousVaultKeys: stored.previousVaultKeys ?? [],
  };
}

export async function loadIdentity(): Promise<WebIdentity | null> {
  const stored = await idbGet<StoredIdentity>("meta", IDENTITY_KEY);
  return stored ? fromStored(stored) : null;
}

export async function saveIdentity(identity: WebIdentity): Promise<void> {
  await idbPut("meta", toStored(identity));
}

// Fresh per-device key material (Ed25519 signing seed + X25519 agreement key +
// device id). Shared by both new-vault bootstrap and pairing-as-guest.
function newDeviceKeys(): Pick<WebIdentity, "deviceId" | "signingSeed" | "agreementSecret"> {
  return {
    deviceId: crypto.randomUUID(),
    signingSeed: randomBytes(32),
    agreementSecret: randomBytes(32),
  };
}

// Create and persist a brand-new vault owned by this browser (used when the web
// client is the first device — no pairing). The vault key is random, not derived.
export async function bootstrapVault(deviceName = "This browser"): Promise<WebIdentity> {
  const identity: WebIdentity = {
    vaultId: crypto.randomUUID(),
    vaultKeyEpoch: 1,
    vaultKey: randomBytes(32),
    deviceName,
    previousVaultKeys: [],
    ...newDeviceKeys(),
  };
  await saveIdentity(identity);
  return identity;
}

// Create device keys for joining an existing vault. Vault fields are filled in
// once the pairing snapshot arrives (see `adoptVault`). Not persisted until the
// join completes, so an abandoned pairing leaves no half-state.
export function newJoiningIdentity(deviceName: string): WebIdentity {
  return {
    vaultId: "",
    vaultKeyEpoch: 0,
    vaultKey: new Uint8Array(32),
    deviceName,
    previousVaultKeys: [],
    ...newDeviceKeys(),
  };
}

// Adopt a vault key received during pairing, preserving prior keys so packages
// authored before a rotation still decrypt (mirrors `adopt_vault`).
export function adoptVault(
  identity: WebIdentity,
  vaultId: string,
  vaultKeyEpoch: number,
  vaultKey: Uint8Array,
): WebIdentity {
  const previous = [...(identity.previousVaultKeys ?? [])];
  if (
    identity.vaultId === vaultId &&
    identity.vaultKeyEpoch !== vaultKeyEpoch &&
    identity.vaultKeyEpoch > 0 &&
    !previous.some((entry) => entry.epoch === identity.vaultKeyEpoch)
  ) {
    previous.push({ epoch: identity.vaultKeyEpoch, key: identity.vaultKey });
  }
  return { ...identity, vaultId, vaultKeyEpoch, vaultKey, previousVaultKeys: previous };
}

export async function loadOrBootstrap(): Promise<WebIdentity> {
  return (await loadIdentity()) ?? (await bootstrapVault());
}
