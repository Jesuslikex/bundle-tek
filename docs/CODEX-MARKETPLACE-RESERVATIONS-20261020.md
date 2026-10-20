# Expiring whole-cart marketplace reservations

20 October 2026. Source-only backend step after `6b7579f`. This is not a live checkout release.

## Reference and scope

Proxima's [current marketplace documentation](https://docs.proxima.tools/wallets/marketplace/) describes selection review, checkout, one settled payment, delivery/import progress and purchase history. The retained 12 October REA controller/service evidence in `CODEX-PROXIMA-MARKETPLACE-REFERENCE.md` describes held-quote recovery and separate cancel/pay/settle/deliver methods; those are client source observations, not proof of successful backend execution. No fresh REA runtime capture or competitor checkout action is claimed here.

Bundle's first-party catalog and cart review already exist. This step adds internal reservation domain/storage functions and source-only migration `0120_marketplace_reservations`. It has no HTTP entry point or UI mount yet. Existing cart previews remain unreserved. API authentication, buyer UI, held-inventory filtering and request-rate controls must be integrated before exposing this service.

## Contract

- A reservation requires a separate exact acknowledgement, the complete current cart review, a stable caller-generated UUID and a verified buyer ID supplied by the future authenticated route. The acknowledgement explains five minutes, no purchase/payment/signing/key delivery, Bundle-only sales and possible retained private-key copies.
- The service independently replays every cart digest, asking price, source timestamp and false financial flag, then freshly reads current Bundle publications and requires exact public-entry fingerprints. It checks expiry and cancellation before the insert.
- One immutable row contains the entire cart. Its insert trigger refuses any address overlapping another unexpired, unreleased reservation. There are no partial per-wallet writes, renewals, overwrites or leases acquired by browsing.
- Insertion-time guards recheck every public listing, immutable parent, wallet revision, label, update timestamp, active state, control proof and withdrawal status. UUID/count/distinct IDs/addresses, exact acknowledgement, expiry and false financial flags are checked in SQL as well as the domain layer. Server operator configuration is enforced by the fresh catalog read; it is not inferred from buyer-supplied roles.
- A reservation lasts exactly five minutes from server creation. The original review must still be within its original 60-second source window. Recovery under the same buyer and ID returns the original record without renewing it; a changed request under that ID refuses. Expired historical receipts remain readable without granting a new hold.
- Release is a separate acknowledged, append-only event bound to buyer, reservation ID and hash. Another buyer cannot read or release it. Released holds stop blocking another reservation; neither reservation nor release history can be updated/deleted through normal SQL.
- Persisted `reserved: true` records the original grant. The returned `held`/`released`/`expired` state determines its present lease status. Future payment code must never treat the historical boolean alone as authority.
- `purchaseEnabled`, `paymentEnabled`, `deliveryEnabled` and `signingAllowed` remain literal false. This does not qualify wallet provenance, guarantee current balances or exclusive custody, choose a payment destination or produce a signed packet.

## Verification

The new domain/storage tests use real SHA-256 content replay and the production Turso adapter against disposable in-memory libSQL. Fixtures create genuine operator drafts/publications/control-proof rows through the existing services. No provider calls are permitted.

They cover exact totals and acknowledgements; overlapping buyer races with exactly one whole-cart winner; recovery after a committed insert loses its response with exactly one write attempt; buyer isolation; exact release and subsequent acquisition by another buyer; changed withdrawal/revision/proof/operator sources; altered authority/price/expiry/hash/count; immutable history; missing schema and cancellation. Expired-hold SQL behavior uses one explicitly seeded, content-valid historical fixture with the insert trigger temporarily removed only in the disposable test database, then restored before a normal new reservation. No production clock or safeguard is changed.

The checksum-checked runner upgrades a fresh disposable local file from 0119 to 0120, preserves the 120 original ledger rows and sentinel data, matches all 121 checksums, passes integrity/foreign-key checks and repeats with zero new migrations. Whole-file Wrangler independently applies all 121 migrations locally. The upgrade script's `--remote` flag targets an explicit `file:` URL with sanitized environment, not any application/hosted database.

All 23 marketplace files pass together: 309 tests, including 22 new domain/native-storage cases. Plain `tsc --noEmit --incremental false`, scoped type-aware lint and formatting pass. No new browser or production-build result is claimed for these currently unmounted internal functions. Committed migration evidence is in `CODEX-MARKETPLACE-RESERVATIONS-UPGRADE-20261020.json` and `CODEX-MARKETPLACE-RESERVATIONS-WRANGLER-20261020.json`; detailed test results remain in ignored `work/release-qa/marketplace-reservation-tests-20261020.json`.

## Remaining work

Next: authenticated bounded API, explicit unchecked buyer consent and reservation/recovery/release UI, plus held inventory exclusion. Then qualified sale evidence, payment destination/receipt admission, one approved payment, secure key delivery and durable order history/recovery. Existing cart or reservation hashes must not substitute for those approvals.

No application or hosted migration, actual listing publication or reservation, real operator configuration, provider/credential/cron change, wallet unlock/sign/send, funded action or deployment occurred. The journal ends at 0120; next free number is 0121, subject to recheck.
