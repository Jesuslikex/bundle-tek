# Owned-wallet inventory evidence

20 October 2026. Source baseline `85419f1`. Adds a My inventory section alongside the existing buyer catalog, with a read-only signed-in `/api/marketplace/owned-wallets` endpoint. No supplier, reservation, listing, purchase, payment, key transfer or delivery flow is enabled.

## What is established

The endpoint uses one four-SELECT database batch scoped to the signed-in account. It includes active saved Solana wallets, historical ownership-proof timestamps, retained history-run observations and aggregate warmup receipt metadata. Foreign owners, archived wallets and EVM wallets are excluded. It does not read vault secrets or contact any provider. No arbitrary account/query selector is accepted. Errors are sanitized, cancellation is checked, and responses are not cached.

The view deliberately separates these facts:

- The oldest dated activity retained in a sampled history check. Time since this record is limited activity-age evidence, not a wallet creation time, first-funding date, continuous activity history or organic-trading certification. Earlier retained samples survive later checks whose most recent 50 signatures no longer contain the older activity.
- The most recent successful stored observation, its captured wallet revision, provider hostname, sampled-success counts and balance at that check. This is not a current balance or a new chain verification. Changed wallet metadata is disclosed. Failed saved checks remain counted rather than being represented as empty successful history.
- Historical stored control-proof dates. A proof of key possession at an earlier time is not exclusive custody or a safe key-sale guarantee.
- Warmup receipt row counts and distinct stored signatures, deduplicated across buy/sell tables. These are metadata, not a fresh cryptographic/chain replay or all generated activity. No synthetic fixture becomes a real inventory record.

All result gates are literal false: listingEnabled, purchaseEnabled and deliveryEnabled. The model rejects unknown fields, duplicate identities, contradictory counts, mismatched wallet captures, malformed chronology, unexpected key fields, truncated source capacity and unsupported observations. Input budgets are 500 wallets/proofs/count rows, 100 history runs with 20 captures/results each, 131072 document characters per run and 4 MiB total UTF-8 history documents. Oversized or damaged evidence fails the entire read rather than overstating complete coverage. The client separately validates the DTO, gate literals, derived ages and sample/count bindings.

## UI

My inventory loads only after a click. It exposes label/address search, a whole-day observed-activity-age filter, stable age/label sorting, 20-card local pagination and expandable source details. Unknown dated histories never satisfy an age filter. The explicit one-minute inventory view expiry triggers no automatic request. Cancelling or switching sections aborts pending reads and discards late results. 401, absent wallets, invalid ranges and inconsistent storage have distinct visible outcomes; raw parser text is withheld.

The new owned marketplace workspace component replaces the old direct catalog mount only in the owned `app/marketplace/page.tsx`. Existing buyer catalog logic is unchanged. Protected shell and token layout files are untouched. Native buttons, labels, visible focus and the CSS module were checked against the React guidance.

## Verification

- Seven files and 113 tests pass together: new domain 27, actual local-D1 API 9, owned/workspace UI 12, existing catalog 34, provider 7, catalog API 8 and buyer UI 16. Includes owner isolation, over-capacity refusal, history gaps, prior revisions, failed reads, duplicate signatures, false-authority responses, stale views, pagination, cancellation and sign-in/error handling. No live provider or funded operation is used by these tests.
- Plain TypeScript, scoped ten-file typed lint, eleven-file formatting and diff checks pass.
- The isolated production build on `85419f1` plus the eleven owned application/test overlays exits 0 with `unchanged: true` and `passed: true`. Existing nested-workspace and no-cache warnings are retained. No application source changed while the build ran.
- Synthetic ordinary Chrome checks use the real model/panels/CSS and declared public transport fixtures. They cover catalog/owned switching without a request, explicit load, source disclosure, age filtering without an extra GET, missing-date exclusion, natural view expiry, and malformed/HTML refusals clearing cards. At 1920, main client/scroll widths were 1905/1905; at 375x812, 360/360, with one matching phone card and minimum 44-pixel controls. The viewport was reset. Initial tab navigation timed out; the same created tab was then inspected, without starting a duplicate browser. Synthetic Link rendering is an anchor adapter, not a full Next router test.

Public fixture screenshots are retained under `docs/qa/20261020/marketplace-owned/`. Ignored local logs/results: `work/release-qa/marketplace-owned-tests-20261020.json`, `work/release-qa/marketplace-owned-build-20261020/result.json` and `work/marketplace-owned-browser-20261020/`.

## Remaining work and boundaries

This is saved inventory evidence, not a production supplier or a completed wallet-selling marketplace. Fresh provenance/funding verification, supplier inventory admission, reservation/quote lifecycle, pricing, buyer terms/consent, payment, secure custody/delivery and recoverable orders remain open. No production signed-in check, whole-repository suite, funded transaction or full Proxima parity is claimed.

No migration is added; the journal still ends at 0117. No application/hosted SQL, provider, credential, cron, real wallet unlock/sign/send, sale or deployment occurred. Git publication does not activate these features in production.
