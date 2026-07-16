// End-to-end integration test against a REAL relay worker.
//
// Simulates two independent web devices (a host that owns a vault and a guest
// browser joining it) in one process, each with its own IndexedDB namespace,
// and drives the full stack — pairing handshake + encrypted sync — over HTTP
// against a locally-running relay.
//
// Run:
//   (cd relay && npx wrangler d1 migrations apply papyrus-sync-relay --local)
//   (cd relay && npx wrangler dev --port 8787 --local) &
//   PAPYRUS_RELAY=http://localhost:8787 npx vitest run sync.integration
//
// Skips itself when PAPYRUS_RELAY is unset so the default unit run stays green.
import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { setActiveDatabase } from "./idb.js";
import { bootstrapVault, type WebIdentity } from "./identity.js";
import { RelayClient } from "./relay.js";
import { runSyncCycle, type SyncContext } from "./engine.js";
import {
  guestAcceptPairing,
  guestFinishPairing,
  hostCompletePairing,
  hostStartPairing,
} from "./pairing.js";
import * as store from "./store.js";
import { encodeBase64Url } from "./crypto.js";

const RELAY_URL = process.env.PAPYRUS_RELAY;
const run = RELAY_URL ? describe : describe.skip;

// Bind store operations to a given device's database, run them, and return.
async function on<T>(db: string, work: () => Promise<T>): Promise<T> {
  setActiveDatabase(db);
  return work();
}

run("web sync end-to-end against a live relay", () => {
  it("pairs a browser into a vault and syncs an encrypted note both ways", async () => {
    const relay = new RelayClient(RELAY_URL!);
    const suffix = encodeBase64Url(crypto.getRandomValues(new Uint8Array(6)));
    const hostDb = `host-${suffix}`;
    const guestDb = `guest-${suffix}`;

    // --- Host bootstraps a vault, configures the relay, seeds a note ---
    let host: WebIdentity = await on(hostDb, async () => {
      const id = await bootstrapVault("Host Mac");
      await store.ensureLocalDevice(id);
      await store.setSyncState("relay_url", RELAY_URL!);
      return id;
    });
    const hostCtx: SyncContext = { identity: host, relay };

    await on(hostDb, () =>
      store.saveNote(hostCtx.identity, {
        id: crypto.randomUUID(),
        title: "",
        body: "# Seeded before pairing\n\nfrom the host",
        categoryId: null,
      }),
    );

    // --- Host opens a pairing session ---
    const offer = await on(hostDb, () => hostStartPairing(hostCtx, RELAY_URL!));
    expect(offer.code).toMatch(/^papyrus-pair-v1:/);

    // --- Guest bootstraps its own (empty) vault, then accepts the code ---
    const guest = await on(guestDb, async () => {
      const id = await bootstrapVault("Guest Browser");
      await store.ensureLocalDevice(id);
      return id;
    });
    const guestCtx: SyncContext = { identity: guest, relay: new RelayClient(RELAY_URL!) };

    const accepted = await on(guestDb, () => guestAcceptPairing(guestCtx, offer.code));
    expect(accepted.ready).toBe(false);

    // --- Host claims the guest, authorizes it, seals + uploads the snapshot ---
    const completed = await on(hostDb, () => hostCompletePairing(hostCtx, offer.code));
    expect(completed.ready).toBe(true);

    // --- Guest finishes: opens the sealed snapshot and adopts the vault ---
    const finished = await on(guestDb, () => guestFinishPairing(guestCtx, offer.code));
    expect(finished.ready).toBe(true);

    // Guest now shares the host's vault identity...
    expect(guestCtx.identity.vaultId).toBe(hostCtx.identity.vaultId);
    expect(encodeBase64Url(guestCtx.identity.vaultKey)).toBe(encodeBase64Url(hostCtx.identity.vaultKey));

    // ...and received the seeded note through the sealed snapshot.
    const seeded = await on(guestDb, () => store.listNotes("all", ""));
    expect(seeded).toHaveLength(1);
    expect(seeded[0].preview).toContain("from the host");

    // --- Ongoing sync: host edits a new note, cycle pushes it to the relay ---
    const noteId = crypto.randomUUID();
    await on(hostDb, () =>
      store.saveNote(hostCtx.identity, {
        id: noteId,
        title: "",
        body: "# Live edit\n\nencrypted over the relay 🔐",
        categoryId: null,
      }),
    );
    await on(hostDb, () => runSyncCycle(hostCtx));

    // --- Guest pulls, decrypts, and applies it ---
    await on(guestDb, () => runSyncCycle(guestCtx));
    const guestNote = await on(guestDb, () => store.getNote(noteId));
    expect(guestNote?.body).toContain("encrypted over the relay 🔐");

    // --- Reverse direction: guest edits, host receives ---
    await on(guestDb, () =>
      store.saveNote(guestCtx.identity, {
        id: noteId,
        title: "",
        body: "# Live edit\n\nedited on the guest ✍️",
        categoryId: null,
      }),
    );
    await on(guestDb, () => runSyncCycle(guestCtx));
    await on(hostDb, () => runSyncCycle(hostCtx));
    const hostNote = await on(hostDb, () => store.getNote(noteId));
    expect(hostNote?.body).toContain("edited on the guest ✍️");
  }, 30000);

  it("merges a guest's own notes into the vault it joins instead of wiping them", async () => {
    const relay = new RelayClient(RELAY_URL!);
    const suffix = encodeBase64Url(crypto.getRandomValues(new Uint8Array(6)));
    const hostDb = `merge-host-${suffix}`;
    const guestDb = `merge-guest-${suffix}`;

    const host: WebIdentity = await on(hostDb, async () => {
      const id = await bootstrapVault("Host Mac");
      await store.ensureLocalDevice(id);
      await store.setSyncState("relay_url", RELAY_URL!);
      return id;
    });
    const hostCtx: SyncContext = { identity: host, relay };
    await on(hostDb, () =>
      store.saveNote(hostCtx.identity, {
        id: crypto.randomUUID(),
        title: "",
        body: "# Host note\n\nlived in the vault first",
        categoryId: null,
      }),
    );

    // The guest is not a blank device: it has its own category, a live note, and
    // a trashed one — the situation that used to be refused outright.
    const guest = await on(guestDb, async () => {
      const id = await bootstrapVault("Guest Browser");
      await store.ensureLocalDevice(id);
      return id;
    });
    const guestCtx: SyncContext = { identity: guest, relay: new RelayClient(RELAY_URL!) };
    const carriedNoteId = crypto.randomUUID();
    const trashedNoteId = crypto.randomUUID();
    await on(guestDb, async () => {
      const category = await store.createCategory(guestCtx.identity, "Guest Only");
      await store.saveNote(guestCtx.identity, {
        id: carriedNoteId,
        title: "",
        body: "# Guest note\n\nwritten before pairing 📝",
        categoryId: category.id,
      });
      await store.saveNote(guestCtx.identity, {
        id: trashedNoteId,
        title: "",
        body: "# Guest trash\n\nalready in the bin",
        categoryId: null,
      });
      await store.trashNote(guestCtx.identity, trashedNoteId);
    });

    const offer = await on(hostDb, () => hostStartPairing(hostCtx, RELAY_URL!));
    await on(guestDb, () => guestAcceptPairing(guestCtx, offer.code));
    await on(hostDb, () => hostCompletePairing(hostCtx, offer.code));
    const finished = await on(guestDb, () => guestFinishPairing(guestCtx, offer.code));
    expect(finished.ready).toBe(true);
    expect(finished.message).toContain("2 notes from this device merged in");

    // The guest kept its own notes AND received the host's.
    const guestNotes = await on(guestDb, () => store.listNotes("all", ""));
    expect(guestNotes.map((n) => n.preview).join("\n")).toContain("written before pairing 📝");
    expect(guestNotes.map((n) => n.preview).join("\n")).toContain("lived in the vault first");
    expect(await on(guestDb, () => store.listCategories())).toHaveLength(1);

    // A trashed note stays trashed rather than being resurrected by the merge.
    const trash = await on(guestDb, () => store.listNotes("trash", ""));
    expect(trash).toHaveLength(1);
    expect(trash[0].id).toBe(trashedNoteId);

    // The pre-pairing notebook is recoverable regardless.
    const archives = await on(guestDb, () => store.listArchives());
    expect(archives).toHaveLength(1);
    expect(archives[0].snapshot.notes).toHaveLength(2);

    // ...and the carried notes reach the rest of the vault over the relay.
    await on(guestDb, () => runSyncCycle(guestCtx));
    await on(hostDb, () => runSyncCycle(hostCtx));
    const onHost = await on(hostDb, () => store.getNote(carriedNoteId));
    expect(onHost?.body).toContain("written before pairing 📝");
    expect(await on(hostDb, () => store.listCategories())).toHaveLength(1);
    expect(await on(hostDb, () => store.openConflictCount())).toBe(0);
  }, 30000);
});
