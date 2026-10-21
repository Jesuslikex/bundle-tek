# Warmup runtime wallet availability

Source base: `8659deb25e5ae858b3ed7846596ab5ecc445a103`. Source-only work, signing off, no deployment.

A native regression reproduced an unsigned runtime preparation while the selected wallet had a `reserved` stock-pair parent. The original warmup context checked shared swap/execution locks; separate stock/launch/Volume parents were not included. The failed `prepared` versus expected `refused` result is retained locally in `work/release-qa/warmup-runtime-wallet-busy-regression-20261021.json`.

## Change

The runtime adapter explicitly selects an additional read-only availability projection in its original current-plan SQL statement. That statement retains the existing owned journal, original source, head, action, terms, wallet revisions, plan identity, lease, expiry and no-result conditions. It evaluates all wallets in the original owned review, not caller-supplied wallet selectors.

The extra checks match the existing parent lock states:

- Stock-pair execution: `reserved`, `signed`, `submitting`, `submitted`.
- Pump launch: nonterminal payer and active holder/group buyer addresses, excluding `kind=none`; cancelled, failed and finalized launches do not block.
- Scheduled Volume: wallets in an active session, or in a cancelled/complete session that still has signed, submitting or submitted trades.
- Same-block Volume: `held` and `attempted` reservations, including expired reservations that still require explicit cancellation or settlement.

Additional checks cover active organic-holder sequences and their in-flight buys, cleanup, token supply actions, nuke sells, and fresh or approved Counter proposal reservations. Counter approvals keep the wallet busy after expiry until recovered. The legacy wallet_operations route is devnet-only and is not treated as a mainnet financial lock.

Existing shared swap/execution checks remain in the original context view. Ordinary preview and legacy provider defaults retain their original query and behavior. Only the production runtime adapter selects the additional projection. Missing parent tables or invalid projection results fail closed without provider calls. Existing retained-result recovery does not rerun providers or reinterpret history.

The original provider core repeats its current-plan reader before and after asynchronous work. A separate reservation appearing during the actual synthetic runtime order therefore prevents publishing a successful runtime observation. A runtime-only preflight reports pre-existing busy work before claiming an attempt. The identical fragment is repeated inside the service lease INSERT SELECT. A preflight-to-claim race selects zero rows, and the original deferred purpose foreign key rolls back the purpose and cooldown together. Saved-ID recovery happens first. An independently demonstrated native race leaves counts unchanged and later allows explicit same-ID admission as attempt 1 once the blocker is removed. Work becoming busy after actual admission can still consume that already-admitted attempt; no refund, retry, cap increase or cooldown reset is invented. No additional RPC or expiry renewal was added. Both serial code scans, exact ordinary Clock rules, 32-slot window, custody, fee/rent and minimum-output checks remain unchanged.

## Verification and limits

Final checks and source hashes are recorded in the companion portable evidence JSON. New tests use actual warmup ownership/context/source/lease admission and declared native read-side parent projections. These projections are explicitly not proofs of the stock/launch/Volume parents' signing lifecycles. A separate test applies the complete committed migration chain in disposable native SQLite, inserts a real-schema active Volume session/batch/trade, and proves that cancelling the session keeps the wallet busy until the submitted trade is finalized. Synthetic row values test SQL availability, not cryptographic signing/settlement admission.

Cases cover parent states, stopped-session in-flight children, supported launch holder formats, `none`, terminal rows, other owners/wallets, a second selected wallet, provider work in progress, no-provider refusal, same-ID saved recovery, missing schema and ordinary-preview isolation. The runtime Sell composition and original server/browser checks are included in the related regression cohort.

These are advisory availability reads, **not financial reservations or execution authorization**. A race remains after the last read and before a later database write. The service lease SELECT atomically refuses an already competing parent, but does not reserve the wallet or prevent another workflow from acquiring it later. This patch adds no shared financial-lock triggers, migrates no original guard, creates no funds hold and does not convert read-only consent into trade consent. Financial reservation and recovery, separately approved short browser signing authorization, trusted code policy, finalized settlement/action advancement and durable automatic execution remain open. Do not enable signing from this checkpoint.

No production UI, protected Claude file, migration/schema, provider, credential or cron setting changes. No application/hosted SQL, real wallet unlock/sign/send, funded test or deploy.

## Opus review

Actual claude-opus-5-5 completed the initial read-only review with zero denials and an unchanged 2,754-file copy. It found missing lock stores, in-flight child trades and pre-existing busy attempts consuming the qualification cap. Those findings were addressed with independently run native tests. A second actual Opus5.5 review began on the corrections but ended with a session-limit error (reset shown as 4:40pm Europe/London); that follow-up is incomplete, not an approval. Its 2,755-file copy was unchanged, with zero denials. No fallback model or reviewer test run occurred. Codex independently checked the corrected source and its admission/rollback/recovery tests.

## Final verification

The final fresh pinned Node24.19.0 run passes 2,081 tests in 112 related files, with one opt-in prior real SQL-clock test skipped. Its actual terminal exit is0, all expected files/ordinary assertions are complete and all2,795 frozen source hashes are unchanged. Plain TypeScript, seven-file typed lint/seven-file formatting and the final isolated production build pass. The build uses committed8659deb plus seven exact overlays without a local environment file or production credential; source hashes remain identical.

A preceding corrected-source run was rejected after a Vitest worker exited unexpectedly, leaving three assertions unreported even though the JSON reporter claimed success. Its original error and pending assertion names are retained. All20 tests in that consent-view file pass alone; the fresh full run passes without concurrent build/review processes. The crash cause is unconfirmed and is not claimed fixed in product code. The earlier2,041-pass run predates completion of the review corrections and is not final-source verification. This remains a related-cohort, synthetic/native-SQL verification, not full-repository, live-provider, signed-in browser or funded execution proof.
