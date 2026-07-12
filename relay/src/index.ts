type JsonObject = Record<string, unknown>;

type RelayEnvelope = {
  version: number;
  packageId: string;
  vaultId: string;
  senderDeviceId: string;
  senderSigningKey: string;
  keyEpoch: number;
  createdAt: string;
  nonce: string;
  ciphertext: string;
  signature: string;
};

type UploadPackage = {
  vaultId: string;
  senderDeviceId: string;
  envelope: RelayEnvelope;
  recipients: string[];
};

type FetchPackages = { vaultId: string; deviceId: string; limit: number };
type AcknowledgePackage = { vaultId: string; deviceId: string; packageId: string };
type PairingStart = { vaultId: string; sessionId: string; secretHash: string; expiresAt: string };
type PairingHello = { sessionId: string; secret: string; deviceId: string; displayName: string; signingKey: string; agreementKey: string };
type PairingClaim = { vaultId: string; sessionId: string };
type PairingComplete = { sessionId: string; deviceId: string; sealedPayload: string };
type PairingFinish = { sessionId: string; secret: string; deviceId: string };
type RevokeDevice = { vaultId: string; deviceId: string };

type DeviceRow = { signing_key: string; status: "active" | "revoked" };
type PackageRow = { id: string; object_key: string };
type PackageCompletionRow = { object_key: string; remaining: number };
type DeliveryRow = { cursor: number; package_id: string; object_key: string };
type PairingRow = {
  id: string; vault_id: string; host_device_id: string; secret_hash: string; expires_at: string; state: string;
  guest_device_id: string | null; guest_signing_key: string | null; guest_agreement_key: string | null;
  guest_display_name: string | null; sealed_payload_key: string | null;
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_REQUEST_BYTES = 48 * 1024 * 1024;
const MAX_DELIVERY_BATCH = 32;
const PAIRING_LIFETIME_MS = 5 * 60 * 1000;
const RETENTION_DAYS = 90;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(value: JsonObject, name: string, max = 1024): string {
  const entry = value[name];
  if (typeof entry !== "string" || entry.length === 0 || entry.length > max) throw new HttpError(400, "Invalid request.");
  return entry;
}

function numericField(value: JsonObject, name: string): number {
  const entry = value[name];
  if (typeof entry !== "number" || !Number.isSafeInteger(entry)) throw new HttpError(400, "Invalid request.");
  return entry;
}

function id(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(value)) throw new HttpError(400, "Invalid identifier.");
  return value;
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, "Invalid encoded value.");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch { throw new HttpError(400, "Invalid encoded value."); }
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJson(request: Request): Promise<{ raw: Uint8Array; value: JsonObject }> {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) throw new HttpError(413, "Package is too large.");
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_REQUEST_BYTES) throw new HttpError(413, "Package is too large.");
  let value: unknown;
  try { value = JSON.parse(decoder.decode(raw)); } catch { throw new HttpError(400, "Invalid JSON."); }
  if (!isObject(value)) throw new HttpError(400, "Invalid JSON.");
  return { raw, value };
}

async function verifiedProof(request: Request, raw: Uint8Array): Promise<{ id: string; signingKey: string }> {
  const deviceId = id(request.headers.get("x-papyrus-device") || "");
  const signingKey = field({ value: request.headers.get("x-papyrus-signing-key") }, "value", 128);
  const timestamp = field({ value: request.headers.get("x-papyrus-timestamp") }, "value", 64);
  const signature = field({ value: request.headers.get("x-papyrus-signature") }, "value", 256);
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) throw new HttpError(401, "Request proof expired.");
  const publicKey = decodeBase64Url(signingKey);
  const signed = encoder.encode(`papyrus-relay-v1\n${request.method}\n${new URL(request.url).pathname}\n${timestamp}\n${await sha256Hex(raw)}`);
  const valid = await crypto.subtle.verify("Ed25519", await crypto.subtle.importKey("raw", buffer(publicKey), "Ed25519", false, ["verify"]), buffer(decodeBase64Url(signature)), buffer(signed));
  if (!valid) throw new HttpError(401, "Invalid request proof.");
  return { id: deviceId, signingKey };
}

async function authenticatedDevice(request: Request, raw: Uint8Array, env: Env): Promise<{ id: string; signingKey: string }> {
  const proof = await verifiedProof(request, raw);
  const known = await env.SYNC_DB.prepare("SELECT signing_key, status FROM devices WHERE id = ? LIMIT 1").bind(proof.id).first<DeviceRow>();
  if (!known || known.signing_key !== proof.signingKey || known.status !== "active") throw new HttpError(403, "Device is not authorized.");
  return proof;
}

async function verifyGuestProof(request: Request, raw: Uint8Array, expectedDeviceId: string, expectedSigningKey: string): Promise<void> {
  const deviceId = id(request.headers.get("x-papyrus-device") || "");
  const signingKey = field({ value: request.headers.get("x-papyrus-signing-key") }, "value", 128);
  const timestamp = field({ value: request.headers.get("x-papyrus-timestamp") }, "value", 64);
  const signature = field({ value: request.headers.get("x-papyrus-signature") }, "value", 256);
  if (deviceId !== expectedDeviceId || signingKey !== expectedSigningKey) throw new HttpError(403, "Pairing device does not match.");
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) throw new HttpError(401, "Request proof expired.");
  const message = encoder.encode(`papyrus-relay-v1\n${request.method}\n${new URL(request.url).pathname}\n${timestamp}\n${await sha256Hex(raw)}`);
  const key = await crypto.subtle.importKey("raw", buffer(decodeBase64Url(signingKey)), "Ed25519", false, ["verify"]);
  const valid = await crypto.subtle.verify("Ed25519", key, buffer(decodeBase64Url(signature)), buffer(message));
  if (!valid) throw new HttpError(401, "Invalid request proof.");
}

function parseEnvelope(value: unknown): RelayEnvelope {
  if (!isObject(value)) throw new HttpError(400, "Invalid sync envelope.");
  const envelope: RelayEnvelope = {
    version: numericField(value, "version"), packageId: id(field(value, "packageId", 160)), vaultId: id(field(value, "vaultId", 160)),
    senderDeviceId: id(field(value, "senderDeviceId", 160)), senderSigningKey: field(value, "senderSigningKey", 128), keyEpoch: numericField(value, "keyEpoch"),
    createdAt: field(value, "createdAt", 64), nonce: field(value, "nonce", 128), ciphertext: field(value, "ciphertext", MAX_REQUEST_BYTES), signature: field(value, "signature", 256),
  };
  if (envelope.version !== 1 || envelope.keyEpoch < 1) throw new HttpError(400, "Unsupported sync envelope.");
  return envelope;
}

function parseUpload(value: JsonObject): UploadPackage {
  const recipientsRaw = value.recipients;
  if (!Array.isArray(recipientsRaw) || recipientsRaw.length > 64 || !recipientsRaw.every((entry) => typeof entry === "string")) throw new HttpError(400, "Invalid recipients.");
  const envelope = parseEnvelope(value.envelope);
  const vaultId = id(field(value, "vaultId", 160));
  const senderDeviceId = id(field(value, "senderDeviceId", 160));
  const recipients = recipientsRaw.map((recipient) => id(recipient));
  if (vaultId !== envelope.vaultId || senderDeviceId !== envelope.senderDeviceId) throw new HttpError(400, "Envelope routing does not match.");
  return { vaultId, senderDeviceId, envelope, recipients: Array.from(new Set(recipients)) };
}

async function activeDevice(env: Env, vaultId: string, deviceId: string): Promise<DeviceRow> {
  const device = await env.SYNC_DB.prepare("SELECT signing_key, status FROM devices WHERE vault_id = ? AND id = ?").bind(vaultId, deviceId).first<DeviceRow>();
  if (!device || device.status !== "active") throw new HttpError(403, "Device is not authorized.");
  return device;
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  const { raw, value } = await readJson(request);
  const auth = await authenticatedDevice(request, raw, env);
  const upload = parseUpload(value);
  if (auth.id !== upload.senderDeviceId || auth.signingKey !== upload.envelope.senderSigningKey) throw new HttpError(403, "Sender proof does not match package.");
  const device = await activeDevice(env, upload.vaultId, upload.senderDeviceId);
  if (device.signing_key !== auth.signingKey) throw new HttpError(403, "Sender is not authorized.");
  for (const recipient of upload.recipients) await activeDevice(env, upload.vaultId, recipient);
  const objectKey = `packages/${upload.vaultId}/${upload.envelope.packageId}`;
  const expiresAt = new Date(Date.now() + RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const envelopeBytes = encoder.encode(JSON.stringify(upload.envelope));
  await env.SYNC_PACKAGES.put(objectKey, envelopeBytes, { httpMetadata: { contentType: "application/json" } });
  const packageInsert = env.SYNC_DB.prepare("INSERT OR IGNORE INTO packages(id, vault_id, sender_device_id, object_key, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(upload.envelope.packageId, upload.vaultId, upload.senderDeviceId, objectKey, new Date().toISOString(), expiresAt);
  const deliveries = upload.recipients.map((recipient) => env.SYNC_DB.prepare("INSERT OR IGNORE INTO deliveries(package_id, vault_id, device_id, delivered_at) VALUES (?, ?, ?, ?)").bind(upload.envelope.packageId, upload.vaultId, recipient, new Date().toISOString()));
  await env.SYNC_DB.batch([packageInsert, ...deliveries]);
  return Response.json({ accepted: true });
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const { raw, value } = await readJson(request);
  const auth = await authenticatedDevice(request, raw, env);
  const payload: FetchPackages = { vaultId: id(field(value, "vaultId", 160)), deviceId: id(field(value, "deviceId", 160)), limit: numericField(value, "limit") };
  if (auth.id !== payload.deviceId) throw new HttpError(403, "Device proof does not match inbox.");
  await activeDevice(env, payload.vaultId, payload.deviceId);
  const limit = Math.max(1, Math.min(MAX_DELIVERY_BATCH, payload.limit));
  const result = await env.SYNC_DB.prepare(
    "SELECT d.cursor, d.package_id, p.object_key FROM deliveries d JOIN packages p ON p.id = d.package_id WHERE d.vault_id = ? AND d.device_id = ? AND d.acknowledged_at IS NULL AND p.expires_at > ? ORDER BY d.cursor LIMIT ?"
  ).bind(payload.vaultId, payload.deviceId, new Date().toISOString(), limit).all<DeliveryRow>();
  const packages: Array<{ cursor: string; packageId: string; envelope: RelayEnvelope }> = [];
  for (const delivery of result.results) {
    const object = await env.SYNC_PACKAGES.get(delivery.object_key);
    if (!object) continue;
    const parsed: unknown = JSON.parse(await object.text());
    packages.push({ cursor: String(delivery.cursor), packageId: delivery.package_id, envelope: parseEnvelope(parsed) });
  }
  return Response.json({ packages });
}

async function handleAcknowledge(request: Request, env: Env): Promise<Response> {
  const { raw, value } = await readJson(request);
  const auth = await authenticatedDevice(request, raw, env);
  const payload: AcknowledgePackage = { vaultId: id(field(value, "vaultId", 160)), deviceId: id(field(value, "deviceId", 160)), packageId: id(field(value, "packageId", 160)) };
  if (auth.id !== payload.deviceId) throw new HttpError(403, "Device proof does not match receipt.");
  await activeDevice(env, payload.vaultId, payload.deviceId);
  await env.SYNC_DB.prepare("UPDATE deliveries SET acknowledged_at = ? WHERE vault_id = ? AND device_id = ? AND package_id = ?").bind(new Date().toISOString(), payload.vaultId, payload.deviceId, payload.packageId).run();
  const completion = await env.SYNC_DB.prepare(
    "SELECT p.object_key, SUM(CASE WHEN d.acknowledged_at IS NULL THEN 1 ELSE 0 END) AS remaining FROM packages p JOIN deliveries d ON d.package_id = p.id WHERE p.id = ? AND p.vault_id = ? GROUP BY p.id, p.object_key"
  ).bind(payload.packageId, payload.vaultId).first<PackageCompletionRow>();
  if (completion && Number(completion.remaining) === 0) {
    await env.SYNC_PACKAGES.delete(completion.object_key);
    await env.SYNC_DB.batch([
      env.SYNC_DB.prepare("DELETE FROM deliveries WHERE package_id = ?").bind(payload.packageId),
      env.SYNC_DB.prepare("DELETE FROM packages WHERE id = ?").bind(payload.packageId),
    ]);
  }
  return Response.json({ acknowledged: true });
}

async function handleDeviceRevocation(request: Request, env: Env): Promise<Response> {
  const { raw, value } = await readJson(request);
  const auth = await authenticatedDevice(request, raw, env);
  const payload: RevokeDevice = { vaultId: id(field(value, "vaultId", 160)), deviceId: id(field(value, "deviceId", 160)) };
  if (auth.id === payload.deviceId) throw new HttpError(400, "A device cannot revoke itself.");
  await activeDevice(env, payload.vaultId, auth.id);
  const result = await env.SYNC_DB.prepare("UPDATE devices SET status = 'revoked', revoked_at = ? WHERE vault_id = ? AND id = ? AND status = 'active'").bind(new Date().toISOString(), payload.vaultId, payload.deviceId).run();
  if (result.meta.changes !== 1) throw new HttpError(404, "Device was not found.");
  return Response.json({ revoked: true });
}

async function handlePairingStart(request: Request, env: Env): Promise<Response> {
  const { raw, value } = await readJson(request);
  const auth = await verifiedProof(request, raw);
  const payload: PairingStart = { vaultId: id(field(value, "vaultId", 160)), sessionId: id(field(value, "sessionId", 160)), secretHash: field(value, "secretHash", 128), expiresAt: field(value, "expiresAt", 64) };
  const expiration = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiration) || expiration <= Date.now() || expiration > Date.now() + PAIRING_LIFETIME_MS) throw new HttpError(400, "Invalid pairing expiry.");
  const existingVault = await env.SYNC_DB.prepare("SELECT id FROM vaults WHERE id = ?").bind(payload.vaultId).first<{ id: string }>();
  if (!existingVault) {
    await env.SYNC_DB.batch([
      env.SYNC_DB.prepare("INSERT INTO vaults(id, created_at) VALUES (?, ?)").bind(payload.vaultId, new Date().toISOString()),
      env.SYNC_DB.prepare("INSERT INTO devices(vault_id, id, signing_key, status, created_at) VALUES (?, ?, ?, 'active', ?)").bind(payload.vaultId, auth.id, auth.signingKey, new Date().toISOString()),
    ]);
  } else {
    const device = await activeDevice(env, payload.vaultId, auth.id);
    if (device.signing_key !== auth.signingKey) throw new HttpError(403, "Device is not authorized.");
  }
  await env.SYNC_DB.prepare("INSERT OR REPLACE INTO pairing_sessions(id, vault_id, host_device_id, secret_hash, expires_at, created_at, state) VALUES (?, ?, ?, ?, ?, ?, 'open')")
    .bind(payload.sessionId, payload.vaultId, auth.id, payload.secretHash, payload.expiresAt, new Date().toISOString()).run();
  return Response.json({ created: true });
}

async function handlePairingHello(request: Request, env: Env): Promise<Response> {
  const { value } = await readJson(request);
  const payload: PairingHello = { sessionId: id(field(value, "sessionId", 160)), secret: field(value, "secret", 128), deviceId: id(field(value, "deviceId", 160)), displayName: field(value, "displayName", 160), signingKey: field(value, "signingKey", 128), agreementKey: field(value, "agreementKey", 128) };
  const pairing = await env.SYNC_DB.prepare("SELECT id, secret_hash, expires_at, state FROM pairing_sessions WHERE id = ?").bind(payload.sessionId).first<PairingRow>();
  if (!pairing || pairing.state !== "open" || Date.parse(pairing.expires_at) <= Date.now()) throw new HttpError(410, "Pairing code expired.");
  if (await sha256Hex(encoder.encode(payload.secret)) !== pairing.secret_hash) throw new HttpError(403, "Invalid pairing code.");
  decodeBase64Url(payload.signingKey); decodeBase64Url(payload.agreementKey);
  await env.SYNC_DB.prepare("UPDATE pairing_sessions SET state = 'claimed', guest_device_id = ?, guest_signing_key = ?, guest_agreement_key = ?, guest_display_name = ? WHERE id = ?").bind(payload.deviceId, payload.signingKey, payload.agreementKey, payload.displayName, payload.sessionId).run();
  return Response.json({ waitingForApproval: true });
}

async function handlePairingClaim(request: Request, env: Env): Promise<Response> {
  const { raw, value } = await readJson(request);
  const auth = await authenticatedDevice(request, raw, env);
  const payload: PairingClaim = { vaultId: id(field(value, "vaultId", 160)), sessionId: id(field(value, "sessionId", 160)) };
  const pairing = await env.SYNC_DB.prepare("SELECT id, vault_id, host_device_id, expires_at, state, guest_device_id, guest_signing_key, guest_agreement_key, guest_display_name FROM pairing_sessions WHERE id = ?").bind(payload.sessionId).first<PairingRow>();
  if (!pairing || pairing.vault_id !== payload.vaultId || pairing.host_device_id !== auth.id || Date.parse(pairing.expires_at) <= Date.now()) throw new HttpError(410, "Pairing session expired.");
  if (pairing.state === "open") return Response.json({ ready: false });
  if (!pairing.guest_device_id || !pairing.guest_signing_key || !pairing.guest_agreement_key || !pairing.guest_display_name) throw new HttpError(409, "Pairing claim is incomplete.");
  return Response.json({ ready: true, deviceId: pairing.guest_device_id, displayName: pairing.guest_display_name, signingKey: pairing.guest_signing_key, agreementKey: pairing.guest_agreement_key });
}

async function handlePairingComplete(request: Request, env: Env): Promise<Response> {
  const { raw, value } = await readJson(request);
  const auth = await authenticatedDevice(request, raw, env);
  const payload: PairingComplete = { sessionId: id(field(value, "sessionId", 160)), deviceId: id(field(value, "deviceId", 160)), sealedPayload: field(value, "sealedPayload", MAX_REQUEST_BYTES) };
  const pairing = await env.SYNC_DB.prepare("SELECT id, vault_id, host_device_id, state, guest_device_id, guest_signing_key FROM pairing_sessions WHERE id = ?").bind(payload.sessionId).first<PairingRow>();
  if (!pairing || pairing.state !== "claimed" || pairing.host_device_id !== auth.id || pairing.guest_device_id !== payload.deviceId || !pairing.guest_signing_key) throw new HttpError(409, "Pairing session is not ready.");
  await activeDevice(env, pairing.vault_id, auth.id);
  const sealedPayloadKey = `pairing/${payload.sessionId}`;
  await env.SYNC_PACKAGES.put(sealedPayloadKey, payload.sealedPayload, { httpMetadata: { contentType: "application/json" } });
  await env.SYNC_DB.batch([
    env.SYNC_DB.prepare("INSERT INTO devices(vault_id, id, signing_key, status, created_at) VALUES (?, ?, ?, 'active', ?)").bind(pairing.vault_id, payload.deviceId, pairing.guest_signing_key, new Date().toISOString()),
    env.SYNC_DB.prepare("UPDATE pairing_sessions SET state = 'complete', sealed_payload_key = ? WHERE id = ?").bind(sealedPayloadKey, payload.sessionId),
  ]);
  return Response.json({ complete: true });
}

async function handlePairingFinish(request: Request, env: Env): Promise<Response> {
  const { raw, value } = await readJson(request);
  const payload: PairingFinish = { sessionId: id(field(value, "sessionId", 160)), secret: field(value, "secret", 128), deviceId: id(field(value, "deviceId", 160)) };
  const pairing = await env.SYNC_DB.prepare("SELECT id, secret_hash, expires_at, state, guest_device_id, guest_signing_key, sealed_payload_key FROM pairing_sessions WHERE id = ?").bind(payload.sessionId).first<PairingRow>();
  if (!pairing || pairing.guest_device_id !== payload.deviceId || !pairing.guest_signing_key || Date.parse(pairing.expires_at) <= Date.now()) throw new HttpError(410, "Pairing session expired.");
  await verifyGuestProof(request, raw, payload.deviceId, pairing.guest_signing_key);
  if (await sha256Hex(encoder.encode(payload.secret)) !== pairing.secret_hash) throw new HttpError(403, "Invalid pairing code.");
  if (pairing.state !== "complete" || !pairing.sealed_payload_key) throw new HttpError(410, "Pairing snapshot already used or expired.");
  const consume = await env.SYNC_DB.prepare("UPDATE pairing_sessions SET state = 'expired' WHERE id = ? AND state = 'complete'").bind(payload.sessionId).run();
  if (consume.meta.changes !== 1) throw new HttpError(410, "Pairing snapshot already used or expired.");
  const sealed = await env.SYNC_PACKAGES.get(pairing.sealed_payload_key);
  if (!sealed) throw new HttpError(410, "Pairing snapshot expired.");
  const sealedPayload = await sealed.text();
  await env.SYNC_PACKAGES.delete(pairing.sealed_payload_key);
  await env.SYNC_DB.prepare("UPDATE pairing_sessions SET sealed_payload_key = NULL WHERE id = ?").bind(payload.sessionId).run();
  return Response.json({ ready: true, sealedPayload });
}

async function cleanupExpiredPackages(env: Env): Promise<void> {
  const cutoff = new Date().toISOString();
  const expired = await env.SYNC_DB.prepare("SELECT id, object_key FROM packages WHERE expires_at <= ? ORDER BY expires_at LIMIT 100").bind(new Date().toISOString()).all<PackageRow>();
  if (expired.results.length > 0) await env.SYNC_PACKAGES.delete(expired.results.map((item) => item.object_key));
  const statements: D1PreparedStatement[] = [];
  for (const item of expired.results) {
    statements.push(env.SYNC_DB.prepare("DELETE FROM deliveries WHERE package_id = ?").bind(item.id));
    statements.push(env.SYNC_DB.prepare("DELETE FROM packages WHERE id = ?").bind(item.id));
  }
  if (statements.length > 0) await env.SYNC_DB.batch(statements);
  const expiredPairings = await env.SYNC_DB.prepare("SELECT sealed_payload_key FROM pairing_sessions WHERE expires_at <= ? AND sealed_payload_key IS NOT NULL LIMIT 100").bind(cutoff).all<{ sealed_payload_key: string }>();
  if (expiredPairings.results.length > 0) await env.SYNC_PACKAGES.delete(expiredPairings.results.map((item) => item.sealed_payload_key));
  await env.SYNC_DB.prepare("UPDATE pairing_sessions SET state = 'expired', sealed_payload_key = NULL WHERE expires_at <= ?").bind(cutoff).run();
}

async function route(request: Request, env: Env): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (request.method === "POST" && path === "/v1/packages") return handleUpload(request, env);
  if (request.method === "POST" && path === "/v1/packages/fetch") return handleFetch(request, env);
  if (request.method === "POST" && path === "/v1/packages/ack") return handleAcknowledge(request, env);
  if (request.method === "POST" && path === "/v1/devices/revoke") return handleDeviceRevocation(request, env);
  if (request.method === "POST" && path === "/v1/pairing/start") return handlePairingStart(request, env);
  if (request.method === "POST" && path === "/v1/pairing/hello") return handlePairingHello(request, env);
  if (request.method === "POST" && path === "/v1/pairing/claim") return handlePairingClaim(request, env);
  if (request.method === "POST" && path === "/v1/pairing/complete") return handlePairingComplete(request, env);
  if (request.method === "POST" && path === "/v1/pairing/finish") return handlePairingFinish(request, env);
  return Response.json({ error: "Not found" }, { status: 404 });
}

export default {
  async fetch(request, env): Promise<Response> {
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
      return Response.json({ error: "Internal relay error" }, { status: 500 });
    }
  },
  async scheduled(_controller, env): Promise<void> { await cleanupExpiredPackages(env); },
} satisfies ExportedHandler<Env>;
