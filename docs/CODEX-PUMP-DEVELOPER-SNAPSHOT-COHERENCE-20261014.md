# Developer-buy snapshot coherence and durable refresh

14 October 2026. Local continuation from `89595e8`. Production remains `11ad20b`. No migration or hosted change is included.

## Behavior

Developer-only creation/buy simulation now applies the same shared fee identity policy as the complete holder flow. `pump-buyback-source.ts` contains the common validator; `pump-holder-source.ts` remains a packet-derived adapter. Callers supply only accounts derived from their reconstructed unsigned packet. Native recipient identity excludes only its SOL balance after validating an existing empty System account. Stock recipient identity excludes only its token amount after validating custody, initialization and supported extensions; its existence, SOL/rent, owner, mint, delegates, close authority and all other bytes remain fixed. Our wallet balances and all other source accounts retain raw hashes.

The developer collector reloads all source accounts immediately before each complete unsigned simulation. It requires the source read and simulation to report the same confirmed context slot. A newer simulation slot discards that entire result and retries with a new complete source read, at most three times. Only shared balances may differ from the original checked source; changing our payer, quote custody, source configuration or deployment stops the check. Matching source accounts become the before-state used by the existing independent fee, quote, curve, rent and total-SOL accounting. Later stable reads use the same identity policy. No cross-bank recipient delta is counted as this launch's fee.

The original 45-second deadline, 48-read budget, total slot-drift limit, unsigned packet, original blockhash and independent creation simulation remain. Reports retain full raw pre/post hashes alongside identity hashes, paired source slot and attempt count. RPC reads/simulation do not approve, sign or broadcast.

Durable refresh reconstructs the saved original packet to derive its recipient and volume addresses. Only that shared recipient uses normalized identities; our payer/quote balances remain fully bound. A validated simulated volume timestamp can advance, while the source volume bytes and explicit volume gain remain bound. Refresh now also explicitly compares the network fee, observed buyback/retained-protocol/creator fee split and rent allocation, alongside the existing price, costs, debits and program metadata. The existing settlement validator still checks volume ownership, claim/reward invariants and timestamp bounds before returning evidence.

Older reviews without the new identity or volume-gain evidence may fail refresh and require normal cancellation/recovery followed by a new review. They are not rewritten or silently upgraded.

## Verification

The focused simulation and actual saved-review/API cohort passed 50 tests across two files on Node 24. Controlled tests cover native, SPL Token and Token-2022 recipient credits, matching-slot rollover/retry, three-attempt exhaustion, cancellation, our wallet changes, recipient authority changes, inconsistent within-bank credits and exact cost/fee/rent preservation. The real local D1 review route persists and refreshes each quote variant after external recipient credits and a valid volume timestamp advance, then rejects a changed but individually valid volume gain. No preflight implementation was mocked for that integration.

The final broader cohort passed 227 tests across eighteen launch/holder files on Node 24, with no failures/skips. It includes the existing launch routes, independent creation simulator, developer packet/preparation/signing tests, complete holder funding/simulation/settlement/review/execution/API tests and the existing launch-review component tests. Actual-source TypeScript, seven-file typed lint and the Next.js production build pass. This is not the repository-wide suite or rendered browser QA.

## Limits and next work

The matching-slot policy and correct-RPC assumptions are documented in `CODEX-PUMP-HOLDER-SNAPSHOT-COHERENCE-20261014.md`, with primary Solana/Agave references. Matching reported confirmed slots is not a cryptographic bank proof, and confirmed state can reorganize. Slow providers may exhaust the retry limit. Live provider latency/bank rollovers, real wallet approval and funded execution remain unverified.

This checkpoint changes simulation and review refresh only. The developer-only recovery implementation still needs the linked finalized height/slot/mint-absence and final network recheck audit already implemented for holders before funded release. Holder UI integration/rendering, large multi-packet groups, StonkFun execution and broader Proxima parity also remain outstanding.

No UI or Claude-owned file, migration/hosted SQL, provider/credential, cron, push/deployment, real signature or transaction broadcast changed. Main's two unrelated dirty files remain preserved. Migration 0081 remains local only.
