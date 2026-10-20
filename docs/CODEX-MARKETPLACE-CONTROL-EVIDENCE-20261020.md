# Saved seller control records

20 October 2026. Foundation following 660331f, with no API or UI caller yet.

The existing ownership route records the verification time and challenge identity, but does not store the signature. Its generic message covers the saved public address, not a wallet revision, asking price, listing, transaction or exclusive custody. This checkpoint makes those limits explicit rather than treating every historical proof as current seller control.

`readMarketplaceControlEvidence` makes one parameterized SELECT joining the exact active owned Solana wallet revision to its ownership proof and original challenge. The challenge join repeats owner, chain and address predicates. It does no writes, provider requests, challenge generation or key access. Authentication and operator authorization remain mandatory responsibilities of the future caller. Cancellation is checked before and after storage and after evidence construction.

The evidence distinguishes no record, a missing original challenge, an expired original challenge, another origin and a recent same-origin record. The original canonical nine-line ownership message is reconstructed exactly and hashed. Its original five-minute issue/expiry window, challenge identity, consumed claim and verification/use time must agree. Missing challenges stay explicitly unavailable, including when the existing ownership route has purged them. The sixty-second informational snapshot never extends the original recent challenge window. Verification time does not start a new five-minute window.

Client admission independently checks the exact selected address/revision/price, captured inventory update and proof timestamp, site origin, canonical message hash, original timing, classification and snapshot expiry. All signature replay, revision/price consent, current control, exclusive custody, publication, sale, payment, delivery and signing capability fields are literal false. A recent retained verification record remains a historical server assertion; no signature is replayed, and no ability to sell or safely transfer key ownership follows from it.

## Verification

Final offline marketplace run passes **554 tests across 35 files**. This includes 32 new model/admission cases and six server composition cases. Plain `tsc --noEmit --incremental false`, five-file type-aware lint and formatting pass.

The server tests use a disposable in-memory libSQL database with the real Turso adapter, unchanged 0013 proof/challenge schema and the actual existing ownership HTTP route. A fixed synthetic test key signs only that test route's generated ownership message. Tests verify unsigned/invalid challenges, successful retained verification, purged challenges, foreign owners, stale revisions, archived wallets, cross-tenant challenge isolation, incomplete consumption and cancellation. The new reader performs one SELECT, no provider call or write. The synthetic secret is cleared after each test; no real wallet is unlocked or used.

An earlier fixture test created the client inventory after the evidence observation, violating the intended snapshot order. It was corrected to capture inventory before requesting evidence. No admission condition was relaxed. No new production build, browser check, full repository suite or real-provider proof is claimed for this server/model-only checkpoint.

## Remaining work

Mount a manually requested, authenticated operator endpoint/panel with clear recent/expired/unavailable guidance. Direct users to the existing wallet ownership flow without adding a second signer or implying that its generic message approves a listing. Actual current control, full mint/authority/provenance qualification, checkout, finalized payment reconciliation, secure delivery/import and purchase recovery remain unfinished. Broader Proxima parity is not established.

No protected shell/layout, existing ownership route/signer, migration, application or hosted database, provider/credential/cron setting, real wallet action or deployment changed. Migration journal remains0121; recheck before using0122. Claude Opus5.5 review will be requested against the committed checkpoint; review results are not implied by this verification.
