# Holder submission, recovery and authenticated API

14 October 2026. Local continuation from signing checkpoint `947d389`. Production remains source `11ad20b`. No migration, deployment, actual provider broadcast or real wallet operation is included.

## Service lifecycle

`lib/pump-holder-execution.ts` adds separately approved submission. The caller supplies the exact original signing consent **and** `submitApproved=true`. The service verifies the saved complete signatures, repeats full original-packet funding/simulation/ownership refresh and atomically persists `submitting` before its only `sendTransaction` call. It sends the saved packet with preflight enabled, `maxRetries=0` and the checked context slot. A lost response, different returned signature or failed state write leaves recovery in control. Repeating submission from submitting/submitted/terminal states never sends again.

Recovery performs only bounded reads. A successful or failed finalized receipt must contain the exact saved base64 transaction and all strict signatures, a valid slot and error metadata, with mainnet checked again before committing the result. The receipt binds the packet/context hashes and complete selected holder scope. Observed fees are recorded when provided; missing fees remain unresolved.

Expiry cancellation requires a finalized block height strictly greater than the original last-valid height plus the local 32-block safety margin, and mint absence in a finalized bank at or after the expiry observation. The implementation uses the linked `absoluteSlot` and `blockHeight` returned by [Solana getEpochInfo](https://solana.com/docs/rpc/http/getepochinfo), then sends that slot as the mint read's minimum context. Stale/impossible contexts, a present mint, unavailable receipt data or a wrong network keep the reservation. The 32-block margin is our conservative policy. Expired-unobserved records retain the original signature if known and explicitly mark network fees unresolved, rather than assuming no fees were paid.

Initial unsigned cancellation remains a local history transition. Cancellation of approved/signed/pending packets delegates to the same receipt/expiry recovery checks. Recovery can proceed after a project/holder is archived or its proof changes; those changes prevent a new approval/send but must not lose already signed history.

The public holder result reports `completeLaunch=true` only after a matching successful finalized receipt for this complete saved holder packet. It remains false for preparation, approval, signed/pending, failed and expired records. This describes the individual packet, not overall Proxima parity, audited P&L or funded release readiness. `executionAllowed` stays false as a general automatic-execution flag; broadcasts require the separate submit action.

## HTTP contract

`/api/launch/pump/holders` is authenticated, dynamic and no-store. GET accepts `projectId` and returns only owned holder history. POST requires the same origin, JSON and at most 65,536 streamed bytes. It supports:

- `prepare`: saved project/version/release, exact payer/revision/mint, raw deployer fee/rent allowance, optional developer quote cap and one explicit raw-limit entry for every saved holder slot. Identity and origin are injected by the server. No observations, target overrides, review objects or owner fields are accepted.
- `approve`: review `id` plus exact nested consent (approved, reviewId, packet/context hashes, complete-holder scope and simulation-limit acknowledgement).
- `register`: the same consent plus canonical bounded signed transaction bytes.
- `submit`: the same consent plus separate `submitApproved=true`.
- `recover` and `cancel`: owned review `id` only.

`lib/pump-holder-request.ts` validates exact action/field shapes, prime-order public identities, unique ordered slots, canonical u64 strings, per-wallet SOL bounds, mutually exclusive supply-target caps/quote-input minima and all consent fields. Inactive slots need zero allowance and no buy limits. Heavy actions have a five-second gate isolated by authenticated owner, project and action; 429 responses include Retry-After while GET history remains available. Provider/parser failures use bounded plain JSON errors without echoing upstream bodies or private endpoints. The existing 0081 reservation guards remain mandatory before prepare/approve/send; no remote migration was run.

## Verification

163 targeted tests across thirteen files pass on Node 24, including existing launch routes and all holder modules. Actual-source TypeScript, nine-file typed lint and the Next.js production build pass on the final application source; the route manifest includes `/api/launch/pump/holders`. This is not a full-suite, live-provider or funded mainnet pass.

The real local libSQL/controlled-RPC integration fixture reaches metadata release, complete preparation, funding, simulation, durable review, explicit approval, all synthetic signatures, registration, one mocked send and exact successful finalized receipt recovery. Separate service tests cover lost responses, wrong signatures, concurrent submits, revoked ownership at the final write, failed/malformed/mismatched receipts, network changes, the expiry margin, linked slot/mint absence, existing mints and approved-but-unregistered recovery. API tests use real local SQL authorization/rate gates with mocked service boundaries to isolate request validation and routing, including owner/project/action isolation, streaming bounds and sanitized errors.

Before funded/UI readiness, stress the collection/refresh model with changing shared fee-recipient balances. The present fixtures hold those balances stable; inspection suggests benign external credits could invalidate broad source hashes or contaminate before/after deltas when RPC calls observe different banks. This is an outstanding snapshot-coherence investigation, not a demonstrated live-provider pass. Do not weaken per-wallet funding or fee conservation to bypass it.

The launch UI still needs to invoke this contract, unlock the exact browser vaults, display all per-wallet costs/limits and obtain separate signing/broadcast consent. Browser rendering, funded proof and larger multi-packet groups remain outstanding. StonkFun and broader product parity are not completed by this checkpoint. No UI/Claude-owned file, provider/credential, cron, push/deployment, hosted SQL or real signature/submission changed. Main's two unrelated dirty files remain preserved.
