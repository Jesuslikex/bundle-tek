# Launch artwork and metadata release

14 October 2026. Local implementation only. The user identified unfinished image upload and tokenized-stock launch execution as the priority. The original hosted site has not received these changes. This checkpoint addresses the metadata publication boundary; it does not create a coin or establish stock-pair support.

## Behavior

The existing artwork library remains private. New `POST /api/launch/metadata` requires authentication, same-origin JSON and exactly `{projectId, updatedAt, publishPublicly: true}`. The eventual UI must explain that the saved name, ticker, description, social links and uploaded image become public and cannot be revoked through this feature. No UI invokes this API yet.

Only active owner-scoped Solana PumpFun/StonkFun drafts and active owned PNG/JPEG uploads qualify. Arbitrary artwork URLs are not fetched. The stored bytes must match both the uploaded SHA-256 identity and MIME inspection. A single guarded database statement binds publication to the exact saved project document, timestamp and image bytes. Concurrent changes reject a new release. Identical concurrent requests produce one release. Account storage is limited to 100 releases, each using the existing 512 KB image limit.

New anonymous `GET /api/launch/metadata/[id]` and `/image` serve only explicitly released snapshots, with public immutable caching and cross-origin reads. Private upload hashes are not public release IDs. Metadata omits account/project/wallet information and private launch settings. Image bytes are copied into the release so later private-artwork deletion or draft edits do not break the token URI. Database triggers reject release updates and deletes.

The returned HTTPS metadata URI is bounded to 200 characters for the subsequent launch builder. Availability still depends on maintaining this hostname, hosting and database; this is not IPFS/Arweave permanence. Host migration must preserve existing public URIs or arrange durable external storage before an on-chain mint references them. No application or test uses provider credentials, signs, submits, deploys or publishes hosted user content.

## Source and remaining launch integration

Fresh official Pump creation documentation was read on 14 October:

- https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md
- https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/CREATE_WITH_PUMP_COIN_QUOTE.md

The listed quote-mint and nested Pump-coin paths are distinct. Custom Pump-coin support is not evidence that arbitrary stock tokens are admitted. StonkFun's executable program/configuration, quote admission and current issuer/mint identity still need primary-source/runtime verification. No unverified stock mint or third-party launch builder was adopted.

Next required work: metadata consent/review UI tied to the exact saved draft; immutable URI handoff into a venue-specific unsigned create transaction; live quote/configuration and mint checks; simulation, complete instruction/fee/authority review; explicit browser signing and submission; receipt recovery; approved funded proof. Current launch execution remains disabled. Existing trading/Counter/Jito work does not constitute that launch flow.

## Validation

The new migration is append-only 0078_lush_rictor, with a generated schema snapshot and journal entry. Real whole-file Wrangler applied all 79 migrations to disposable local D1: `C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-pBImbS\report.json`. Hosted history and the CROP candidate are untouched.

Final targeted route/artwork/launch-plan/quote-catalog regression passed: 31 tests across four files, including nine new real-route/D1 tests. JSON report: `work/release-qa/launch-metadata-20261014.json`. Actual-source TypeScript, six-file typed lint and production build all exited zero on the final source. Route tests exercise consent, owner isolation, stale/archive guards, invalid bytes, private/public reads, immutable updates/deletes, survival after private deletion, concurrent idempotence, a mid-request project mutation and owner quotas. This is API/local-D1 verification, not rendered browser or funded launch proof. No UI or protected Claude file changed.
