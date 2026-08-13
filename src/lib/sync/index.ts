// Web sync facade. Owns the loaded identity + relay client and exposes the
// notebook CRUD, status, sync, and pairing surface that the browser build of
// `api.ts` delegates to. This is the top of the web sync stack:
//   crypto → { idb, relay } → { identity, store } → engine/pairing → (this).

import type { Category, Note, NoteConflict, NoteListItem, PairingOffer, PairingProgress, SyncDevice, SyncStatus } from "../../types";
import { encodeBase64Url, randomBytes } from "./crypto.js";
import { adoptVault, loadOrBootstrap, saveIdentity, type WebIdentity } from "./identity.js";
import { DeviceRevokedError, runSyncCycle, type SyncContext } from "./engine.js";
import { RelayClient } from "./relay.js";
import {
  guestAcceptPairing,
  guestFinishPairing,
  hostCompletePairing,
  hostStartPairing,
} from "./pairing.js";
import * as store from "./store.js";

const RELAY_URL_STATE = "relay_url";
// Every shipping build needs a relay without requiring a per-device setup
// variable. Keep the build-time value as an override so local/staging builds
// can still point at an isolated relay.
const DEFAULT_RELAY_URL =
  (import.meta as { env?: Record<string, string> }).env?.VITE_PAPYRUS_RELAY_URL
  ?? "https://papyrus-sync-relay.c0di.workers.dev";

let contextPromise: Promise<SyncContext> | null = null;

async function context(): Promise<SyncContext> {
  if (contextPromise) return contextPromise;
  contextPromise = (async () => {
    const identity = await loadOrBootstrap();
    await store.ensureLocalDevice(identity);
    const relayUrl = (await store.getSyncState(RELAY_URL_STATE)) ?? DEFAULT_RELAY_URL ?? "";
    if (DEFAULT_RELAY_URL && !(await store.getSyncState(RELAY_URL_STATE))) {
      await store.setSyncState(RELAY_URL_STATE, DEFAULT_RELAY_URL);
    }
    return { identity, relay: new RelayClient(relayUrl) };
  })();
  return contextPromise;
}

async function relayConfigured(): Promise<boolean> {
  return Boolean(await store.getSyncState(RELAY_URL_STATE));
}

// Warm up the identity + local device so the notebook is ready before first use.
export async function initialize(): Promise<void> {
  await context();
}

// --- Notebook CRUD ------------------------------------------------------------

export const notebook = {
  async listCategories(): Promise<Category[]> {
    await context();
    return store.listCategories();
  },
  async createCategory(name: string): Promise<Category> {
    const ctx = await context();
    return store.createCategory(ctx.identity, name);
  },
  async renameCategory(id: string, name: string): Promise<Category> {
    const ctx = await context();
    return store.renameCategory(ctx.identity, id, name);
  },
  async moveCategory(id: string, direction: -1 | 1): Promise<Category[]> {
    const ctx = await context();
    return store.moveCategory(ctx.identity, id, direction);
  },
  async deleteCategory(id: string): Promise<void> {
    const ctx = await context();
    return store.deleteCategory(ctx.identity, id);
  },
  async listNotes(filter: string, search: string): Promise<NoteListItem[]> {
    await context();
    return store.listNotes(filter, search);
  },
  async getNote(id: string): Promise<Note | null> {
    await context();
    return store.getNote(id);
  },
  async saveNote(payload: { id: string; title: string; body: string; categoryId: string | null }): Promise<Note> {
    const ctx = await context();
    return store.saveNote(ctx.identity, payload);
  },
  async moveNote(id: string, categoryId: string | null): Promise<void> {
    const ctx = await context();
    return store.moveNote(ctx.identity, id, categoryId);
  },
  async trashNote(id: string): Promise<void> {
    const ctx = await context();
    return store.trashNote(ctx.identity, id);
  },
  async restoreNote(id: string): Promise<void> {
    const ctx = await context();
    return store.restoreNote(ctx.identity, id);
  },
  async deleteNote(id: string): Promise<void> {
    const ctx = await context();
    return store.deleteNotePermanently(ctx.identity, id);
  },
  async emptyTrash(): Promise<void> {
    const ctx = await context();
    return store.emptyTrash(ctx.identity);
  },
  async duplicateNote(id: string): Promise<Note> {
    const ctx = await context();
    return store.duplicateNote(ctx.identity, id);
  },
  async getNoteConflict(id: string): Promise<NoteConflict | null> {
    await context();
    return store.getNoteConflict(id);
  },
  async resolveNoteConflict(id: string, resolution: "current" | "other" | "both"): Promise<Note> {
    const ctx = await context();
    return store.resolveNoteConflict(ctx.identity, id, resolution);
  },
};

// --- Status + sync ------------------------------------------------------------

export async function getSyncStatus(): Promise<SyncStatus> {
  const ctx = await context();
  const [devices, pending, openConflicts, lastSuccessfulSync, lastError, configured] = await Promise.all([
    store.listDevices(),
    store.pendingOutboxCount(),
    store.openConflictCount(),
    store.getSyncState("last_successful_sync"),
    store.getSyncState("last_sync_error"),
    relayConfigured(),
  ]);

  const syncDevices: SyncDevice[] = devices.map((device) => ({
    id: device.id,
    displayName: device.displayName,
    isCurrentDevice: device.id === ctx.identity.deviceId,
    revokedAt: device.revokedAt,
    lastSeenAt: device.lastSeenAt,
  }));

  const attentionMessage = lastError || (openConflicts > 0 ? "Some notes need conflict review." : null);
  let status: SyncStatus["status"];
  if (attentionMessage) status = "Attention required";
  else if (pending > 0) status = "Changes pending";
  else if (configured) status = "Synced";
  else status = "Offline";

  return {
    status,
    lastSuccessfulSync,
    pendingOutgoingChanges: pending,
    devices: syncDevices,
    localDeviceName: ctx.identity.deviceName,
    attentionMessage,
    openConflicts,
  };
}

// A cycle pushes and pulls in one pass; overlapping runs would double-drain the
// outbox. With automatic sync (foreground poll + post-change debounce) plus the
// manual "Sync Now" button, concurrent calls are expected — so coalesce them: a
// call arriving while a cycle is in flight joins that cycle instead of starting
// a second one, and a call arriving after it completes starts a fresh cycle.
let cycleInFlight: Promise<void> | null = null;

export async function syncNow(): Promise<SyncStatus> {
  const ctx = await context();
  if (await relayConfigured()) {
    if (!cycleInFlight) {
      cycleInFlight = (async () => {
        try {
          await runSyncCycle(ctx);
        } catch (error) {
          if (!(error instanceof DeviceRevokedError)) throw error;
          await store.setSyncState("last_sync_error", "This device is no longer authorized for the notebook.");
        }
      })().finally(() => { cycleInFlight = null; });
    }
    await cycleInFlight;
  }
  return getSyncStatus();
}

export async function renameSyncDevice(name: string): Promise<SyncStatus> {
  const ctx = await context();
  const trimmed = name.trim() || ctx.identity.deviceName;
  ctx.identity = { ...ctx.identity, deviceName: trimmed };
  await saveIdentity(ctx.identity);
  await store.renameLocalDevice(ctx.identity.deviceId, trimmed);
  return getSyncStatus();
}

// Remove a paired device and rotate the vault key (port of `remove_sync_device`).
export async function removeSyncDevice(deviceId: string): Promise<SyncStatus> {
  const ctx = await context();
  if (deviceId === ctx.identity.deviceId) throw new Error("You cannot remove this device from itself.");
  if (!(await relayConfigured())) throw new Error("Sync is not configured on this browser.");

  await ctx.relay.revokeDevice(ctx.identity, { vaultId: ctx.identity.vaultId, deviceId });

  const revokedAt = new Date().toISOString();
  // Recipients + revocation/rotation packages are encrypted under the CURRENT
  // (pre-rotation) key so remaining peers can still decrypt them; the target is
  // excluded because we mark it revoked first.
  await store.markDeviceRevokedLocally(deviceId, revokedAt);
  await store.enqueueOperation(ctx.identity, { kind: "deviceRevocation", state: { deviceId, revokedAt } });

  const nextKey = randomBytes(32);
  const nextEpoch = ctx.identity.vaultKeyEpoch + 1;
  await store.enqueueOperation(ctx.identity, {
    kind: "vaultKeyRotation",
    state: { epoch: nextEpoch, vaultKey: encodeBase64Url(nextKey), rotatedAt: revokedAt },
  });

  ctx.identity = adoptVault(ctx.identity, ctx.identity.vaultId, nextEpoch, nextKey);
  await saveIdentity(ctx.identity);
  return getSyncStatus();
}

// --- Pairing ------------------------------------------------------------------

export async function startPairing(): Promise<PairingOffer> {
  const ctx = await context();
  const relayUrl = await store.getSyncState(RELAY_URL_STATE);
  if (!relayUrl) throw new Error("Set up sync on this browser before adding a device.");
  return hostStartPairing(ctx, relayUrl);
}

export async function acceptPairing(code: string): Promise<PairingProgress> {
  const ctx = await context();
  return guestAcceptPairing(ctx, code);
}

export async function completePairing(code: string): Promise<PairingProgress> {
  const ctx = await context();
  return hostCompletePairing(ctx, code);
}

export async function finishPairing(code: string): Promise<PairingProgress> {
  const ctx = await context();
  return guestFinishPairing(ctx, code);
}

// Point this browser at a relay (used to enable web-as-host, and by tests).
export async function configureRelayUrl(url: string): Promise<void> {
  const ctx = await context();
  await store.setSyncState(RELAY_URL_STATE, url);
  ctx.relay = new RelayClient(url);
}

// Test/reset helper.
export function resetContextForTests(): void {
  contextPromise = null;
  cycleInFlight = null;
}

export type { WebIdentity };
