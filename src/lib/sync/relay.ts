// HTTP client for the Papyrus sync relay — a fetch-based port of the Rust
// `RelayTransport` in `src-tauri/src/lib.rs`. The relay is a zero-knowledge
// broker: it only sees opaque ciphertext, public keys, and routing metadata.
// Every authenticated request carries an Ed25519 transport proof (see
// `transportProof` in crypto.ts) in `x-papyrus-*` headers.
//
// The relay authenticates a request by verifying the signature over
// `new URL(request.url).pathname`, so we sign the resolved pathname (robust to
// a base URL that includes a path prefix).

import { transportProof, type SealedPairingPayload, type SyncEnvelope, type SyncIdentity } from "./crypto.js";

export interface RelayFetchedPackage {
  cursor: string;
  packageId: string;
  envelope: SyncEnvelope;
}

export interface PairingClaimResult {
  ready: boolean;
  deviceId?: string;
  displayName?: string;
  signingKey?: string;
  agreementKey?: string;
}

export interface PairingFinishResult {
  ready: boolean;
  sealedPayload?: string;
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }

  // 401/403 mean this device is no longer trusted by the vault.
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export class RelayClient {
  private readonly base: string;

  constructor(baseUrl: string) {
    // Normalize away a trailing slash so `${base}${path}` is well-formed.
    this.base = baseUrl.replace(/\/+$/, "");
  }

  // --- Authenticated endpoints ------------------------------------------------

  async uploadPackage(
    identity: SyncIdentity,
    body: { vaultId: string; senderDeviceId: string; envelope: SyncEnvelope; recipients: string[] },
  ): Promise<void> {
    await this.post("/v1/packages", body, identity);
  }

  async fetchPackages(
    identity: SyncIdentity,
    body: { vaultId: string; deviceId: string; limit: number },
  ): Promise<RelayFetchedPackage[]> {
    const result = await this.post<{ packages: RelayFetchedPackage[] }>(
      "/v1/packages/fetch",
      body,
      identity,
    );
    return result.packages ?? [];
  }

  async acknowledgePackage(
    identity: SyncIdentity,
    body: { vaultId: string; deviceId: string; packageId: string },
  ): Promise<void> {
    await this.post("/v1/packages/ack", body, identity);
  }

  async revokeDevice(
    identity: SyncIdentity,
    body: { vaultId: string; deviceId: string },
  ): Promise<void> {
    await this.post("/v1/devices/revoke", body, identity);
  }

  // --- Pairing endpoints ------------------------------------------------------

  async pairingStart(
    identity: SyncIdentity,
    body: { vaultId: string; sessionId: string; secretHash: string; expiresAt: string },
  ): Promise<void> {
    await this.post("/v1/pairing/start", body, identity);
  }

  // Unauthenticated: the guest is not yet a registered device. Knowledge of the
  // pairing secret is the only credential.
  async pairingHello(body: {
    sessionId: string;
    secret: string;
    deviceId: string;
    displayName: string;
    signingKey: string;
    agreementKey: string;
  }): Promise<void> {
    await this.post("/v1/pairing/hello", body);
  }

  async pairingClaim(
    identity: SyncIdentity,
    body: { vaultId: string; sessionId: string },
  ): Promise<PairingClaimResult> {
    return this.post<PairingClaimResult>("/v1/pairing/claim", body, identity);
  }

  async pairingComplete(
    identity: SyncIdentity,
    body: { sessionId: string; deviceId: string; sealedPayload: string },
  ): Promise<void> {
    await this.post("/v1/pairing/complete", body, identity);
  }

  // Authenticated with the guest's own key (verifyGuestProof on the relay).
  async pairingFinish(
    guestIdentity: SyncIdentity,
    body: { sessionId: string; secret: string; deviceId: string },
  ): Promise<PairingFinishResult> {
    return this.post<PairingFinishResult>("/v1/pairing/finish", body, guestIdentity);
  }

  // --- Transport --------------------------------------------------------------

  private async post<T = unknown>(
    path: string,
    body: unknown,
    identity?: SyncIdentity,
  ): Promise<T> {
    const url = `${this.base}${path}`;
    const payload = new TextEncoder().encode(JSON.stringify(body));
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (identity) {
      const pathname = new URL(url).pathname;
      const proof = transportProof(identity, "POST", pathname, payload);
      headers["x-papyrus-device"] = proof.deviceId;
      headers["x-papyrus-signing-key"] = proof.signingKey;
      headers["x-papyrus-timestamp"] = proof.timestamp;
      headers["x-papyrus-signature"] = proof.signature;
    }

    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body: payload });
    } catch (error) {
      throw new RelayError(0, `Could not reach the sync relay: ${(error as Error).message}`);
    }

    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (!response.ok) {
      const message =
        (parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as { error: unknown }).error)
          : undefined) ?? `Relay request failed (${response.status}).`;
      throw new RelayError(response.status, message);
    }

    return parsed as T;
  }
}

export type { SealedPairingPayload };
