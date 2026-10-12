# Live holder enumeration and persistence, 12 October 2026

The existing Proxima workspace visibly identifies DINGER mint `Ap1o2WJYUarJLjT5LQWGH1ztuiV4PcUyqEEfL8jbpump`. Bundle's unchanged default DAS cursor reader was tested against its existing mainnet Helius configuration for this public mint. No keys, endpoint queries, cursor values or raw provider errors were retained in reports.

## Live enumeration

The production `observeHolderIndexPage`, `appendHolderIndexPage` and `holderIndexSummary` paths consumed two pages: two positive token accounts on the first page, then an empty page with terminal cursor. Both owners had positive balances. Exact indexed balance and mint supply were each `1000000000000000` atoms at six decimals. The remainder was zero and covered supply was 100%.

Eight RPC requests succeeded with HTTP 200 and no JSON-RPC errors: genesis, finalized supply, mint program lookup and token-account enumeration per page. Indexed slots were 456133254 through 456133256; supply slots were 456133221 through 456133223. This is a changing provider index, not a single-slot atomic snapshot. Report: `work/live-provider-qa/holder-enumeration-das-cursor-report.json`.

## Actual API with isolated D1

`work/live-provider-qa/holder-route-live.qa.test.ts` applied all 69 journal migrations to disposable local Miniflare D1, inserted a test-owned project for the same public mint, and invoked the production holder-index POST/GET handlers and store. Only authentication and selection of the disposable DB were test-bound. Provider decoding, persistence, replay, scope checks and reload assembly used the production implementation.

The first live page persisted; GET reconstructed its saved balances and continuation cursor without a provider read. The second POST resumed from that saved page and reached terminal enumeration. GET again rebuilt identical totals and reported the enumerated run. Replaying each saved POST returned the same page without extra provider reads. A different test owner received 404 for both GET and POST with no provider call.

The test passed with two persisted reloads, two idempotent page replays, eight live RPC requests, two positive owners, 100% covered supply and zero remainder. Report: `work/live-provider-qa/holder-route-live-report.json`. All writes were inside disposable local D1; no user or hosted application data was changed.

Both opt-in tests skip before reading configuration or calling providers during ordinary test runs. They cap scans at three pages and twelve requests, and live read time at 45 seconds. Reports contain only public scope, method/status/code and aggregate evidence. The holder route's generic troubleshooting message now describes cursor pagination and slot metadata instead of incorrectly insisting on getProgramAccountsV2 while the default path calls getTokenAccounts.

## Remaining coverage

This proves terminal enumeration and persisted resume/reload for one small token case (the later parsed lookup identifies Token-2022; the earlier report did not record the program). It does not establish large-token pagination performance, Token-2022 withheld-fee/extensions, completeness across closed/reassigned accounts, single-slot consistency, all historical holders, Proxima's internal accounting, full UI parity or hosted readiness. The optional program-accounts-v2 reader is separately implemented and documented by the provider, but this run exercised the app's default DAS path. Official V2 reference: https://www.helius.dev/docs/api-reference/rpc/http/getprogramaccountsv2.

Claude's holder/watch-wallet components and reliability files were not changed. No credential changes, provider setup, signatures, broadcasts, live migrations, push or publication occurred.

Verification: both opt-in live tests passed. Fourteen existing holder decoder/store/API tests passed after the wording correction. TypeScript and scoped lint passed. Both new live tests skipped during a flag-free run, confirming ordinary validation does not opt into provider access.

## Larger live token: bounded USDC continuation

Circle's current issuer list identifies Solana mainnet USDC as `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`: https://developers.circle.com/stablecoins/usdc-contract-addresses. Two new opt-in checks use this public mint through the existing approved Helius application configuration. Credential values are not printed or retained in reports, and configuration is unchanged.

The first probe at 2026-10-12T19:37:42.695Z read exactly two 1000-account DAS cursor pages. Production decoding/aggregation found 2000 distinct accounts and 1955 positive-balance owners, six decimals, indexed slots 456164287–456164289 and supply slots 456164255–456164256. Both pages returned continuation cursors. Exact indexed atoms were 1511239291530 against reference supply 7611567889797640, reported coverage 0.0198% and remainder 7610056650506110. Status remained partial and fullCoverageEstablished=false. Eight read-only RPC calls succeeded with HTTP 200 and no JSON-RPC errors. No database writes occurred. Report: work/live-provider-qa/holder-large-mint-das-cursor-report.json.

The second check at 2026-10-12T19:40:13.966Z applied the complete 69-migration chain in disposable Miniflare D1 and exercised the actual POST/GET/store paths with live provider decoding. Two live pages persisted and reloaded as 2000 accounts / 1955 positive owners. Replaying each page returned the same saved data, with zero extra provider calls. A foreign test owner received 404 without provider access. It remained partial at 0.0198% with continuation available; exact indexed atoms were 1511239451508 against its own reference supply 7611567884797640. Those are a separate observation, not an atomic snapshot or a copy of the first probe. The mint program was TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA. Report: work/live-provider-qa/holder-large-route-live-report.json.

Each check enforced a two-page/eight-request cap; this continuation used 16 provider requests in total. The second report originally declared twelve as its requestBound while the actual fetch guard enforced eight; that metadata was corrected without rerunning or changing aggregate results. Production-database writes, signatures and broadcasts were zero. Both tests passed, then both skipped in a flag-free run. The new harnesses are ignored local QA files, not a CI claim of live coverage.

This supplies real large-page pagination and persistence evidence beyond the earlier small-token probe. It does not establish full USDC enumeration, live withheld-fee/Token-2022 extension handling, single-slot consistency, historical holder coverage, fresh movement classification, rendered integration or hosted readiness. No additional production source change or deployment was made in this pass; Claude's protected files remain unchanged.

## Parsed Token-2022 account fee support, local continuation

The holder panel now exposes an optional parsed program-account scan mode while retaining DAS as the default. The mode is included in immutable page retry requests, forwarded to the existing provider adapter, and checked against saved/replayed pages. Resuming a saved run uses its stored mode rather than the new-scan selector. Invalid mode values and mismatched response modes are rejected; there is no automatic fallback or provider credential change.

The program-account reader validates parsed `transferFeeAmount` extensions and preserves exact u64 withheld amounts as optional account metadata. Saved page JSON retains this metadata without altering the existing base-balance index totals or database schema. Owner holdings and concentration remain based on base token amounts. The UI separately reports observed account-withheld fees and the unexplained remainder after those fees; missing extension data is unmeasured, and contradictory fee totals block holder results. Mint-harvested fees remain unmeasured. The distinction follows Solana's official transfer-fee documentation: https://solana.com/docs/tokens/extensions/transfer-fees.

Thirty-six focused tests passed across provider decoding, aggregation, saved-page storage, history restoration, immutable retry requests and API scan-mode selection. Fee tests use synthetic responses, not a live Token-2022 receipt. TypeScript and scoped lint passed. Live parsed-provider availability, representative complete Token-2022 enumeration, rendered selection/resume interaction and temporal consistency remain unverified. No live RPC calls or transaction actions were added by this test pass.

Parsed-holder continuation production build completed successfully after the final scan-mode and fee-display changes. The frozen full-suite snapshot predates these changes; browser/live-provider verification remains outstanding.

## Actual parsed route and Token-2022 lookup

At 2026-10-12T20:41:57.188Z, the production holder POST/GET/store/provider paths passed the optional parsed-mode check against the existing Helius configuration and disposable Miniflare D1 with all 69 local migrations. DINGER's live mint owner was `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`. The earlier description of this token as legacy was incorrect: its supporting earlier report did not record the mint program. That wording has been corrected.

The live parsed query exhausted in one page with 12 token accounts and two positive-balance owners. Exact indexed owner units and reference supply were both `1000000000000000`; the reported remainder was zero and coverage was 100%. Reload reconstructed the saved page and replay returned it unchanged, with no extra provider requests. Replaying with DAS mode returned 409, and a foreign test owner received 404 for reads and writes without provider access. Four RPC requests succeeded: genesis, token supply, mint account and getProgramAccountsV2. Production database writes, signatures and broadcasts were zero. Report: `work/live-provider-qa/holder-parsed-route-live-report.json`.

Two preceding diagnostic attempts stopped after three preliminary RPC reads each because the QA harness incorrectly restricted enumeration to the legacy program. Their reports remain retained as `holder-parsed-route-live-first-report.json` and `holder-parsed-route-live-diagnostic-report.json`. The guard was repaired to require the program actually observed for the selected public mint, bounded to the two supported token programs, with the exact mint filter. This was a harness correction, not a production-provider failure. This continuation performed ten total read-only RPC requests across the three bounded attempts, and no new provider credential or paid setup was created.

The latest harness skipped in a flag-free run and scoped lint passed. No current production-source changes were needed in this continuation. The live check establishes parsed-route availability and saved-page recovery for this small Token-2022 case. It does not establish positive withheld-fee accounting on live accounts, mint-harvested fee coverage, confidential extensions, complete large-token enumeration, single-slot atomicity or rendered interaction. The report does not retain withheld-fee aggregates or exact read slots, so those cannot be inferred from it. Helius documents the used `withContext=true` response shape and mint filters at https://www.helius.dev/docs/api-reference/rpc/http/getprogramaccountsv2.


