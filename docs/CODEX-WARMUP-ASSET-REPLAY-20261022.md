# Retained warmup asset decoder replay

22 October2026. Source base `3da1e07080e4094b8a3ea058b8400452b142eb08`. This is a recovery/integrity dependency for later complete-root storage, not approval, publication, reservation or execution admission.

## What is checked

The new server-internal `replayWarmupExecutionAssets` strictly parses the existing v1 projection and an independent expected selector. Owner/review/source-snapshot/evidence digests, original provider hostname, exact original expiry and the ordered target mints must match. The selector must come from an admitted owned record or captured internal server result, not be copied from an incoming packet. Source identity, original review window and expiry are preserved. Expected fields and packet data are detached before any await.

Replay checks both exact ordered raw-account vectors, full supported mint decodes and policy equality, exact Rent-profile decoding/equality, and rederived token-account sizes/minimums. It checks original slot floors and the32-slot span, ordinary Clock/context equality, the original30-second Clock wall bound at each recorded `evaluatedServerAt`, and the historical server-time/expiry ordering. Non-Rent balance/space fields are not admitted. A positive Rent balance change remains incidental; mint supply changes remain permitted by the existing policy hash.

The fresh collector now self-replays its actual result before the final original `fresh()` check. Its result format, canonical hash domain and false flags stay unchanged; no extra provider read occurs. There is no new public API or stored-record reader caller yet. Existing stock/group/general decoders and defaults are untouched.

Two additional warmup-only conservative consistency refusals reject a decreasing chain timestamp and unequal full Clock bytes at the same context slot. These are not proof that observations came from one bank or fork. The existing equality,30-second,32-slot and25-second checks are not relaxed. Codex checked the ordinary [Agave bank Clock update](https://github.com/anza-xyz/agave/blob/master/runtime/src/bank.rs#L2465), which clamps its timestamp estimate to its ancestor in that path. That source check does not establish deployed-validator/fork behavior; ambiguous observations safely require another review.

## What is deliberately not claimed

Historical replay never calls `Date.now`, a provider or a database, and never extends an expiry. It returns `currentSourceVerified:false`, `networkObservationReverified:false` and all authority flags false. A past timestamp can be decoded after expiry as history; it cannot authorize fresh work. Ownership, durable publication, provenance and current source/chain state remain the caller's separate obligations.

The v1 projection does not retain a raw RPC/genesis envelope or the exact collector-start time. The25-second comparison against the first observation is a necessary upper bound, not independent proof of the original whole collection duration. The original expiry and digest must be anchored by the owned admitted record; fresh collection still requires the original configured-endpoint/genesis/source checks. The original retained source review timestamp is known and checked and must not be confused with the missing collector-start timestamp. Hash equality alone is never human consent, funding or provider truth.

## Verification and Opus review

Final frozen integration passes294tests across8files, zero failures/skips; all2377source/test/config hashes remain unchanged. Eight native probe/snapshot harness tests pass separately. Plain TypeScript, three-file typed lint and formatting pass. Final owned source is byte-identical to the final Opus copy. The sibling JSON retains the scope and exact hashes. This is targeted integration, not a fresh full-suite or browser/funded proof. It includes all69replay cases and56collector cases. Cases deliberately recalculate synthetic expected digests to test semantic decoding in addition to checksum rejection; real clients cannot replace the admitted selector that way. Coverage includes max10supported16384-byte metadata mints/13accounts, identity/membership/strict unknown fields, raw/claimed mismatches, exact Clock offsets,32/33slots from original floor, inclusive±30seconds versus31seconds, expiry/chronology, same-slot positive/negative controls, decreasing timestamp, incidental Rent balance and mint-supply allowances, detached input/output and cancellation before/after hashing. Fixtures use controlled time and synthetic data, not real wallets/providers.

Two actual `claude-opus-5-5` source-only reviews used14/16 unchanged copies with zero permission denials. Initial review found no blocker and suggested the cross-Clock consistency checks. Final review confirmed no blocking defect and the producer/replay alignment. Neither ran tests or SQL. Missing transitive fixtures and application modules limit the review; Codex independently verifies those paths. Reviewer's final reference to an unretained source-start time is interpreted precisely as the collector start, not the retained review timestamp. Optional epoch-order checks and exact60-second-only replay windows were not added; existing storage still requires exactly60seconds, while replay can preserve an independently captured shorter window.

Reports and original reviews live under `work/release-qa/warmup-assets-replay-*20261022*` and `opus-warmup-assets-replay[-final]-20261022/`. The previous live public asset probe predates this integration; no fresh live-provider qualification is claimed for the new self-replay.

## Remaining work and boundaries

Complete-root/budget/source strict reconstruction, chunk storage with immutable complete-piece binding, atomic ownership/currentness/expiry admission, original-ID recovery and legacy isolation remain unfinished. So do shared wallet/lot holds, complete fee/setup/custody/runtime qualification, exact user approval, short authorization, browser signing and one-send receipt recovery. No root or approval storage, API/UI, migration or number reservation is introduced. Next0139 remains subject to recheck.

No protected Claude UI, shared Clock/mint/Rent rules, provider/credential/cron settings, application/hosted SQL, real wallet unlock/sign/send, funded test or deployment changes. Full Generate Activity and Proxima parity remain open.
