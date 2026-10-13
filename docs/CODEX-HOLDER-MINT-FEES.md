# Holder mint fees and extension coverage

13 October 2026. This is later production source than the 997-file, 1,919-test baseline. The full Proxima reconstruction remains incomplete.

Review continuation: changed/disappearing mint observations now use a typed conflict and return HTTP 409 with a fresh-scan explanation; they no longer trigger redundant provider retries. Account unparseableExtension occurrences are separately counted and disclosed, alongside mint parsing gaps. Thirty focused checks passed after these fixes, followed by the later combined 53-test history/holder run, TypeScript, scoped lint and production build. The later 1,002-file snapshot is recorded in CODEX-TOKEN-OPERATION-HISTORY.md; the earlier source hash below describes the previous mint-fee milestone.

## Implemented behavior

The existing mint-program lookup now requests jsonParsed mint data instead of an empty base64 slice. There are still four RPC reads per page. For Token-2022, the reader validates mint type, initialization, reference supply/precision and finalized observation slot. It records extension names and the ordinary transferFeeConfig withheld accumulator. Missing parsed extension metadata stays unmeasured; a fully parsed extension set with no ordinary fee config records zero. An unparseable extension without a known ordinary config remains unknown.

Mint fee units and extension names must remain consistent across pages. Changed or disappearing observations require a fresh scan instead of silently combining possible harvest/withdrawal changes. Observation slots are retained as a range, not represented as a single atomic snapshot.

Saved page JSON and run context retain the observations without a migration. New runs accumulate observed account-withheld amounts independently of indexed base balances. The server rejects combined balances, observed account fees and mint fees that exceed reference supply before inserting the next page. Older headers lacking cumulative observed-fee metadata retain an unknown total instead of inventing zero. Owner-scoped reload/replay reconstructs the same evidence.

The holder panel separates base owner balances, account fees, mint fees and the unexplained remainder. Fees are excluded from owner holdings and concentration. Parsed account extension names and mint confidential-extension names are retained as coverage evidence. The panel states that encrypted balances/fees remain unmeasured when confidential extensions are present and preserves missing-extension and non-atomic-index disclosures.

Solana documents ordinary transfer fees on destination accounts and harvesting to the mint in its [transfer-fee reference](https://solana.com/docs/tokens/extensions/transfer-fees). Its [account-decoder source](https://docs.rs/solana-account-decoder/latest/src/solana_account_decoder/parse_token_extension.rs.html) describes the parsed fee and confidential-extension representations. The RPC reader preserves numeric integer spelling before Number rounding.

## Local verification

- Focused holder regression run: 56 tests in 16 files passed, execution session 86175, exit 0. This includes existing retry/store/history/API cases, new mint validation and panel markup, and the real provider/API/disposable-D1 fee integration.
- Final changed-test rerun after lint narrowing: five tests in two files passed, session 85470, exit 0.
- TypeScript passed; scoped oxlint passed after explicit test-input narrowing.
- Production build passed, session 60592, exit 0.
- Source snapshot: work/release-qa/source-holder-mint-fees-20261013.json, 1,001 files, digest 615937a763aa8a0f389c602b333000c1ccab442ce0e9c03b8e5403d88984a2ab. Post-build/live-QA verification matches.
- All six protected Claude files match the prior frozen snapshot.

The disposable D1 integration applies all 72 migrations, saves/replays the first page, rejects a changed mint accumulator, rejects cumulative over-counting without inserting another page, then saves a valid terminal page. Reload reconstructs 75% owner balance coverage plus separately observed account/mint fees, zero unexplained remainder, retained observation slots and owner isolation. Its nonzero fees are declared fixtures.

## Live provider verification

The previously approved bounded PYUSD harness was copied to an ignored, separate mint-fee QA file. The prior harness and report remain intact. Session 36249 completed with exit 0, one passing opt-in check. Sanitized report: work/live-provider-qa/holder-mint-fee-route-live-report-20261013.json, observed at 2026-10-13T03:27:50.183Z.

Exactly eight read-only RPC requests returned HTTP 200 without RPC errors. Two pages persisted and independently reloaded in disposable D1; page replays/reloads made zero extra provider requests. The scan contains 2,000 accounts and 219 positive owners, covers 0.0012% of reference supply and remains partial. Ordinary account-withheld and mint-harvested observed totals were both zero. Mint slots ranged from 456293345 to 456293355. The live mint reports confidentialTransferMint and confidentialTransferFeeConfig, which the new coverage display identifies without attempting decryption or treating encrypted amounts as zero.

No production DB writes, signatures, broadcasts, migration rewrites, provider credential changes, push or publication occurred. Keys, full endpoints, opaque cursors and account payloads are excluded from the report.

## Remaining evidence

Positive ordinary fees on representative live accounts/mints, full large-token enumeration, encrypted balances/fees, closed-account history, temporal consistency and actual rendered/hosted integration remain unverified. A zero unexplained remainder is a reconciliation of observed reference units, not proof of a globally complete on-chain snapshot. Hosting migration diagnostics remain a separate blocker.
