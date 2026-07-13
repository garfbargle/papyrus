import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyD1Migrations, env, SELF } from "cloudflare:test";

type TestDevice = { id: string; keys: CryptoKeyPair; publicKey: string };
const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let value = ""; for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function device(id: string): Promise<TestDevice> {
  const keys = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicKey = base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  return { id, keys, publicKey };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedPost(path: string, author: TestDevice, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload); const timestamp = new Date().toISOString();
  const message = encoder.encode(`papyrus-relay-v1\nPOST\n${path}\n${timestamp}\n${await sha256Hex(encoder.encode(body))}`);
  const signature = base64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", author.keys.privateKey, message)));
  return SELF.fetch(`https://relay.test${path}`, { method: "POST", headers: {
    "content-type": "application/json", "x-papyrus-device": author.id, "x-papyrus-signing-key": author.publicKey,
    "x-papyrus-timestamp": timestamp, "x-papyrus-signature": signature,
  }, body });
}

async function addDevice(vaultId: string, value: TestDevice) {
  await env.SYNC_DB.prepare("INSERT INTO devices(vault_id, id, signing_key, status, created_at) VALUES (?, ?, ?, 'active', ?)")
    .bind(vaultId, value.id, value.publicKey, new Date().toISOString()).run();
}

function envelope(vaultId: string, author: TestDevice, packageId: string) {
  return { version: 1, packageId, vaultId, senderDeviceId: author.id, senderSigningKey: author.publicKey, keyEpoch: 1,
    createdAt: new Date().toISOString(), nonce: base64Url(new Uint8Array(24).fill(1)), ciphertext: base64Url(new Uint8Array([1, 2, 3])), signature: base64Url(new Uint8Array(64).fill(2)) };
}

beforeAll(async () => {
  const testEnv = env as Env & { TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1] };
  await applyD1Migrations(testEnv.SYNC_DB, testEnv.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await env.SYNC_DB.batch([
    env.SYNC_DB.prepare("DELETE FROM deliveries"), env.SYNC_DB.prepare("DELETE FROM packages"),
    env.SYNC_DB.prepare("DELETE FROM pairing_sessions"), env.SYNC_DB.prepare("DELETE FROM devices"), env.SYNC_DB.prepare("DELETE FROM vaults"),
  ]);
});

describe("encrypted relay authorization", () => {
  it("routes an opaque package only to its addressed active device", async () => {
    const host = await device("host"); const phone = await device("phone"); const vaultId = "vault";
    await env.SYNC_DB.prepare("INSERT INTO vaults(id, created_at) VALUES (?, ?)").bind(vaultId, new Date().toISOString()).run();
    await addDevice(vaultId, host); await addDevice(vaultId, phone);
    const packageId = "package-one";
    const upload = await signedPost("/v1/packages", host, { vaultId, senderDeviceId: host.id, envelope: envelope(vaultId, host, packageId), recipients: [phone.id] });
    expect(upload.status).toBe(200);
    const fetched = await signedPost("/v1/packages/fetch", phone, { vaultId, deviceId: phone.id, limit: 32 });
    expect(fetched.status).toBe(200); expect((await fetched.json() as { packages: unknown[] }).packages).toHaveLength(1);
    const hostInbox = await signedPost("/v1/packages/fetch", host, { vaultId, deviceId: host.id, limit: 32 });
    expect((await hostInbox.json() as { packages: unknown[] }).packages).toHaveLength(0);
    expect((await signedPost("/v1/packages/ack", phone, { vaultId, deviceId: phone.id, packageId })).status).toBe(200);
    expect(await env.SYNC_DB.prepare("SELECT id FROM packages WHERE id = ?").bind(packageId).first()).toBeNull();
    expect(await env.SYNC_PACKAGES.get(`packages/${vaultId}/${packageId}`)).toBeNull();
  });

  it("blocks a revoked device from both upload and download", async () => {
    const host = await device("host"); const phone = await device("phone"); const vaultId = "vault";
    await env.SYNC_DB.prepare("INSERT INTO vaults(id, created_at) VALUES (?, ?)").bind(vaultId, new Date().toISOString()).run();
    await addDevice(vaultId, host); await addDevice(vaultId, phone);
    expect((await signedPost("/v1/devices/revoke", host, { vaultId, deviceId: phone.id })).status).toBe(200);
    expect((await signedPost("/v1/packages/fetch", phone, { vaultId, deviceId: phone.id, limit: 32 })).status).toBe(403);
    const upload = { vaultId, senderDeviceId: phone.id, envelope: envelope(vaultId, phone, "revoked-package"), recipients: [host.id] };
    expect((await signedPost("/v1/packages", phone, upload)).status).toBe(403);
  });

  async function claimSession(host: TestDevice, guest: TestDevice, vaultId: string, sessionId: string, secret: string) {
    const secretHash = await sha256Hex(encoder.encode(secret));
    const expiresAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    expect((await signedPost("/v1/pairing/start", host, { vaultId, sessionId, secretHash, expiresAt })).status).toBe(200);
    const hello = await SELF.fetch("https://relay.test/v1/pairing/hello", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, secret, deviceId: guest.id, displayName: "Phone", signingKey: guest.publicKey, agreementKey: base64Url(new Uint8Array(32).fill(3)) }) });
    expect(hello.status).toBe(200);
  }

  it("makes a re-pair of an already-registered device idempotent instead of a 500", async () => {
    const host = await device("host"); const guest = await device("guest"); const vaultId = "vault";
    // First pairing: start auto-creates the vault + host, hello claims, complete registers the guest.
    await claimSession(host, guest, vaultId, "session-1", "secret-1");
    expect((await signedPost("/v1/pairing/complete", host, { sessionId: "session-1", deviceId: guest.id, sealedPayload: "sealed-1" })).status).toBe(200);
    // Second pairing of the SAME device to the SAME vault (device never finished before) must succeed, not 500.
    await claimSession(host, guest, vaultId, "session-2", "secret-2");
    expect((await signedPost("/v1/pairing/complete", host, { sessionId: "session-2", deviceId: guest.id, sealedPayload: "sealed-2" })).status).toBe(200);
    const rows = await env.SYNC_DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE id = ?").bind(guest.id).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("rejects starting a new vault for a device already linked elsewhere with a 409, not a 500", async () => {
    const host = await device("host"); const guest = await device("guest");
    await claimSession(host, guest, "vault-a", "session-a", "secret-a");
    expect((await signedPost("/v1/pairing/complete", host, { sessionId: "session-a", deviceId: guest.id, sealedPayload: "sealed" })).status).toBe(200);
    // The guest device now belongs to vault-a. Trying to host its own new vault must be a clean 409.
    const expiresAt = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    const conflict = await signedPost("/v1/pairing/start", guest, { vaultId: "vault-b", sessionId: "session-b", secretHash: await sha256Hex(encoder.encode("x")), expiresAt });
    expect(conflict.status).toBe(409);
  });

  it("rejects a proof if the request body changes after signing", async () => {
    const author = await device("host"); const body = JSON.stringify({ vaultId: "vault", deviceId: "host", limit: 32 }); const timestamp = new Date().toISOString();
    const original = encoder.encode(`papyrus-relay-v1\nPOST\n/v1/packages/fetch\n${timestamp}\n${await sha256Hex(encoder.encode(body))}`);
    const signature = base64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", author.keys.privateKey, original)));
    const response = await SELF.fetch("https://relay.test/v1/packages/fetch", { method: "POST", headers: {
      "content-type": "application/json", "x-papyrus-device": author.id, "x-papyrus-signing-key": author.publicKey,
      "x-papyrus-timestamp": timestamp, "x-papyrus-signature": signature,
    }, body: JSON.stringify({ vaultId: "changed", deviceId: "host", limit: 32 }) });
    expect(response.status).toBe(401);
  });
});
