# Finalized exchange payout verification API

18 October 2026. Local checkpoint; no push or deployment.

The existing immutable exchange payout verifier now has an authenticated POST endpoint at `/api/funding/exchange-payout` and a bounded server-owned Solana JSON-RPC adapter. The request selects only an owned saved review ID and exact digest. The retained finished provider observation supplies the payout signature, recipient and expected amount; callers cannot inject a signature, URL or amount.

The API requires exact same origin, JSON and a streamed 2 KB body limit. Verification uses ordinary configured provider pacing, a separate atomic per-owner fifteen-second gate, bounded lossless responses and cancellation. Allowed RPC methods are genesis, signature status, transaction and finalized slot reads. There are no retries, redirects, order creation, deposits, signing or distribution authority. A stored receipt replays without RPC. Missing provider references, conflicting evidence and failed verification retain the existing order hold. Public responses use the existing saved-order projection.

Verification: pinned Node24, offline environment preload and envDir:false, two Vitest workers. All 11 exchange-related files and 232 tests passed together, including the actual route, adapter, verifier and disposable local SQL guards. Cases cover exact finalized credit/replay, ownership/digest/body injection refusal, first429, isolated rate gate, concurrent requests, missing payout reference, mismatched credit and cancellation with ignored transport. Six changed TypeScript files pass formatting and type-aware lint; whole-project `tsc --noEmit` passed.

Results: `work/release-qa/exchange-payout-api-20261018.json` (ignored local evidence). Fixture setup applies committed migrations only to an in-memory local database, with synthetic provider observations and signed fixture packets. No live provider request or hosted SQL was performed. No new migration or provider setting is required.

The history UI does not yet invoke this endpoint. Live order creation/deposit integration and funded deposit-to-payout proof remain separate work. This scoped pass is not a new full-suite, browser or production-build qualification. User AGENTS edits and the other Bundle chat's account/payment ownership are preserved.
