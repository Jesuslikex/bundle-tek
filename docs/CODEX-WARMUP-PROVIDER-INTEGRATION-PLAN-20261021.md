# Warmup provider integration: current evidence and next implementation

Source assessed: `619c64e618f6ff2f65eff615d7d7637e34d0be02`. The full Proxima parity goal remains open. First-action preview is an intermediate integration, not a substitute for working multi-wallet activity sessions.

## Completed independent assessment

Actual installed Claude Opus 5.5 completed a focused read-only architecture assessment. Requested/selected/actual models were only `claude-opus-5-5`, with Read/Glob/Grep only, zero permission denials or edits, no tests or provider calls, and all 2638 copied source files unchanged. Ignored original result: `work/release-qa/opus-session-provider-design-619c64e-20261021/review.jsonl`; terminal metadata: `status.json`. This was a design assessment, not approval or verification of code that has not been built.

Opus read the preparation/packet/binding/finish/sequence modules, session view/review, parts of journal storage/replay/consent, both journal and manual preparation routes, quoting/history/buy-link/inventory code, and relevant 0127–0131 triggers. It did not read the simulation/signing implementations, settlement modules, test bodies or UI components in full. Codex must inspect those before relying on any proposed runtime or cost predicate.

Confirmed directly in current source:

- `prepareWalletWarmupSessionAction` has no application caller. Its current callers are tests. It already validates owner/head/plan/wallet/storage gates, binds the derived pending action, writes the ordinary preparation, binding and unsigned packet atomically, and recovers the exact original ID.
- The manual warmup preparation route uses `prepareSolanaSwap`, fresh sell inventory, matched buy links and `simulateImportedSwap`. Its independent save must not be called or copied as an extra write before session-owned atomic storage.
- TypeScript replay and SQL 0127/0130/0131 enforce the earlier source-preview/approved-finish window. Signing is forbidden for session-bound preparations. A successful unsigned preparation is not an executable session.
- A 40-minute session cannot run by reusing the old 60-second preview. That limit must not be silently extended. Prepared work cannot currently advance to another action while signing remains off.
- Fresh REA discovery of the approved loopback endpoint9223 returned `endpoint_unreachable`. No fresh REA runtime/network capture was obtained. The separate Chrome UI verification is described in the progress handoff.

## Next coherent code slice

Implement a real trusted provider callback and an authenticated, bounded session-preparation/recovery API, with no signing or automatic runner UI. This must connect to the existing atomic storage path, not create another disconnected store.

1. Enrich the trusted callback's copied candidate with the already-admitted plan identity/document/updated time, exact remaining wallet budgets and effective deadline. Do not accept these objects, amounts or wallet selections from HTTP. Recheck current ownership, plan/wallet revisions and original source before provider work and after asynchronous reads.
2. Buy input must exactly equal both the derived action's raw lamports and the saved deterministic plan amount. Sell input must exactly match the owner-scoped finalized linked lot's current remaining units and decimals. Reuse `warmupBuyLink` and `inspectWarmupSellInventory`; no historical-lot fallback or aggregate-holdings substitution. Re-read the retained source after provider work so outside consumption cannot silently change the lot.
3. Add bounded, owner/action/request-aware provider pacing and duplicate-request handling before mounting the route. Inspect existing read-gate semantics: its 15-second cooldown alone is not proof that concurrent requests cannot overlap a 25-second provider call. Claim any required next migration only after rechecking AGENTS and the journal. No provider setting or credential changes.
4. Obtain the actual unsigned order through `prepareSolanaSwap`; check exact side, wallet, mints, raw input, expiry and packet identity. Run the existing independent simulation and require a successful, matching result before saving. All signals/deadlines must cover response-body reads and final retained publication.
5. Validate approved budgets using documented fee/rent/native-delta semantics. Opus proposed summing provider estimated fees and simulated network fees; do not adopt that arithmetic until inspecting whether they overlap. Do not weaken an existing custody, minimum, code or lifetime check to obtain a pass. Conservatively reject missing or contradictory evidence.
6. Always return `{summary, transaction}` to `prepareWalletWarmupSessionAction`, retaining the exact unsigned packet and original wrapper in the existing atomic batch. Production must not select the legacy summary-only path; it lacks the packet freshness guard. Same-ID recovery must not request a new quote or renew an expiry.
7. New API: authenticated exact-origin JSON POST, streamed small body, strict canonical request ID/journal ID/head/version and explicit preparation intent; no client callback, amounts, signatures or finality labels. Saved-only owner-scoped GET works after expiry and returns 404 for absent/foreign IDs. Public allowlist returns review metadata and packet availability/hash, never raw packet bytes, plan/proof documents or internal records. All execution/signing/automatic flags remain false. Unknown writes require original-ID recovery; never promise nothing was saved after an uncertain write.

Required tests must exercise the actual route, actual local SQL/storage and synthetic Jupiter/RPC transport: review→consent→journal→begin-review→one atomic preparation/packet; saved-only recovery after expiry; lost response and competing IDs; provider failure or wrong amounts; failed simulation; source/lot/wallet/head changes while reads are pending; pause/Stop; source/finish expiry; missing guards/capacity; pacing/duplicate admission; cancellation and safe errors; and continued SQL/manual-path signing refusal. Unit green checks alone are not live provider or funded qualification.

## Still required for the full session

A future fresh per-action qualification must bind the original immutable consent/terms/plan, current plan updated time and wallet revisions, exact action/source/remaining lot, replayed remaining budgets, journal head/version, fresh cycle/receipt/recovery state and a new bounded action expiry capped by the originally approved finish. Old previews and historical records must retain their existing semantics.

Existing SQL guards are cumulative. Adding a permissive trigger cannot override the old freshness refusal. Any versioned policy needs a new migration file, unchanged historical migration bytes/checksums, explicit old-record compatibility, database-clock enforcement and full disposable migration/replay tests. No such migration is implemented or claimed here.

Before enabling execution: shared wallet/lot reservations across manual and session paths, short exact-packet browser signing authorization, retained submission before one broadcast attempt, unknown/finalized receipt recovery, independent runtime/code/custody/lifetime/minimum checks, and multi-wallet orchestration/pacing remain necessary. Unknown or stopped work must never be re-created automatically. Longer sessions, alternative routing, remaining Proxima features and real provider/funded proofs are not complete.

No application/hosted SQL, provider/credential/cron, deployment, wallet unlock/sign/send or funded action occurred in this assessment. No new migration number is reserved.
