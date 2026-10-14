# Complete owned Pump holder simulation

14 October 2026. Local continuation after funding checkpoint `a87cfe8`. Production remains source `11ad20b`. No new migration or hosted change is included.

## Implemented

`preflightOwnedPumpHolderSimulation` connects owned release/project/deployer/holder preparation, complete funding observation, one unsigned simulation of the complete holder packet and independent settlement accounting. It repeats all owned selection and deployer bindings after simulation, so losing a holder proof while RPC work is in flight invalidates the result. The complete operation has a 60-second deadline. It is a server service, not yet a route, durable approval or UI action.

`lib/pump-holder-simulation.ts` reconstructs the exact version-1 packet and binds it to the preceding full funding packet/allowance/account hashes. It observes the full message fee and all compiled account snapshots, validates executable loader links, snapshots upgradeable deployment metadata, requests `simulateTransaction` with signature verification and blockhash replacement disabled, and checks result/account mapping, fee and resource limits. It collects rent minima by account size and passes complete before/after accounts into the independent verifier. It rechecks original sources, program metadata, mainnet genesis and original lifetime before returning. The simulation collector has a 30-second deadline and allows at most 32 calls across seven named read/simulation methods. It contains no send/sign/bundle RPC operation.

`lib/pump-holder-settlement.ts` verifies complete per-wallet accounting:

- Exact compiled account ordering, unchanged readonly/executable accounts, creation source hashes, actual configuration bytes and unchanged validated mint metadata/supply/authority.
- Every active holder's exact-output amount or exact-quote SDK target/minimum, with initialized destination token custody under the correct owner/program. Inactive slots remain in the saved plan without synthetic buys.
- Rent charged to the pinned setup payer: creation accounts to the deployer; each buyer's base ATA and volume account to that buyer; shared stock buyback ATA to the first buyer that creates it. Existing account rent increases and every new rent account must fit observed minima and per-wallet allowances.
- Each native-wallet debit decomposed into its quote spending, attributed rent and, for the deployer, network fee. Stock source ATA identity/authority/extension bytes are unchanged except for the exact token debit, while SOL debit covers only its attributed fee/rent.
- Sequential fee tier selection and exact-output pricing. For quote-input buys, actual principal is recovered from the observed debit plus independently rounded fees, not copied from a projected reserve update. Observed output must match both the SDK quote target and the curve formula for that observed principal. Unrecognized rounding/settlement fails closed.
- Per-buyer volume ownership and unchanged unrelated rewards/claims; final curve reserve and fee totals, creator/default configuration, token supply conservation and complete packet SOL conservation. Completed/migrated curves are rejected.
- Retained protocol fees plus observed buyback credits must reconcile. Undocumented buyback split rounding remains explicitly unattested, consistent with the existing developer-buy verifier.

The pure accounting verifier reports that RPC collection is still required when used alone. The collector clears that nested flag only after its independent source/freshness/deployment checks complete. `settlementValidated=true` describes validated simulated accounting, not a mined transaction or approval. Signing/execution/completeLaunch remain false.

## Verification and limits

72 targeted tests in seven files pass on Node 24, covering holder funding, owned selection/preparation, unsigned assembly, pricing, independent developer-buy simulation, new whole-packet settlement and the new collector. Actual-source TypeScript, seven-file typed lint and the Next.js production build pass on the final application source. This is not a new full-suite pass or live-provider proof.

Controlled full-codec/account fixtures cover native SOL, SPL stock quotes and Token-2022 stock quotes; developer plus holders, holder-only and mixed exact-output/exact-quote plans. Negative cases cover account mapping, missing final holders, output/authority changes, excess spending, unexplained SOL movements, rent limits, migration/reserve/fee tampering, changed readonly/mint state, errors/resource overflow/replacement lifetime, stale funding/fee/context/blockhash, and upgradeable deployment metadata changes before/during simulation. Two real local libSQL cases run the full owned service and revoke a holder proof after simulation to verify the final ownership guard. The positive path retains explicit inactive slots and leaves signing disabled.

No live provider or funded launch was used for these tests. The quote-input principal/fee policy and rent attribution are checked against pinned client/instruction layouts and controlled observations; successful funded program behavior is still unproven. Upgradeable checks attest deployment metadata, not full program bytecode. Durable holder reservations/review refresh, API/UI, explicit all-wallet browser signing, separate submit/recovery, large-group multi-packet handling and funded proof remain required. No claim of full Proxima parity is made.

No Claude UI file, existing migration, provider/credential setting, remote SQL, cron, real wallet signature/submission, push or deployment changed. Main's two unrelated dirty files are preserved.
