# Pad branding and compatibility

The product is **Pad**. `Papyrus` is the former product name.

The rebrand deliberately does **not** rename identifiers that existing installs, stored data, signing keys, or paired devices depend on. Those strings are compatibility interfaces, not active product branding.

## Public brand

Use **Pad** for app/window titles, UI copy, first-run content, documentation, Library metadata, release artifact names, and screenshots.

## Legacy identifiers that stay stable

The following values intentionally retain `papyrus`:

- GitHub repository slug: `garfbargle/papyrus`.
- Tauri/Android application identifier and Kotlin namespace: `com.papyrus.notes` / `com/papyrus/notes`.
- Native Rust/npm package and executable names where changing them would disturb generated build metadata or existing tooling.
- Native database filename `papyrus.sqlite3`, browser IndexedDB name `papyrus-sync`, and browser preference storage key.
- Keychain service `com.papyrus.notes.sync` and existing Android signing-key path/alias.
- Pairing and sync wire identifiers such as `papyrus-pair-v1`, `papyrus-sync/...`, `papyrus-relay-v1`, `x-papyrus-*`, and pairing HKDF/AAD labels.
- Existing Cloudflare Worker, D1, R2, relay URL, and Wrangler resource names such as `papyrus-sync-relay`, `papyrus-sync-packages`, and `papyrus-web`.
- Existing `PAPYRUS_*` environment-variable names used by local/debug/release tooling.
- The persisted theme id `papyrus`; its user-facing theme name is **Pad**.

Changing any of these requires a separately designed migration or protocol/version transition. Do not replace them mechanically during branding cleanup.

## Release naming

New Library APK artifacts use `pad-*.apk`. Older `papyrus-*` release artifacts remain historical and should not be rewritten.
