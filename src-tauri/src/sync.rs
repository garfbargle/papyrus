use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chacha20poly1305::{
    aead::{Aead, Payload},
    KeyInit, XChaCha20Poly1305, XNonce,
};
use chrono::Utc;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(any(target_os = "android", target_os = "ios"))]
use std::sync::OnceLock;
use uuid::Uuid;
use x25519_dalek::{PublicKey as AgreementPublicKey, StaticSecret};
use zeroize::Zeroize;

pub type SyncResult<T> = std::result::Result<T, String>;

#[cfg_attr(test, allow(dead_code))]
const SECRET_SERVICE: &str = "com.papyrus.notes.sync";
const PROTOCOL_VERSION: u8 = 1;

#[derive(Clone)]
pub struct SyncIdentity {
    pub vault_id: String,
    pub vault_key_epoch: i64,
    pub vault_key: [u8; 32],
    pub device_id: String,
    pub device_name: String,
    previous_vault_keys: Vec<(i64, [u8; 32])>,
    signing_key: SigningKey,
    agreement_secret: StaticSecret,
}

impl SyncIdentity {
    pub fn signing_public_key(&self) -> Vec<u8> {
        self.signing_key.verifying_key().to_bytes().to_vec()
    }
    pub fn agreement_public_key(&self) -> Vec<u8> {
        AgreementPublicKey::from(&self.agreement_secret)
            .as_bytes()
            .to_vec()
    }
}

#[cfg(test)]
pub fn test_identity(
    vault_id: &str,
    device_id: &str,
    device_name: &str,
    vault_key: [u8; 32],
) -> SyncIdentity {
    SyncIdentity {
        vault_id: vault_id.to_string(),
        vault_key_epoch: 1,
        vault_key,
        device_id: device_id.to_string(),
        device_name: device_name.to_string(),
        previous_vault_keys: Vec::new(),
        signing_key: SigningKey::generate(&mut OsRng),
        agreement_secret: StaticSecret::random_from_rng(OsRng),
    }
}

#[derive(Serialize, Deserialize)]
struct StoredIdentity {
    vault_key: Vec<u8>,
    signing_secret: Vec<u8>,
    agreement_secret: Vec<u8>,
    #[serde(default)]
    previous_vault_keys: Vec<StoredVaultKey>,
}

#[derive(Serialize, Deserialize)]
struct StoredVaultKey {
    epoch: i64,
    key: Vec<u8>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteRevisionState {
    pub id: String,
    pub title: String,
    pub body: String,
    pub category_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub purged_at: Option<String>,
    pub revision_id: String,
    pub parent_revision_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CategoryRevisionState {
    pub id: String,
    pub name: String,
    pub position: i64,
    pub created_at: String,
    pub updated_at: String,
    pub deleted_at: Option<String>,
    pub revision_id: String,
    pub parent_revision_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "kind", content = "state", rename_all = "camelCase")]
pub enum SyncOperation {
    NoteRevision(NoteRevisionState),
    CategoryRevision(CategoryRevisionState),
    DeviceAuthorization(DeviceAuthorization),
    DeviceRevocation(DeviceRevocation),
    VaultKeyRotation(VaultKeyRotation),
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAuthorization {
    pub device_id: String,
    pub display_name: String,
    pub signing_public_key: String,
    pub agreement_public_key: String,
    pub authorized_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRevocation {
    pub device_id: String,
    pub revoked_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultKeyRotation {
    pub epoch: i64,
    pub vault_key: String,
    pub rotated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncEnvelope {
    pub version: u8,
    pub package_id: String,
    pub vault_id: String,
    pub sender_device_id: String,
    pub sender_signing_key: String,
    pub key_epoch: i64,
    pub created_at: String,
    pub nonce: String,
    pub ciphertext: String,
    pub signature: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransportProof {
    pub device_id: String,
    pub signing_key: String,
    pub timestamp: String,
    pub signature: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SealedPairingPayload {
    pub host_agreement_key: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct SignedOperation {
    operation_id: String,
    author_device_id: String,
    operation: SyncOperation,
}

fn make_id() -> String {
    Uuid::new_v4().to_string()
}

fn platform_device_name() -> String {
    match std::env::consts::OS {
        "macos" => "Mac",
        "windows" => "Windows PC",
        "linux" => "Linux device",
        "android" => "Android phone",
        "ios" => "iPhone",
        _ => "Pad device",
    }
    .to_string()
}

fn secret_name(vault_id: &str) -> String {
    format!("vault-{vault_id}")
}

#[cfg(all(not(any(target_os = "android", target_os = "ios")), not(test)))]
fn get_secret(name: &str) -> SyncResult<Option<Vec<u8>>> {
    let entry = keyring::Entry::new(SECRET_SERVICE, name).map_err(|error| error.to_string())?;
    match entry.get_secret() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Secure storage is unavailable: {error}")),
    }
}

#[cfg(all(not(any(target_os = "android", target_os = "ios")), not(test)))]
fn put_secret(name: &str, value: &[u8]) -> SyncResult<()> {
    let entry = keyring::Entry::new(SECRET_SERVICE, name).map_err(|error| error.to_string())?;
    entry
        .set_secret(value)
        .map_err(|error| format!("Could not save sync keys securely: {error}"))
}

#[cfg(target_os = "android")]
fn setup_mobile_secure_store() -> SyncResult<()> {
    static STORE: OnceLock<std::result::Result<(), String>> = OnceLock::new();
    STORE
        .get_or_init(|| {
            let store =
                android_native_keyring_store::Store::new().map_err(|error| error.to_string())?;
            keyring_core::set_default_store(store);
            Ok(())
        })
        .clone()
}

#[cfg(target_os = "ios")]
fn setup_mobile_secure_store() -> SyncResult<()> {
    static STORE: OnceLock<std::result::Result<(), String>> = OnceLock::new();
    STORE
        .get_or_init(|| {
            let store = apple_native_keyring_store::protected::Store::new()
                .map_err(|error| error.to_string())?;
            keyring_core::set_default_store(store);
            Ok(())
        })
        .clone()
}

#[cfg(all(any(target_os = "android", target_os = "ios"), not(test)))]
fn get_secret(name: &str) -> SyncResult<Option<Vec<u8>>> {
    setup_mobile_secure_store()?;
    let entry =
        keyring_core::Entry::new(SECRET_SERVICE, name).map_err(|error| error.to_string())?;
    match entry.get_secret() {
        Ok(value) => Ok(Some(value)),
        Err(keyring_core::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("Secure storage is unavailable: {error}")),
    }
}

#[cfg(all(any(target_os = "android", target_os = "ios"), not(test)))]
fn put_secret(name: &str, value: &[u8]) -> SyncResult<()> {
    setup_mobile_secure_store()?;
    let entry =
        keyring_core::Entry::new(SECRET_SERVICE, name).map_err(|error| error.to_string())?;
    entry
        .set_secret(value)
        .map_err(|error| format!("Could not save sync keys securely: {error}"))
}

// Under `cargo test` the secret store is a plain in-process map. The real
// implementations above write to the developer's OS keychain — on macOS that
// meant every `cargo test` run popped an authorization prompt (a fresh unsigned
// test binary each build) and left a `vault-vault-host` item sitting next to the
// user's actual vault key. A unit test has no business touching the login
// keychain, and asserting on identity persistence does not require it.
#[cfg(test)]
fn test_secrets() -> &'static std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>> {
    static SECRETS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Vec<u8>>>> =
        std::sync::OnceLock::new();
    SECRETS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

#[cfg(test)]
fn get_secret(name: &str) -> SyncResult<Option<Vec<u8>>> {
    Ok(test_secrets()
        .lock()
        .map_err(|_| "Secure storage is unavailable.".to_string())?
        .get(name)
        .cloned())
}

#[cfg(test)]
fn put_secret(name: &str, value: &[u8]) -> SyncResult<()> {
    test_secrets()
        .lock()
        .map_err(|_| "Could not save sync keys securely.".to_string())?
        .insert(name.to_string(), value.to_vec());
    Ok(())
}

fn read_stored_identity(vault_id: &str) -> SyncResult<Option<StoredIdentity>> {
    let Some(bytes) = get_secret(&secret_name(vault_id))? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "The secure sync identity is invalid.".to_string())
}

fn write_stored_identity(vault_id: &str, stored: &StoredIdentity) -> SyncResult<()> {
    let mut bytes = serde_json::to_vec(stored).map_err(|error| error.to_string())?;
    let result = put_secret(&secret_name(vault_id), &bytes);
    bytes.zeroize();
    result
}

pub fn bootstrap_identity(connection: &Connection) -> SyncResult<SyncIdentity> {
    let vault: Option<(String, i64)> = connection
        .query_row(
            "SELECT id, key_epoch FROM vaults ORDER BY created_at LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;

    let (vault_id, epoch, stored) = if let Some((vault_id, epoch)) = vault {
        let stored = read_stored_identity(&vault_id)?.ok_or_else(|| "Sync keys for this notebook are unavailable. Restore them from a paired device before enabling sync.".to_string())?;
        (vault_id, epoch, stored)
    } else {
        let vault_id = make_id();
        let mut vault_key = vec![0; 32];
        OsRng.fill_bytes(&mut vault_key);
        let signing_key = SigningKey::generate(&mut OsRng);
        let agreement_secret = StaticSecret::random_from_rng(OsRng);
        let stored = StoredIdentity {
            vault_key,
            signing_secret: signing_key.to_bytes().to_vec(),
            agreement_secret: agreement_secret.to_bytes().to_vec(),
            previous_vault_keys: Vec::new(),
        };
        write_stored_identity(&vault_id, &stored)?;
        connection
            .execute(
                "INSERT INTO vaults(id, key_epoch, created_at) VALUES (?1, 1, ?2)",
                params![vault_id, Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        (vault_id, 1, stored)
    };

    let vault_key: [u8; 32] = stored
        .vault_key
        .as_slice()
        .try_into()
        .map_err(|_| "The saved vault key has the wrong length.".to_string())?;
    let signing_bytes: [u8; 32] = stored
        .signing_secret
        .as_slice()
        .try_into()
        .map_err(|_| "The saved signing key has the wrong length.".to_string())?;
    let agreement_bytes: [u8; 32] = stored
        .agreement_secret
        .as_slice()
        .try_into()
        .map_err(|_| "The saved agreement key has the wrong length.".to_string())?;
    let signing_key = SigningKey::from_bytes(&signing_bytes);
    let agreement_secret = StaticSecret::from(agreement_bytes);

    let local: Option<(String, String)> = connection
        .query_row(
            "SELECT id, display_name FROM devices WHERE is_local = 1 LIMIT 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (device_id, device_name) = if let Some(value) = local {
        value
    } else {
        let device_id = make_id();
        let device_name = platform_device_name();
        let created_at = Utc::now().to_rfc3339();
        connection.execute(
            "INSERT INTO devices(id, display_name, public_key, agreement_public_key, created_at, is_local) VALUES (?1, ?2, ?3, ?4, ?5, 1)",
            params![device_id, device_name, signing_key.verifying_key().to_bytes().to_vec(), AgreementPublicKey::from(&agreement_secret).as_bytes().to_vec(), created_at],
        ).map_err(|error| error.to_string())?;
        connection.execute("INSERT OR REPLACE INTO device_authorizations(device_id, authorized_at, revoked_at) VALUES (?1, ?2, NULL)", params![device_id, Utc::now().to_rfc3339()]).map_err(|error| error.to_string())?;
        (device_id, device_name)
    };
    let previous_vault_keys = stored
        .previous_vault_keys
        .into_iter()
        .map(|item| {
            let key: [u8; 32] =
                item.key.as_slice().try_into().map_err(|_| {
                    "A saved historical vault key has the wrong length.".to_string()
                })?;
            Ok((item.epoch, key))
        })
        .collect::<SyncResult<Vec<_>>>()?;
    Ok(SyncIdentity {
        vault_id,
        vault_key_epoch: epoch,
        vault_key,
        device_id,
        device_name,
        previous_vault_keys,
        signing_key,
        agreement_secret,
    })
}

fn aad(envelope: &SyncEnvelope) -> Vec<u8> {
    format!(
        "papyrus-sync/{}/{}:{}:{}",
        envelope.version, envelope.vault_id, envelope.package_id, envelope.key_epoch
    )
    .into_bytes()
}

fn signable(envelope: &SyncEnvelope) -> SyncResult<Vec<u8>> {
    serde_json::to_vec(&(
        envelope.version,
        &envelope.package_id,
        &envelope.vault_id,
        &envelope.sender_device_id,
        &envelope.sender_signing_key,
        envelope.key_epoch,
        &envelope.created_at,
        &envelope.nonce,
        &envelope.ciphertext,
    ))
    .map_err(|error| error.to_string())
}

pub fn encrypt_operation(
    identity: &SyncIdentity,
    operation: SyncOperation,
) -> SyncResult<SyncEnvelope> {
    let package_id = make_id();
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let mut envelope = SyncEnvelope {
        version: PROTOCOL_VERSION,
        package_id,
        vault_id: identity.vault_id.clone(),
        sender_device_id: identity.device_id.clone(),
        sender_signing_key: URL_SAFE_NO_PAD.encode(identity.signing_public_key()),
        key_epoch: identity.vault_key_epoch,
        created_at: Utc::now().to_rfc3339(),
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: String::new(),
        signature: String::new(),
    };
    let signed = SignedOperation {
        operation_id: make_id(),
        author_device_id: identity.device_id.clone(),
        operation,
    };
    let mut plaintext = serde_json::to_vec(&signed).map_err(|error| error.to_string())?;
    let cipher = XChaCha20Poly1305::new_from_slice(&identity.vault_key)
        .map_err(|error| error.to_string())?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &plaintext,
                aad: &aad(&envelope),
            },
        )
        .map_err(|_| "Could not encrypt sync package.".to_string())?;
    plaintext.zeroize();
    envelope.ciphertext = URL_SAFE_NO_PAD.encode(ciphertext);
    envelope.signature =
        URL_SAFE_NO_PAD.encode(identity.signing_key.sign(&signable(&envelope)?).to_bytes());
    Ok(envelope)
}

pub fn transport_proof(
    identity: &SyncIdentity,
    method: &str,
    path: &str,
    body: &[u8],
) -> TransportProof {
    let mut hash = Sha256::new();
    hash.update(body);
    let timestamp = Utc::now().to_rfc3339();
    let message = format!(
        "papyrus-relay-v1\n{method}\n{path}\n{timestamp}\n{:x}",
        hash.finalize()
    );
    TransportProof {
        device_id: identity.device_id.clone(),
        signing_key: URL_SAFE_NO_PAD.encode(identity.signing_public_key()),
        timestamp,
        signature: URL_SAFE_NO_PAD.encode(identity.signing_key.sign(message.as_bytes()).to_bytes()),
    }
}

fn pairing_key(
    secret: &StaticSecret,
    peer_public_key: &[u8],
    pairing_secret: &[u8],
) -> SyncResult<[u8; 32]> {
    let peer: [u8; 32] = peer_public_key
        .try_into()
        .map_err(|_| "The pairing device key is invalid.".to_string())?;
    let shared = secret.diffie_hellman(&AgreementPublicKey::from(peer));
    let hkdf = Hkdf::<Sha256>::new(Some(pairing_secret), shared.as_bytes());
    let mut key = [0u8; 32];
    hkdf.expand(b"papyrus-pairing-v1", &mut key)
        .map_err(|_| "Could not derive the pairing key.".to_string())?;
    Ok(key)
}

pub fn seal_pairing_payload(
    identity: &SyncIdentity,
    peer_public_key: &[u8],
    pairing_secret: &[u8],
    plaintext: &[u8],
) -> SyncResult<SealedPairingPayload> {
    let mut key = pairing_key(&identity.agreement_secret, peer_public_key, pairing_secret)?;
    let mut nonce = [0u8; 24];
    OsRng.fill_bytes(&mut nonce);
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|error| error.to_string())?;
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: b"papyrus-pairing-snapshot-v1",
            },
        )
        .map_err(|_| "Could not encrypt the pairing snapshot.".to_string())?;
    key.zeroize();
    Ok(SealedPairingPayload {
        host_agreement_key: URL_SAFE_NO_PAD.encode(identity.agreement_public_key()),
        nonce: URL_SAFE_NO_PAD.encode(nonce),
        ciphertext: URL_SAFE_NO_PAD.encode(ciphertext),
    })
}

pub fn open_pairing_payload(
    identity: &SyncIdentity,
    payload: &SealedPairingPayload,
    pairing_secret: &[u8],
) -> SyncResult<Vec<u8>> {
    let peer_key = URL_SAFE_NO_PAD
        .decode(&payload.host_agreement_key)
        .map_err(|_| "The pairing response has an invalid device key.".to_string())?;
    let mut key = pairing_key(&identity.agreement_secret, &peer_key, pairing_secret)?;
    let nonce: [u8; 24] = URL_SAFE_NO_PAD
        .decode(&payload.nonce)
        .map_err(|_| "The pairing response has an invalid nonce.".to_string())?
        .as_slice()
        .try_into()
        .map_err(|_| "The pairing response has an invalid nonce.".to_string())?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&payload.ciphertext)
        .map_err(|_| "The pairing response is invalid.".to_string())?;
    let cipher = XChaCha20Poly1305::new_from_slice(&key).map_err(|error| error.to_string())?;
    let plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: b"papyrus-pairing-snapshot-v1",
            },
        )
        .map_err(|_| "The pairing snapshot could not be authenticated.".to_string())?;
    key.zeroize();
    Ok(plaintext)
}

pub fn adopt_vault(
    identity: &mut SyncIdentity,
    vault_id: String,
    vault_key_epoch: i64,
    vault_key: [u8; 32],
) -> SyncResult<()> {
    if identity.vault_id == vault_id
        && identity.vault_key_epoch != vault_key_epoch
        && !identity
            .previous_vault_keys
            .iter()
            .any(|(epoch, _)| *epoch == identity.vault_key_epoch)
    {
        identity
            .previous_vault_keys
            .push((identity.vault_key_epoch, identity.vault_key));
    }
    let stored = StoredIdentity {
        vault_key: vault_key.to_vec(),
        signing_secret: identity.signing_key.to_bytes().to_vec(),
        agreement_secret: identity.agreement_secret.to_bytes().to_vec(),
        previous_vault_keys: identity
            .previous_vault_keys
            .iter()
            .map(|(epoch, key)| StoredVaultKey {
                epoch: *epoch,
                key: key.to_vec(),
            })
            .collect(),
    };
    write_stored_identity(&vault_id, &stored)?;
    identity.vault_id = vault_id;
    identity.vault_key_epoch = vault_key_epoch;
    identity.vault_key = vault_key;
    Ok(())
}

pub fn persist_identity(identity: &SyncIdentity) -> SyncResult<()> {
    let stored = StoredIdentity {
        vault_key: identity.vault_key.to_vec(),
        signing_secret: identity.signing_key.to_bytes().to_vec(),
        agreement_secret: identity.agreement_secret.to_bytes().to_vec(),
        previous_vault_keys: identity
            .previous_vault_keys
            .iter()
            .map(|(epoch, key)| StoredVaultKey {
                epoch: *epoch,
                key: key.to_vec(),
            })
            .collect(),
    };
    write_stored_identity(&identity.vault_id, &stored)
}

pub fn decrypt_operation(
    identity: &SyncIdentity,
    envelope: &SyncEnvelope,
    expected_signing_key: &[u8],
) -> SyncResult<SyncOperation> {
    if envelope.version != PROTOCOL_VERSION || envelope.vault_id != identity.vault_id {
        return Err("Package belongs to another notebook or protocol version.".into());
    }
    let public_key: [u8; 32] = URL_SAFE_NO_PAD
        .decode(&envelope.sender_signing_key)
        .map_err(|_| "Invalid package author key.".to_string())?
        .as_slice()
        .try_into()
        .map_err(|_| "Invalid package author key.".to_string())?;
    if public_key.as_slice() != expected_signing_key {
        return Err("Package author key does not match this device authorization.".into());
    }
    let signature_bytes: [u8; 64] = URL_SAFE_NO_PAD
        .decode(&envelope.signature)
        .map_err(|_| "Invalid package signature.".to_string())?
        .as_slice()
        .try_into()
        .map_err(|_| "Invalid package signature.".to_string())?;
    VerifyingKey::from_bytes(&public_key)
        .map_err(|_| "Invalid package author key.".to_string())?
        .verify(
            &signable(envelope)?,
            &Signature::from_bytes(&signature_bytes),
        )
        .map_err(|_| "Package signature verification failed.".to_string())?;
    let nonce: [u8; 24] = URL_SAFE_NO_PAD
        .decode(&envelope.nonce)
        .map_err(|_| "Invalid package nonce.".to_string())?
        .as_slice()
        .try_into()
        .map_err(|_| "Invalid package nonce.".to_string())?;
    let ciphertext = URL_SAFE_NO_PAD
        .decode(&envelope.ciphertext)
        .map_err(|_| "Invalid encrypted package.".to_string())?;
    let key = if envelope.key_epoch == identity.vault_key_epoch {
        &identity.vault_key
    } else {
        &identity
            .previous_vault_keys
            .iter()
            .find(|(epoch, _)| *epoch == envelope.key_epoch)
            .ok_or_else(|| {
                "This package uses a vault key that is no longer available.".to_string()
            })?
            .1
    };
    let cipher = XChaCha20Poly1305::new_from_slice(key).map_err(|error| error.to_string())?;
    let mut plaintext = cipher
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad(envelope),
            },
        )
        .map_err(|_| "Encrypted package authentication failed.".to_string())?;
    let signed: SignedOperation = serde_json::from_slice(&plaintext)
        .map_err(|_| "Encrypted package content is invalid.".to_string())?;
    plaintext.zeroize();
    if signed.author_device_id != envelope.sender_device_id {
        return Err("Package author identity is invalid.".into());
    }
    Ok(signed.operation)
}

pub fn content_hash(
    title: &str,
    body: &str,
    category_id: Option<&str>,
    deleted_at: Option<&str>,
) -> String {
    let mut hash = Sha256::new();
    hash.update(title.as_bytes());
    hash.update([0]);
    hash.update(body.as_bytes());
    hash.update([0]);
    hash.update(category_id.unwrap_or_default().as_bytes());
    hash.update([0]);
    hash.update(deleted_at.unwrap_or_default().as_bytes());
    format!("{:x}", hash.finalize())
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let mut hash = Sha256::new();
    hash.update(bytes);
    format!("{:x}", hash.finalize())
}

pub fn random_bytes(length: usize) -> Vec<u8> {
    let mut bytes = vec![0; length];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

pub fn enqueue_operation(
    connection: &Connection,
    identity: &SyncIdentity,
    revision_id: &str,
    operation: SyncOperation,
) -> SyncResult<()> {
    let envelope = encrypt_operation(identity, operation)?;
    let recipients = connection.prepare("SELECT d.id FROM devices d JOIN device_authorizations a ON a.device_id = d.id WHERE d.id != ?1 AND a.revoked_at IS NULL")
        .map_err(|error| error.to_string())?
        .query_map([&identity.device_id], |row| row.get::<_, String>(0)).map_err(|error| error.to_string())?
        .collect::<std::result::Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let serialized = serde_json::to_string(&envelope).map_err(|error| error.to_string())?;
    let recipient_json = serde_json::to_string(&recipients).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT INTO sync_outbox(id, revision_id, package_id, envelope, recipients, state, attempts, created_at, next_retry_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6)",
        params![make_id(), revision_id, envelope.package_id, serialized, recipient_json, Utc::now().to_rfc3339()],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

// Cross-language crypto parity harness. These tests share fixed key material and
// deterministic test vectors with the TypeScript web port (`src/lib/sync/crypto.ts`)
// so both implementations stay wire-compatible. The flow is:
//   1. `emit_crypto_fixtures` writes rust-vectors.json (run this first).
//   2. the vitest parity test reproduces every vector, decrypts the Rust envelope,
//      and writes ts-vectors.json.
//   3. `verify_ts_fixtures` decrypts the TS-produced artifacts (reverse direction).
#[cfg(test)]
mod crypto_parity {
    use super::*;
    use std::path::PathBuf;

    const VAULT_ID: &str = "vault-fixture";
    const DEVICE_ID: &str = "rust-device";
    const EPOCH: i64 = 1;

    fn fixtures_dir() -> PathBuf {
        // cwd during `cargo test` is the crate root (src-tauri).
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("lib")
            .join("sync")
            .join("__fixtures__")
    }

    fn host_identity() -> SyncIdentity {
        let vault_key: [u8; 32] = std::array::from_fn(|i| i as u8);
        SyncIdentity {
            vault_id: VAULT_ID.to_string(),
            vault_key_epoch: EPOCH,
            vault_key,
            device_id: DEVICE_ID.to_string(),
            device_name: "Fixture Host".to_string(),
            previous_vault_keys: Vec::new(),
            signing_key: SigningKey::from_bytes(&[0x11u8; 32]),
            agreement_secret: StaticSecret::from([0x22u8; 32]),
        }
    }

    fn guest_agreement_secret() -> StaticSecret {
        StaticSecret::from([0x33u8; 32])
    }

    fn pairing_secret() -> [u8; 32] {
        [0x44u8; 32]
    }

    fn note_operation() -> SyncOperation {
        SyncOperation::NoteRevision(NoteRevisionState {
            id: "note-1".to_string(),
            title: "Grocery list".to_string(),
            body: "- milk\n- eggs\n- 🥚".to_string(),
            category_id: Some("cat-1".to_string()),
            created_at: "2026-07-12T00:00:00+00:00".to_string(),
            updated_at: "2026-07-12T00:05:00+00:00".to_string(),
            deleted_at: None,
            purged_at: None,
            revision_id: "rev-1".to_string(),
            parent_revision_id: None,
        })
    }

    #[test]
    fn emit_crypto_fixtures() {
        let host = host_identity();
        let guest_secret = guest_agreement_secret();
        let guest_pub = AgreementPublicKey::from(&guest_secret).as_bytes().to_vec();
        let pairing = pairing_secret();

        // Deterministic XChaCha20Poly1305 vector (fixed key/nonce/aad/plaintext).
        let xnonce = [0x55u8; 24];
        let cipher = XChaCha20Poly1305::new_from_slice(&host.vault_key).unwrap();
        let x_ct = cipher
            .encrypt(
                XNonce::from_slice(&xnonce),
                Payload {
                    msg: b"secret message",
                    aad: b"test-aad",
                },
            )
            .unwrap();

        // Deterministic Ed25519 signature over a fixed message.
        let ed_sig = host.signing_key.sign(b"papyrus-sign-test").to_bytes();

        // Reference for the `aad` / `signable` helpers via a fully-specified envelope.
        let sample = SyncEnvelope {
            version: PROTOCOL_VERSION,
            package_id: "pkg-123".to_string(),
            vault_id: VAULT_ID.to_string(),
            sender_device_id: DEVICE_ID.to_string(),
            sender_signing_key: URL_SAFE_NO_PAD.encode(host.signing_public_key()),
            key_epoch: EPOCH,
            created_at: "2026-07-12T00:00:00+00:00".to_string(),
            nonce: URL_SAFE_NO_PAD.encode([0x66u8; 24]),
            ciphertext: URL_SAFE_NO_PAD.encode(b"opaque"),
            signature: String::new(),
        };

        // Transport-proof message reference (fixed timestamp + body).
        let ts = "2026-07-12T00:00:00+00:00";
        let mut body_hash = Sha256::new();
        body_hash.update(b"{\"ping\":true}");
        let transport_message = format!(
            "papyrus-relay-v1\nPOST\n/v1/packages\n{ts}\n{:x}",
            body_hash.finalize()
        );

        // Pairing key derivation (host secret ⨉ guest public, salted by the secret).
        let derived = pairing_key(&host.agreement_secret, &guest_pub, &pairing).unwrap();

        // A real end-to-end envelope and a sealed pairing payload for round-tripping.
        let envelope = encrypt_operation(&host, note_operation()).unwrap();
        let sealed =
            seal_pairing_payload(&host, &guest_pub, &pairing, b"snapshot bytes \xf0\x9f\x93\x9d")
                .unwrap();

        let fixtures = serde_json::json!({
            "identity": {
                "vaultId": VAULT_ID,
                "deviceId": DEVICE_ID,
                "keyEpoch": EPOCH,
                "vaultKey": URL_SAFE_NO_PAD.encode(host.vault_key),
                "signingSeed": URL_SAFE_NO_PAD.encode([0x11u8; 32]),
                "signingPublicKey": URL_SAFE_NO_PAD.encode(host.signing_public_key()),
                "agreementSecret": URL_SAFE_NO_PAD.encode([0x22u8; 32]),
                "agreementPublicKey": URL_SAFE_NO_PAD.encode(host.agreement_public_key()),
            },
            "guest": {
                "agreementSecret": URL_SAFE_NO_PAD.encode([0x33u8; 32]),
                "agreementPublicKey": URL_SAFE_NO_PAD.encode(&guest_pub),
            },
            "pairingSecret": URL_SAFE_NO_PAD.encode(pairing),
            "vectors": {
                "sha256Hex": {
                    "inputUtf8": "papyrus",
                    "output": sha256_hex(b"papyrus"),
                },
                "contentHashWithCategory": {
                    "title": "Grocery list",
                    "body": "- milk\n- eggs",
                    "categoryId": "cat-1",
                    "deletedAt": null,
                    "output": content_hash("Grocery list", "- milk\n- eggs", Some("cat-1"), None),
                },
                "contentHashNulls": {
                    "title": "Untitled",
                    "body": "",
                    "categoryId": null,
                    "deletedAt": null,
                    "output": content_hash("Untitled", "", None, None),
                },
                "aad": {
                    "outputUtf8": String::from_utf8(aad(&sample)).unwrap(),
                },
                "signable": {
                    "outputUtf8": String::from_utf8(signable(&sample).unwrap()).unwrap(),
                },
                "transportMessage": {
                    "method": "POST",
                    "path": "/v1/packages",
                    "timestamp": ts,
                    "bodyUtf8": "{\"ping\":true}",
                    "outputUtf8": transport_message,
                },
                "ed25519": {
                    "messageUtf8": "papyrus-sign-test",
                    "signature": URL_SAFE_NO_PAD.encode(ed_sig),
                },
                "xchacha": {
                    "nonce": URL_SAFE_NO_PAD.encode(xnonce),
                    "aadUtf8": "test-aad",
                    "plaintextUtf8": "secret message",
                    "ciphertext": URL_SAFE_NO_PAD.encode(&x_ct),
                },
                "pairingKey": {
                    "output": URL_SAFE_NO_PAD.encode(derived),
                },
            },
            "envelope": envelope,
            "envelopeExpectedOperation": note_operation(),
            "sealedPairingPayload": {
                "payload": sealed,
                "expectedPlaintext": URL_SAFE_NO_PAD.encode(b"snapshot bytes \xf0\x9f\x93\x9d"),
            },
        });

        let dir = fixtures_dir();
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("rust-vectors.json"),
            serde_json::to_string_pretty(&fixtures).unwrap(),
        )
        .unwrap();
    }

    // Reverse direction: decrypt artifacts produced by the TypeScript port. Skips
    // gracefully if the vitest parity test has not run yet.
    #[test]
    fn verify_ts_fixtures() {
        let path = fixtures_dir().join("ts-vectors.json");
        let Ok(raw) = std::fs::read_to_string(&path) else {
            eprintln!("skipping: {} not present (run the vitest parity test first)", path.display());
            return;
        };
        let doc: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let host = host_identity();

        // 1. Decrypt a TS-encrypted envelope authored by the same identity.
        let envelope: SyncEnvelope =
            serde_json::from_value(doc["envelope"].clone()).unwrap();
        let operation = decrypt_operation(&host, &envelope, &host.signing_public_key())
            .expect("TS envelope should decrypt on the Rust side");
        let recovered = serde_json::to_value(&operation).unwrap();
        assert_eq!(
            recovered, doc["envelopeExpectedOperation"],
            "operation recovered from TS envelope must match"
        );

        // 2. Open a TS-sealed pairing payload as the guest.
        let mut guest = host_identity();
        guest.agreement_secret = guest_agreement_secret();
        let sealed: SealedPairingPayload =
            serde_json::from_value(doc["sealedPairingPayload"]["payload"].clone()).unwrap();
        let plaintext = open_pairing_payload(&guest, &sealed, &pairing_secret())
            .expect("TS-sealed pairing payload should open on the Rust side");
        let expected = URL_SAFE_NO_PAD
            .decode(doc["sealedPairingPayload"]["expectedPlaintext"].as_str().unwrap())
            .unwrap();
        assert_eq!(plaintext, expected, "opened pairing plaintext must match");
    }
}
