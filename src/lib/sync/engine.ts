// The sync cycle — a port of `run_sync_cycle` in `src-tauri/src/lib.rs`.
// Ordering: drain the outbox (upload) → fetch inbound → decrypt+apply → ack.
// Network I/O happens outside IndexedDB transactions; each store call is atomic.

import { decodeBase64Url, decryptOperation, type SyncEnvelope } from "./crypto.js";
import type { SyncOperation } from "./operations.js";
import { adoptVault, saveIdentity, type WebIdentity } from "./identity.js";
import { RelayClient, RelayError } from "./relay.js";
import {
  applyRemoteOperation,
  authorizedDeviceCount,
  delayOutbox,
  expectedSigningKey,
  markOutboxUploaded,
  markOutboxWaiting,
  pendingOutbox,
  refreshWaitingRecipients,
  setSyncState,
} from "./store.js";

export interface SyncContext {
  identity: WebIdentity; // mutable: replaced in place on vault-key rotation
  relay: RelayClient;
}

export class DeviceRevokedError extends Error {}

export async function runSyncCycle(ctx: SyncContext): Promise<void> {
  if ((await authorizedDeviceCount()) <= 1) return; // only this device — nothing to sync

  await setSyncState("last_sync_error", "");
  await refreshWaitingRecipients(ctx.identity.deviceId);

  let hadError = false;

  // 1. Drain the outbox.
  for (const item of await pendingOutbox()) {
    if (item.recipients.length === 0) {
      await markOutboxWaiting(item.id);
      continue;
    }
    try {
      await ctx.relay.uploadPackage(ctx.identity, {
        vaultId: ctx.identity.vaultId,
        senderDeviceId: ctx.identity.deviceId,
        envelope: item.envelope,
        recipients: item.recipients,
      });
      await markOutboxUploaded(item.id);
    } catch (error) {
      hadError = true;
      const message = error instanceof Error ? error.message : String(error);
      await delayOutbox(item.id, message);
      await setSyncState("last_sync_error", message);
      if (error instanceof RelayError && error.isAuthError) throw new DeviceRevokedError(message);
    }
  }

  // 2. Fetch inbound packages.
  let packages;
  try {
    packages = await ctx.relay.fetchPackages(ctx.identity, {
      vaultId: ctx.identity.vaultId,
      deviceId: ctx.identity.deviceId,
      limit: 32,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setSyncState("last_sync_error", message);
    if (error instanceof RelayError && error.isAuthError) throw new DeviceRevokedError(message);
    return;
  }

  // 3. Apply + ack.
  for (const pkg of packages) {
    if (pkg.packageId !== pkg.envelope.packageId) continue;
    try {
      const key = await expectedSigningKey(pkg.envelope.senderDeviceId);
      if (!key) continue; // unknown or revoked sender

      const operation = decryptOperation(ctx.identity, pkg.envelope, key) as unknown as SyncOperation;
      const rotation = await applyRemoteOperation(ctx.identity, pkg.envelope, operation);
      if (rotation) {
        const next = adoptVault(
          ctx.identity,
          ctx.identity.vaultId,
          rotation.epoch,
          decodeBase64Url(rotation.vaultKey),
        );
        await saveIdentity(next);
        ctx.identity = next;
      }
      await ackQuietly(ctx, pkg.envelope);
    } catch (error) {
      hadError = true;
      await setSyncState("last_sync_error", error instanceof Error ? error.message : String(error));
    }
  }

  if (!hadError) await setSyncState("last_successful_sync", new Date().toISOString());
}

async function ackQuietly(ctx: SyncContext, envelope: SyncEnvelope): Promise<void> {
  try {
    await ctx.relay.acknowledgePackage(ctx.identity, {
      vaultId: ctx.identity.vaultId,
      deviceId: ctx.identity.deviceId,
      packageId: envelope.packageId,
    });
  } catch {
    // Best-effort: a missed ack just redelivers; dedup handles it.
  }
}
