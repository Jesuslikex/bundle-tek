# Shared Pump launch receipt and expiry recovery

14 October 2026. Local continuation from `0426ccc`. Production remains `11ad20b`; migration 0081 is local only.

## Change

`lib/pump-launch-recovery.ts` now supplies the read-only recovery evidence for both complete-holder and developer-only launches. Durable services still validate their own immutable reviews and bind their packet/context/scope to the result. No recovery action signs, broadcasts or resends.

Known signatures are verified against the saved canonical packet before provider reads. A finalized receipt must contain that exact signed base64 packet and encoding, explicit error metadata and a canonical safe slot at or after the saved source floor. Its signatures are verified again. A successful receipt records success; a matching finalized failure records failure. Optional fee metadata is validated and recorded, while a missing fee remains explicitly unresolved. Mainnet is checked before reads and again before any recovered outcome is committed.

When no finalized receipt is available, `getEpochInfo` supplies linked finalized block height and absolute slot. Height must be strictly greater than the original last-valid height plus the existing local 32-block margin. A separate finalized mint read must be at or after that expiry slot, within the existing 32-slot observation-drift bound, and return explicit absence. Stale/missing/impossible observations, a present mint or changed final network cannot release a reservation. Expired-unobserved receipts retain any known signature and mark fees unresolved; absence does not prove that a failed transaction paid no fee.

This follows the documented [getEpochInfo](https://solana.com/docs/rpc/http/getepochinfo) commitment/minimum-slot and linked counters, and [getTransaction](https://solana.com/docs/rpc/http/gettransaction) finalized response contract. The 32-block safety margin is our policy, not an RPC guarantee. Recovery still depends on a correctly operating trusted provider; it is not a cryptographic inclusion proof.

The common observer permits only four read methods, at most six reads and a 20-second deadline. Cancellation/deadline rejection works even if an injected provider ignores its abort signal. Provider rejection text is not reflected in the resulting read error. No further method is called after cancellation.

Developer recovery now validates expired immutable unsigned reviews without authorizing new signing. Approved but unregistered packets can resolve only through the same linked expiry/mint proof. Initial review cancellation remains a local transition, and recover-only requests on an initial review leave it unchanged. Terminal recovery is idempotent. All developer state transitions now compare the original state, review bytes, signed packet and signature atomically, preventing a stale action from overwriting concurrent history.

The holder path delegates its existing equivalent evidence checks to the shared observer and preserves its immutable context hashes, complete-holder scope, guarded writes and receipt-based individual completion flag.

## Verification

The final frozen-source cohort passed 248 tests across nineteen launch/holder files on Node 24, with no failures or skips. It includes the independent simulation/packet/signing paths, holder funding/settlement/review/execution/API tests, developer saved-history/API integration, the new common recovery observer and existing launch-review component tests. Actual-source TypeScript, seven-file typed lint and the Next.js production build pass. This is targeted validation, not the repository-wide suite, rendered browser QA or funded proof.

New direct observer tests cover matching success/failure, unresolved fees, the strict expiry boundary, mint presence, linked slots, malformed receipt/mint/epoch data, missing signatures, final network changes, abort-ignoring providers and deadline handling. Local D1/API tests use the real preparation, signature verifier, immutable history and guarded state updates with controlled RPC. They exercise expired approved/signed recovery, unresolved reservation retention, malformed receipts, finalized failure fees, final-network changes, concurrent recovery and unsigned cancellation. Synthetic keys and mocked provider responses are used; no real wallet or provider send occurs.

## Remaining scope

The holder UI still needs complete per-wallet costs, unlocking of the exact browser vault sessions, explicit signing and separate broadcast controls, then rendered checks. Live-provider/funded proof, large multi-packet holder groups, StonkFun and broader Proxima parity remain open. The developer lifecycle still represents create plus developer buy, not holder completion. No new claim of funded or production readiness is made.

No UI/Claude-owned file, migration/hosted SQL, provider/credential, cron, push/deployment or real-wallet signing/broadcast changed. Main's two unrelated dirty files remain preserved.
