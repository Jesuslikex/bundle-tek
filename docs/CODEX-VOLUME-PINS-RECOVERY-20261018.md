# Volume production program review and durable settlement recovery

18 October 2026. Continues `dbf73f1`. Scope: local source changes, public program reads, injected receipt recovery, disposable database validation and a local Git checkpoint. Execution stays disabled. No real wallet signatures, funding, transaction submission, provider configuration, remote migration, push or deployment.

## Production pin decision

`scripts/review-volume-programs.mjs --live-readonly` reads only the public Solana mainnet RPC's genesis and finalized program accounts, then the public Pump IDL. It does not load environment files or provider credentials. Two complete account/code passes include padding, loader, ProgramData link, deployment slot and upgrade authority. Matching observations never become an approved policy.

The final-source scan at 03:50:05 UTC covered slots **458291308..458291319**, an 11-slot span. All four identities matched between passes. Sanitized public evidence is retained in [the observation](CODEX-VOLUME-PROGRAM-OBSERVATION-20261018.json). Matching earlier observations are not treated as independent source audits.

| Program              | Complete code/marker SHA256                                        |    Bytes | Deployment slot |
| -------------------- | ------------------------------------------------------------------ | -------: | --------------: |
| Pump                 | `a8bc61552f2854e327189f623ae63e8855c3b673f9587993448f5fd167182cf1` | 10485715 |       456494698 |
| Pump Fee             | `4f2955d0f6b40cc9ff7daa18ccad7d19119ba1249759f4e7e3bb691beee6b35e` |   948944 |       456132171 |
| SPL Token            | `8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697` |   108600 |       419472000 |
| Native System marker | `c94b792a6d8b25d3e53ea94d8b80111735ed80d6a7dc8deb937cd342707f5f03` |       21 |             N/A |

Pump and Fee both report upgrade authority `7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8`. Authority ownership/control has not been independently established. SPL Token's authority is null; its hash and the System marker match the already reviewed stock-program constants. A native marker hash is not a hash of validator-native executable code.

The [current official Pump IDL](https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json) hashes to `7616681ea557975f9f623ac211080f22a93060781eaf4765b0a488d980997207`, differing from the full October 12 capture. The selected native buy/sell discriminators, ordered account names and argument schemas match our captured route schema exactly. This comparison does not establish binary/source equivalence or semantic safety.

**Decision: retain `VOLUME_PROGRAM_POLICY = null`.** The Pump/Fee hashes above are observed candidates, not approved production pins. A reproducible build/source audit, independently established authority policy and transport/runtime qualification remain necessary. No default reservation can succeed while the policy is absent. Malformed ProgramData/authority public keys and zero deployment slots now reject even when the supplied policy hash is recomputed.

The scanner is a review tool, not the runtime collector: it uses full finalized accounts per call and has the existing multi-read/non-atomic-bank limitation. Matching two observations and an 11-slot span do not establish production runtime qualification.

## Receipt verification

`verifyVolumePumpSettlement` reconstructs the native Pump route and exact canonical signed v0 packet, verifies its wallet signature, checks complete integer SOL balance vectors and token metadata, native conservation, readonly accounts, fee/tip/loss bounds and unchanged wallet/curve token inventory. It shares the strict native Pump CPI reviewer with unsigned simulation: exactly one matching token transfer per leg, supported program IDs, exact source/destination/authority/amount, no route access to the tip recipient and native buy transfers only to the admitted curve/fee/creator accounts.

Successful Pump sells move SOL directly from program-owned accounts. Their proceeds are independently inferred from finalized wallet delta plus measured buy spending, fee and isolated tip. Only the admitted wallet/curve/fee/creator/tip balances may move. The generic transfer-based receipt verifier keeps its separate policy and continues rejecting this direct-lamport receipt shape.

Finalized failures require a recognized error, an in-range instruction index where present, the exact original signed packet, complete unchanged token inventories/custody and **all SOL balances unchanged except the payer's exact capped network fee**. Incoming token inventory present before the failed transaction may remain unchanged. Partial execution traces cannot establish success. Verified failure records zero volume and zero tip. Unknown, missing, unsafe, inconsistent, wrong-network or incomplete rollback evidence retains the entire hold.

This follows Solana's [atomic transaction semantics](https://solana.com/docs/core/transactions) and [finalized getTransaction contract](https://solana.com/docs/rpc/http/gettransaction). Finality and metadata authenticity remain properties of the explicitly injected trusted transport. There is no cryptographic bank/finality proof or historical program-code attestation.

## Durable recovery and SQL

New server-internal `volume-bundle-recovery.ts` has no API, UI, configured provider, signer, broadcaster, cron or retry loop. `bindVolumeRecoveryPacket` accepts only an already signed packet matching the owned durable attempt; it creates no signature. One immutable packet/signature can bind each attempt, with a global unique signature guard. Tests use the documented synthetic seed only.

Each recovery invocation checks mainnet, performs one `getTransaction` lookup with `commitment: finalized`, base64 encoding and version 0, then rechecks mainnet. The three RPC reads share a 15-second deadline, including when injected RPC ignores cancellation. The receipt is bounded before interpretation/storage. The finalized packet must match the saved packet exactly and its slot cannot predate the original runtime simulation. A missing receipt returns unresolved without releasing anything. Historical recovery works after project/wallet archival or revision changes because it uses the immutable original context; it cannot authorize another transaction.

Migration **0107** adds immutable, retained packet bindings and settlement records. Only a verified, bound success or fee-only failure proof can trigger `attempted -> settled`. Proof insertion, actual tip accounting, wallet release and the retained state event occur in one SQL statement/trigger transaction. `settled` means the attempt has a verified terminal receipt; `proof.outcome` distinguishes `succeeded` from `failed`. Both permanently close that round, with no automatic replay or resubmission. Existing uncertain attempts remain locked, including after expiry.

Session tip budgeting atomically includes full caps for unresolved holds plus actual tips for settled attempts. A failed rollback spends zero tip; network fees and net loss remain in its immutable proof. The budget reader takes held and spent amounts in one SQL snapshot. Existing reciprocal wallet guards, cancellation rules and immutable original identities stay in force. Old migrations are unchanged; 0107 replaces only Volume's transition trigger/index to add the guarded terminal state and prevents settled-round reuse.

## Validation and remaining gates

- Final **18-file / 291-test** Vitest selection passed in 32.67 seconds. Covers all Volume plan/budget/construction/receipt/route/simulation/program/reservation/recovery tests, scheduled Volume plan/batch/service and USD-target tests, existing API/panel guards, full code collector/Rent tests, plus the complete SQLite/Miniflare D1 migration chain. It includes 23 new recovery cases and three malformed-policy identity cases. This is a scoped regression selection, not the entire repository suite.
- Durable recovery cases use actual local libSQL through the production database adapter and complete 0105/0107 SQL with narrow parent-table doubles. They cover success and exact fee-only failure; direct-lamport Pump accounting; concurrent/idempotent recovery; owner/attempt/packet isolation; archive/revision recovery; immutable retained records; exact spent-tip accounting; wallet release and permanent round closure; wrong-network, missing/failed/changed/unsafe receipts; cancellation with uncooperative IO; and a direct SQL regression for a missing error field that must not turn SQL NULL into permission.
- Final plain TypeScript, 12-file typed lint and 15-file format check passed. No UI or authenticated browser behavior changed or was claimed.
- Whole-file Wrangler **4.127.1** applied and verified **108/108** migrations in a disposable local database. Inspected receipt: `C:/Users/Julian/AppData/Local/Temp/bundle-wrangler-migrations-wGZ4U8/report.json`. 0107 source SHA256: `a240f25c57ec4a9c156980d8429eaa4f2fb52c95a20a914404a20b776c7232e8`. The other chat independently reports a successful disposable local Turso chain with 108 migrations and 605 schema objects; no hosted SQL was applied.
- Coordinated `next build --webpack` **passed, exit 0**, after both source sets froze. Inspected the other chat's actual command output: compile 23.1 seconds, Next TypeScript 14.7 seconds, static generation and route tracing completed; total command duration 68.691 seconds. The guarded HTTPS app was restored with PID 30888 listening on 3443/3188. The other chat verified sign-in HTTP 200 and protected warmup submission HTTP 403 before forwarding. These are health/guard checks, not authenticated browser or live-chain acceptance.
- Local Git ordering preserves the other chat's exchange payout checkpoint `0c251da` and its 0106 journal append first. This Volume checkpoint stages only its owned source, reviewed public observation, notes and 0107 journal append. Runtime/generated artifacts, credentials and the other chat's files are excluded. A fresh read-only sign-in health request also returned HTTP 200 after restoration.

Receipt tests are synthetic and do not constitute a funded mainnet acceptance test. Production pins, semantic/source/authority review, live transport/runtime qualification and any future individually reviewed transaction approval remain separate gates. Execution and signing stay false throughout every returned contract. Unknown receipts and finalized errors that fail the strict rollback policy remain held for further review; no timeout or automatic resend path exists.
