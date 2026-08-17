# Pad encrypted sync relay

The relay stores opaque vault/device identifiers and encrypted packages only. Readable notes, category names, vault keys, device private keys, and pairing secrets are never stored here.

## Local development

```sh
npm install
npx wrangler d1 migrations apply papyrus-sync-relay --local
npm run dev
```

Debug builds of Pad use `http://127.0.0.1:8787`. Existing infrastructure and protocol identifiers intentionally retain their `papyrus` names for compatibility; see [`../BRANDING.md`](../BRANDING.md).

Use `PAPYRUS_DATA_DIR=/tmp/papyrus-laptop` and `PAPYRUS_DATA_DIR=/tmp/papyrus-phone` when launching two debug app processes so they have independent notebooks and identities.

To exercise retries, duplicate delivery, delay, and reordering:

```sh
PAPYRUS_FAULT_MODE=delay,duplicate,reorder npm run dev:faults
```

Use `PAPYRUS_FAULT_MODE=offline` for a completely unavailable relay, or `PAPYRUS_FAULT_DELAY_MS=2000` to increase latency.

## Verification

```sh
npm run check
npm test
npx wrangler deploy --dry-run
```

The Worker tests run in Cloudflare's local Workers runtime with real isolated D1 and R2 bindings.

## Deployment

The existing D1 database, R2 bucket, Worker name, and public relay URL are deliberately not renamed during the Pad rebrand. Renaming them would create a second infrastructure identity and break existing clients.

After authenticating with Cloudflare, deploy with:

```sh
npx wrangler login
npm run deploy
```

The deploy command checks the Worker, applies any pending remote D1 migrations, and publishes it. Build the native app with the legacy `PAPYRUS_SYNC_RELAY_URL` environment variable set to the deployed HTTPS Worker URL when overriding the default relay.
