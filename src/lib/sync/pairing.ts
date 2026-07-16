// Device pairing — a port of start/accept/complete/finish_pairing in
// `src-tauri/src/lib.rs`. Two roles:
//   - HOST (owns the vault): `hostStartPairing` emits a code; `hostCompletePairing`
//     polls until the guest appears, authorizes it, and seals a snapshot.
//   - GUEST (joining): `guestAcceptPairing` publishes its keys; `guestFinishPairing`
//     polls until the sealed snapshot is available, then adopts the vault.
//
// The vault key never reaches the relay in the clear: it rides inside the
// gzip-compressed snapshot, sealed under an X25519/HKDF key derived from the
// guest's public key and the out-of-band pairing secret.

import type { PairingOffer, PairingProgress } from "../../types";
import {
  decodeBase64Url,
  encodeBase64Url,
  openPairingPayload,
  randomBytes,
  sealPairingPayload,
  sha256Hex,
  signingPublicKey,
  agreementPublicKey,
  type SealedPairingPayload,
} from "./crypto.js";
import { adoptVault, saveIdentity, type WebIdentity } from "./identity.js";
import { gunzip, gzip } from "./gzip.js";
import type { DeviceAuthorization } from "./operations.js";
import { RelayClient } from "./relay.js";
import {
  archiveNotebook,
  collectLocalNotebook,
  enqueueOperation,
  exportSnapshot,
  importSnapshot,
  registerAuthorizedDevice,
  replayNotebook,
  setSyncState,
  type NotebookSnapshot,
  type ReplayCounts,
} from "./store.js";

const CODE_PREFIX = "papyrus-pair-v1:";
const PAIRING_LIFETIME_MS = 5 * 60 * 1000;

export interface SyncContext {
  identity: WebIdentity;
  relay: RelayClient;
}

interface PairingCode {
  version: number;
  relayUrl: string;
  sessionId: string;
  secret: string; // base64url(random 32) as text; also the HKDF salt bytes
  expiresAt: string;
}

const utf8 = (value: string) => new TextEncoder().encode(value);

export function encodePairingCode(code: PairingCode): string {
  return CODE_PREFIX + encodeBase64Url(utf8(JSON.stringify(code)));
}

export function decodePairingCode(raw: string): PairingCode {
  if (!raw.startsWith(CODE_PREFIX)) throw new Error("That pairing code is not valid.");
  let code: PairingCode;
  try {
    code = JSON.parse(new TextDecoder().decode(decodeBase64Url(raw.slice(CODE_PREFIX.length))));
  } catch {
    throw new Error("That pairing code is not valid.");
  }
  if (code.version !== 1) throw new Error("That pairing code is from a newer version of Papyrus.");
  if (Date.parse(code.expiresAt) <= Date.now()) throw new Error("That pairing code has expired.");
  return code;
}

// --- HOST ---------------------------------------------------------------------

export async function hostStartPairing(ctx: SyncContext, relayUrl: string): Promise<PairingOffer> {
  const sessionId = crypto.randomUUID();
  const secret = encodeBase64Url(randomBytes(32));
  const expiresAt = new Date(Date.now() + PAIRING_LIFETIME_MS).toISOString();

  await ctx.relay.pairingStart(ctx.identity, {
    vaultId: ctx.identity.vaultId,
    sessionId,
    secretHash: sha256Hex(utf8(secret)),
    expiresAt,
  });

  const code = encodePairingCode({ version: 1, relayUrl, sessionId, secret, expiresAt });
  return { code, expiresAt };
}

export async function hostCompletePairing(ctx: SyncContext, rawCode: string): Promise<PairingProgress> {
  const code = decodePairingCode(rawCode);
  const claim = await ctx.relay.pairingClaim(ctx.identity, {
    vaultId: ctx.identity.vaultId,
    sessionId: code.sessionId,
  });
  if (!claim.ready) {
    return { ready: false, message: "Waiting for the new device to scan this code…" };
  }
  if (!claim.deviceId || !claim.displayName || !claim.signingKey || !claim.agreementKey) {
    return { ready: false, message: "Waiting for the new device to finish…" };
  }

  // Authorize the guest locally and broadcast it to other devices.
  const authorization: DeviceAuthorization = {
    deviceId: claim.deviceId,
    displayName: claim.displayName,
    signingPublicKey: claim.signingKey,
    agreementPublicKey: claim.agreementKey,
    authorizedAt: new Date().toISOString(),
  };
  await registerAuthorizedDevice(authorization);
  await enqueueOperation(ctx.identity, { kind: "deviceAuthorization", state: authorization });

  // Seal a full snapshot to the guest's agreement key.
  const snapshot = await exportSnapshot(ctx.identity);
  const compressed = await gzip(utf8(JSON.stringify(snapshot)));
  const sealed = sealPairingPayload(
    ctx.identity,
    decodeBase64Url(claim.agreementKey),
    utf8(code.secret),
    compressed,
  );

  await ctx.relay.pairingComplete(ctx.identity, {
    sessionId: code.sessionId,
    deviceId: claim.deviceId,
    sealedPayload: JSON.stringify(sealed),
  });
  return { ready: true, message: "Device paired." };
}

// --- GUEST --------------------------------------------------------------------

export async function guestAcceptPairing(ctx: SyncContext, rawCode: string): Promise<PairingProgress> {
  const code = decodePairingCode(rawCode);
  // The guest talks to the relay named in the code.
  ctx.relay = new RelayClient(code.relayUrl);

  await ctx.relay.pairingHello({
    sessionId: code.sessionId,
    secret: code.secret,
    deviceId: ctx.identity.deviceId,
    displayName: ctx.identity.deviceName,
    signingKey: encodeBase64Url(signingPublicKey(ctx.identity)),
    agreementKey: encodeBase64Url(agreementPublicKey(ctx.identity)),
  });

  await setSyncState("relay_url", code.relayUrl);
  await setSyncState("pairing_session", code.sessionId);
  return { ready: false, message: "Waiting for your other device to approve…" };
}

export async function guestFinishPairing(ctx: SyncContext, rawCode: string): Promise<PairingProgress> {
  const code = decodePairingCode(rawCode);
  ctx.relay = new RelayClient(code.relayUrl);

  const response = await ctx.relay.pairingFinish(ctx.identity, {
    sessionId: code.sessionId,
    secret: code.secret,
    deviceId: ctx.identity.deviceId,
  });
  if (!response.ready || !response.sealedPayload) {
    return { ready: false, message: "Waiting for approval on your other device…" };
  }

  const sealed = JSON.parse(response.sealedPayload) as SealedPairingPayload;
  const compressed = openPairingPayload(ctx.identity, sealed, utf8(code.secret));
  const snapshot = JSON.parse(new TextDecoder().decode(await gunzip(compressed))) as NotebookSnapshot;

  // Pairing merges rather than replaces: hold on to this device's notebook,
  // adopt the vault, then replay what we held into it so the other devices
  // receive it too. The archive is the safety net if we fail in between.
  const carried = await collectLocalNotebook();
  await archiveNotebook(ctx.identity, "Before pairing with an existing notebook");

  await importSnapshot(snapshot, ctx.identity.deviceId);
  const adopted = adoptVault(
    ctx.identity,
    snapshot.vaultId,
    snapshot.vaultKeyEpoch,
    decodeBase64Url(snapshot.vaultKey),
  );
  await saveIdentity(adopted);
  ctx.identity = adopted;

  // Replay under the adopted identity — the operations have to be sealed with
  // the new vault key and addressed to the new vault's devices.
  const merged = await replayNotebook(adopted, carried);
  await setSyncState("relay_url", code.relayUrl);
  return { ready: true, message: pairedMessage(merged) };
}

function pairedMessage({ notes }: ReplayCounts): string {
  if (notes === 0) return "Notebook paired and ready.";
  return `Notebook paired. ${notes} note${notes === 1 ? "" : "s"} from this device merged in.`;
}
