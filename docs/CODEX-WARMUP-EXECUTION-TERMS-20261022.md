# Separate warmup execution terms and approval binding

22 October 2026. Source base `e004d14a7ab2026477f4c9d0d35b703e1510b1cb`.

This implements the non-circular model binding required by `CODEX-WARMUP-EXECUTION-ROOT-ADMISSION-20261022.md`. It is not a running Generate Activity feature, real source admission, human approval verification or storage. No API, UI, timer, signing or provider caller uses it. All returned authority flags remain false.

## What changed

`wallet-warmup-execution-manifest.ts` now shares its existing semantic body with a distinct pre-consent intent parser. The intent retains every planned manifest field except the not-yet-known consent hash and uses its own format. No zero or placeholder consent hash is inserted. The old manifest format, strict policy, asset/lot/order/budget/pacing checks and ledger/archive meaning remain unchanged. Codex compared the old and extracted semantic statements with the TypeScript printer; they match exactly.

`wallet-warmup-execution-terms.ts` binds:

1. Complete intent, exact retained review identity/digest/original times and an internal verifier-evidence digest into terms.
2. A separate approval with exact acknowledgement, owner/root/consent/review identities, terms digest and original session expiry.
3. A root containing the exact terms and both terms and approval digests.
4. The existing flat manifest, explicitly rebuilt with the computed consent digest and hashed in its original domain.

Every hashed record has its own strict format. The new root digest is not interchangeable with the flat manifest digest. In particular, the existing ledger's `rootSha256` and `expectedRootSha256` still mean its flat manifest digest. A composition test proves that it refuses the new root digest. No old v1/v2 plan consent is converted.

Root, consent and review IDs must be distinct. The original review window stays positive and at most the named 60-second maximum; a shorter captured expiry is preserved. Original reviewed time must match intent creation. Approval is within the original review and session windows, with exclusive expiry. Necessary schedule feasibility is checked again from recorded approval time without moving the deadline. Neither binding nor recovery reads the current clock or renews anything. Actual admission must later compare the exact captured expiry with the retained source and recheck current server time transactionally.

Mutable input is parsed into detached snapshots before hashing. Recovery needs an independently supplied expected owner/root/consent/review identity and root digest, then rebinds and compares the complete canonical root. Mutating returned data does not make its old digest valid. Root terms and the adapted flat manifest do not share mutable action arrays. This remains an integrity contract; IDs, hashes and acknowledgement text alone prove no ownership, facts or human consent.

## Evidence and review

Final coverage is 153 distinct tests across six files: a 152-case combined execution terms/manifest/ledger/pacing/archive/BLOB-transport pass, then a 47-case terms pass after adding one read-path timestamp case. Zero failures or skips. Reports: `work/release-qa/warmup-execution-terms-delivery-20261022.json` and `warmup-execution-terms-final-read-20261022.json`. Plain TypeScript, three-file typed lint and formatting pass.

Tests cover old/placeholder/wrong-domain refusals, all exact approval identities and references, original review/session boundaries, shorter expiry, distinct IDs, approval-time pacing, wrong independent selectors, otherwise-valid changed consent time, canonical ordering, detached input, changed output, and complete 4,800-action mixed model binding. The latter is synthetic format capacity, not owned source, SQL row/response/heap or production admission proof.

Two actual `claude-opus-5-5` source-only reviews used fifteen unchanged copies each with Read/Glob/Grep, zero denials and no tests/edits/network. The first identified approval-time feasibility, exact-lifetime coupling and minor timestamp/identity issues. The accepted fixes were independently tested and the final review found no blocking correctness, identity, domain or mutation issue. Final functional source matches that final review. One additional test for changed approval time during recovery and a corrected v2 format fixture matching `wallet-warmup-session-v2-consent.ts` were independently run afterward; these test-only follow-ups were not rereviewed. Logs: `work/release-qa/opus-warmup-execution-terms[-final]-20261022/`.

## Separate full-suite completion

The frozen `3bb015f547a69aab442f777f12fc4b60602bcffa` run completed at 20:16:07 UTC. It checked 799 physical files: 794 executed passes and five entirely skipped files, 8,559 passed tests, six skipped tests, zero failures and zero unhandled errors. All 46 native script tests passed separately afterward. All 3,593 source files and the offline harness hashes stayed unchanged. No environment files loaded; unmocked external Node traffic was blocked.

Original reports are preserved in `work/release-qa/full-release-3bb015f-20261022/`. `verified-result.json` derives the skipped-file count from actual assertions and the console: Vitest's JSON labels all 799 file records as passed, including the five wholly skipped files, so the wrapper's original `passedFiles:799` is not an executed-file count. This correction does not rewrite original output. Both owned run processes exited successfully. This full run predates the configured-token-reader fix and this terms patch; it is not claimed as a full-suite pass on the latest source. Those changes have their own focused verification.

## Remaining implementation and product gaps

The source audit confirms `reviewWalletWarmupSession` subtracts network fees plus positive net rent from the saved reserve. Receipt and settlement projections retain net rent change; the native signing review also has separately calculated maximum creation rent. Those facts must not be silently recast as verified gross historical debits or as future authorization. The next source verifier must rebuild exact current owner/review/source/wallet/action/asset/lot terms and conservative gross fee/rent bounds from authenticated retained facts, or require a fresh explicitly bounded review. Missing program/decimal/rent evidence is refusal, not a default program or invented fee formula.

Next are that verified source admission, immutable terms/approval/root publication, source freshness and CAS in unchanged full-schema disposable SQL, shared wallet/lot holds, exact outcome writing, then qualified per-action runtime and mounted approval/progress/recovery. No migration is reserved here; the journal still ends 0138 and 0139 must be rechecked before use. The chunk codec remains model-manifest-only and is not root storage.

Fresh REA `list_browser_targets` returned `provider_unavailable / endpoint_unreachable` for the approved loopback endpoint on 9223. No new live capture or backend claim is made, and the previously rejected relay cleanup was untouched. The currently published [Generate Activity guide](https://docs.proxima.tools/wallets/generate-activity/) describes real buy/sell loops, per-wallet transaction count/volume and cancellation; those execution requirements remain part of the broader objective. No live provider qualification, real wallet unlock/sign/send, funded activity, application/hosted SQL, provider/credential/cron change or deployment occurred.
