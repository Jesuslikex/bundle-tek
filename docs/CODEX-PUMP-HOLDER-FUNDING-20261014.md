# Owned Pump holder funding checkpoint

14 October 2026. Local continuation of the complete Pump launch flow. Production remains source `11ad20b`; this checkpoint is not deployed.

## Behavior

`lib/pump-holder-funding.ts` reconstructs the complete unsigned version-1 packet and observes funding for the deployer and every active holder. It retains inactive slots explicitly. Funding requires each active wallet to be a system-owned SOL account with the full reviewed fee/rent allowance, plus its entire reviewed quote cap when buying with SOL. For stock pairs it independently validates the exact quote ATA mint, owner, token program, initialization, authorities, allowed extensions and full token cap, while still requiring SOL for fees/rent. Exact-quote holder caps come from the saved budget in the packet, not from a projected token output.

The network fee is requested for the complete message, including every signature, and must fit the deployer's allowance. Account snapshots must map every compiled account exactly, match the preceding create simulation's source hashes and remain identical across two reads. Context slots are bounded and monotonic. Mainnet genesis is checked at both ends, and the original blockhash must remain valid with a ten-block margin. The collector permits only five named read methods, at most eight calls, and a 20-second deadline. It never calls simulation, signing or submission methods.

`preflightOwnedPumpHolderFunding` in `lib/pump-holder-preparation.ts` connects this collector to the existing owned project/release/deployer/holder preparation. It retains the internal create context through a server callback, reconstructs the same packet, checks its packet and allowance hashes, and revalidates all holder selection and deployer bindings after collection. The overall owned operation has a 45-second deadline. It is a server service, not an HTTP route or UI action yet.

## Meaning of the result

`fundingValidated=true` means the observed accounts can cover their full reviewed spending and fee/rent allowances at the checked slots. It does not prove that actual rent will fit those allowances, a quote cap will cover the changing curve price, or all buys will settle. `allWalletSimulation` remains null; `settlementValidated=false`, `simulationRequired=true`, `signingAllowed=false`, `executionAllowed=false`, and `completeLaunch=false` remain explicit. No public signing gate is relaxed.

The next required work is independent whole-packet and sequential settlement simulation: actual holder outputs and debits, curve state and migration rejection, retained and paid fees, rent attribution and SOL/token conservation. SDK pricing projections are not settlement proof. Durable reservations, approval, browser signing and API/UI integration for holders remain unfinished. Groups exceeding packet/account limits still fail without dropping any selected wallet; a complete multi-packet strategy is outstanding.

## Verification

- 51 targeted tests in five files pass on Node 24: holder funding, targets/owned selection/preparation, packet assembly, pricing and independent initial-buy simulation.
- Funding fixtures cover SOL, stock SPL Token and stock Token-2022; exact-output, exact-input and inactive slots; insufficient SOL/quote balances; non-system SOL accounts; delegated/frozen/wrong-owner quote custody; existing destination accounts; stale creation/account snapshots; cancellation; wrong network/fees/context/lifetime.
- Real local libSQL tests exercise the owned preparation and funding collector together, compare packet/allowance hashes, confirm every signature remains null, and revoke a holder ownership proof during collection to prove the final ownership recheck rejects it.
- Actual-source TypeScript, scoped typed lint and the Next.js production build pass on the final application source. This is a targeted regression run, not a new full-suite pass.
- No remote SQL, migration, provider configuration, credential change, UI edit, browser signing, funded action, push or deployment occurred. Main's two unrelated dirty files remain excluded.
