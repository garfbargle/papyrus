// Cross-language crypto parity test. Consumes the fixtures emitted by the Rust
// `crypto_parity::emit_crypto_fixtures` test and proves the TypeScript port
// (`crypto.ts`) is wire-compatible with the native implementation in both
// directions:
//   - forward: reproduce every deterministic vector, decrypt a Rust-encrypted
//     envelope, open a Rust-sealed pairing payload.
//   - reverse: emit ts-vectors.json (a TS-encrypted envelope + TS-sealed
//     payload) for the Rust `verify_ts_fixtures` test to decrypt.
//
// Regenerate fixtures with:  (cd src-tauri && cargo test --lib crypto_parity)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aadString,
  contentHash,
  decodeBase64Url,
  decryptOperation,
  encodeBase64Url,
  encryptOperation,
  openPairingPayload,
  sealPairingPayload,
  sha256Hex,
  signableString,
  signingPublicKey,
  transportMessage,
  type SyncEnvelope,
  type SyncIdentity,
} from "./crypto.js";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");
const rust = JSON.parse(readFileSync(join(fixturesDir, "rust-vectors.json"), "utf8"));

const utf8 = (value: string) => new TextEncoder().encode(value);

function hostIdentity(): SyncIdentity {
  return {
    vaultId: rust.identity.vaultId,
    vaultKeyEpoch: rust.identity.keyEpoch,
    vaultKey: decodeBase64Url(rust.identity.vaultKey),
    deviceId: rust.identity.deviceId,
    signingSeed: decodeBase64Url(rust.identity.signingSeed),
    agreementSecret: decodeBase64Url(rust.identity.agreementSecret),
  };
}

function guestIdentity(): SyncIdentity {
  const host = hostIdentity();
  return { ...host, agreementSecret: decodeBase64Url(rust.guest.agreementSecret) };
}

describe("crypto parity — deterministic vectors match Rust", () => {
  it("sha256Hex", () => {
    const v = rust.vectors.sha256Hex;
    expect(sha256Hex(utf8(v.inputUtf8))).toBe(v.output);
  });

  it("contentHash (with category)", () => {
    const v = rust.vectors.contentHashWithCategory;
    expect(contentHash(v.title, v.body, v.categoryId, v.deletedAt)).toBe(v.output);
  });

  it("contentHash (null category and deletedAt)", () => {
    const v = rust.vectors.contentHashNulls;
    expect(contentHash(v.title, v.body, v.categoryId, v.deletedAt)).toBe(v.output);
  });

  it("aad string", () => {
    const envelope = rust.envelope as SyncEnvelope;
    // The sample vector uses fixed fields; rebuild an envelope matching it.
    const sample: SyncEnvelope = {
      ...envelope,
      packageId: "pkg-123",
      createdAt: "2026-07-12T00:00:00+00:00",
      keyEpoch: 1,
    };
    expect(aadString(sample)).toBe(rust.vectors.aad.outputUtf8);
  });

  it("signable JSON array", () => {
    const sample: SyncEnvelope = {
      version: 1,
      packageId: "pkg-123",
      vaultId: rust.identity.vaultId,
      senderDeviceId: rust.identity.deviceId,
      senderSigningKey: rust.identity.signingPublicKey,
      keyEpoch: 1,
      createdAt: "2026-07-12T00:00:00+00:00",
      nonce: encodeBase64Url(new Uint8Array(24).fill(0x66)),
      ciphertext: encodeBase64Url(utf8("opaque")),
      signature: "",
    };
    expect(signableString(sample)).toBe(rust.vectors.signable.outputUtf8);
  });

  it("transport-proof message", () => {
    const v = rust.vectors.transportMessage;
    expect(transportMessage(v.method, v.path, v.timestamp, utf8(v.bodyUtf8))).toBe(
      v.outputUtf8,
    );
  });

  it("ed25519 signature is deterministic and matches Rust", () => {
    const v = rust.vectors.ed25519;
    const sig = ed25519.sign(utf8(v.messageUtf8), decodeBase64Url(rust.identity.signingSeed));
    expect(encodeBase64Url(sig)).toBe(v.signature);
  });

  it("XChaCha20Poly1305 ciphertext matches Rust", () => {
    const v = rust.vectors.xchacha;
    const cipher = xchacha20poly1305(
      decodeBase64Url(rust.identity.vaultKey),
      decodeBase64Url(v.nonce),
      utf8(v.aadUtf8),
    );
    expect(encodeBase64Url(cipher.encrypt(utf8(v.plaintextUtf8)))).toBe(v.ciphertext);
  });

  it("derived public keys match Rust", () => {
    expect(encodeBase64Url(ed25519.getPublicKey(decodeBase64Url(rust.identity.signingSeed)))).toBe(
      rust.identity.signingPublicKey,
    );
    expect(encodeBase64Url(x25519.getPublicKey(decodeBase64Url(rust.identity.agreementSecret)))).toBe(
      rust.identity.agreementPublicKey,
    );
  });

  it("pairing key derivation (X25519 + HKDF) matches Rust", () => {
    const shared = x25519.getSharedSecret(
      decodeBase64Url(rust.identity.agreementSecret),
      decodeBase64Url(rust.guest.agreementPublicKey),
    );
    const key = hkdf(sha256, shared, decodeBase64Url(rust.pairingSecret), utf8("papyrus-pairing-v1"), 32);
    expect(encodeBase64Url(key)).toBe(rust.vectors.pairingKey.output);
  });
});

describe("crypto parity — decrypt Rust-produced artifacts", () => {
  it("decrypts a Rust-encrypted envelope to the expected operation", () => {
    const identity = hostIdentity();
    const operation = decryptOperation(
      identity,
      rust.envelope as SyncEnvelope,
      signingPublicKey(identity),
    );
    expect(operation).toEqual(rust.envelopeExpectedOperation);
  });

  it("rejects a tampered ciphertext", () => {
    const identity = hostIdentity();
    const tampered = { ...(rust.envelope as SyncEnvelope) };
    const bytes = decodeBase64Url(tampered.ciphertext);
    bytes[0] ^= 0x01;
    tampered.ciphertext = encodeBase64Url(bytes);
    // Signature no longer matches -> verification fails before decryption.
    expect(() => decryptOperation(identity, tampered, signingPublicKey(identity))).toThrow();
  });

  it("opens a Rust-sealed pairing payload as the guest", () => {
    const guest = guestIdentity();
    const plaintext = openPairingPayload(
      guest,
      rust.sealedPairingPayload.payload,
      decodeBase64Url(rust.pairingSecret),
    );
    expect(encodeBase64Url(plaintext)).toBe(rust.sealedPairingPayload.expectedPlaintext);
  });
});

describe("crypto parity — self round-trip", () => {
  it("encrypt -> decrypt recovers the operation", () => {
    const identity = hostIdentity();
    const operation = { kind: "noteRevision", state: { id: "n2", title: "Hi", body: "there" } };
    const envelope = encryptOperation(identity, operation);
    expect(decryptOperation(identity, envelope, signingPublicKey(identity))).toEqual(operation);
  });

  it("seal -> open recovers the pairing snapshot", () => {
    const host = hostIdentity();
    const guest = guestIdentity();
    const secret = decodeBase64Url(rust.pairingSecret);
    const snapshot = utf8("web pairing snapshot 📝");
    const sealed = sealPairingPayload(host, x25519.getPublicKey(guest.agreementSecret), secret, snapshot);
    expect(openPairingPayload(guest, sealed, secret)).toEqual(snapshot);
  });
});

// Emit artifacts the Rust `verify_ts_fixtures` test decrypts (reverse direction).
describe("crypto parity — emit reverse-direction fixtures", () => {
  it("writes ts-vectors.json", () => {
    const host = hostIdentity();
    const guest = guestIdentity();
    const secret = decodeBase64Url(rust.pairingSecret);

    const expectedOperation = {
      kind: "noteRevision",
      state: {
        id: "ts-note",
        title: "From the web client",
        body: "encrypted in the browser 🔐",
        categoryId: null,
        createdAt: "2026-07-12T10:00:00.000Z",
        updatedAt: "2026-07-12T10:00:00.000Z",
        deletedAt: null,
        purgedAt: null,
        revisionId: "ts-rev",
        parentRevisionId: null,
      },
    };
    const envelope = encryptOperation(host, expectedOperation);

    const snapshot = utf8("sealed by the web client 🌐");
    const payload = sealPairingPayload(
      host,
      x25519.getPublicKey(guest.agreementSecret),
      secret,
      snapshot,
    );

    writeFileSync(
      join(fixturesDir, "ts-vectors.json"),
      JSON.stringify(
        {
          envelope,
          envelopeExpectedOperation: expectedOperation,
          sealedPairingPayload: { payload, expectedPlaintext: encodeBase64Url(snapshot) },
        },
        null,
        2,
      ),
    );

    // Sanity: what we wrote decrypts on our own side too.
    expect(decryptOperation(host, envelope, signingPublicKey(host))).toEqual(expectedOperation);
  });
});
