# Same-block unsigned construction and receipt accounting

18 October 2026. Continues local checkpoint `1905c27`. User authorized unsigned construction and settlement verification while keeping execution disabled, with no funding, transactions or deployment.

## Changes

`lib/volume-bundle-construction.ts` constructs one canonical unsigned Solana v0 packet with ordered buy instructions, sell instructions and an isolated final native tip transfer. It reconstructs the existing bundle plan and binds project/session identities and revisions, selected round and wallet, mint/token account, exact token target, minimum native sell proceeds, maximum loss, network fee cap, tip and original blockhash/lifetime. Byte-level packet and complete review hashes are retained. Extra signers, role changes, unsupported top-level setup/transfer/compute instructions, route access to the tip recipient and packets over 1,232 bytes refuse. There is no split fallback, network read, signing method or submission path.

The contract explicitly requires an **ExactOut buy followed by an ExactIn sell for the same token amount**. The existing scheduled provider's settled-balance sell is not reused. Supplied route instructions are bound as candidate bytes, not admitted as safe swaps: `instructionsVerified`, `signingAllowed` and `executionAllowed` remain false, and `simulationRequired` remains true. The nominal fixed buy in the plan is the candidate's maximum native buy debit, not a guaranteed filled input.

`lib/volume-bundle-settlement.ts` consumes a caller-collected finalized base64 getTransaction result. It verifies the wallet signature and exact original message, unchanged ordered packet, successful finalized envelope, complete safe-integer balance vectors, native conservation after fees, readonly balance immutability, exact isolated tip credit, and fee cap. Raw inner instructions are attributed to the constructed buy/sell instruction ranges. Exactly one token credit and one debit must match the full token target; native buy spending, sell proceeds, net movement and loss must reconcile exactly. Mint/decimal/authority changes, missing/duplicate/wrong-leg evidence, extra inventory use and unexplained native changes refuse.

Supported accounting deliberately requires an **existing empty standard SPL token account** with unchanged rent and zero final inventory. No account creation, closing, Token-2022 wallet effects, address lookup tables or WSOL wrapping/cleanup accounting are admitted by this verifier. An otherwise legitimate route outside this subset fails closed and needs its own policy.

## What this does not establish

- One packet makes the candidate indivisible; it does not establish that arbitrary supplied route bytes implement the declared swap terms, execute successfully, or land. The route examples in tests use synthetic program instructions and are not executable market routes.
- The caller's finalized RPC envelope is an input trust boundary. An offline function cannot authenticate the RPC origin or prove consensus from caller-provided metadata. Live collection must independently enforce trusted network identity, finality and packet/signature matching.
- Finalized accounting does not prove full account data/custody/authority safety, program deployment identity, simulation success, quote freshness or blockhash lifetime before submission. Those gates remain mandatory.
- No API/UI imports the constructor or verifier; only tests consume them. The visible mode remains planning-only. The accounting result retains `routeAndCustodyAdmissionRequired` and `durableTransitionRequired`, with signing/execution false.
- No ledger mutation or automatic reservation release occurs. Unknown, failed, partial or missing evidence yields no accounting result and must leave submitted tip holds intact. Future durable settlement must bind owner/session/revision, exact construction/signature and attempt identity before an atomic transition. Never apply client-supplied accounting as authority.

## Validation and boundaries

- Final Vitest selection: **8 files, 104 tests passed**. New construction/settlement tests plus existing bundle plan/budget, scheduled plan/batch, Volume API route and panel regression tests. New checks cover deterministic canonical assembly, context/lifetime binding, packet size, extra signers, altered messages/signatures, exact buy/sell/tip/fee accounting, safe integers, conservation, readonly balances, minimum proceeds, maximum loss, missing/duplicate/misattributed inner evidence and preservation of existing inventory.
- Plain TypeScript and five-file typed lint passed. Final five-file format check passed. Coordinated webpack production build passed (exit 0), including Next TypeScript and route generation: ignored log `work/release-qa/volume-bundle-construction-build-20261018.log`. The build included the other chat's frozen exchange checkpoint; its files are not part of this commit. Guarded HTTPS restarted afterward.
- Post-build standalone TypeScript passed and the restarted local sign-in page returned HTTP 200. This is a local health check, not an authenticated flow or live-chain test.
- `test/volume-bundle-fixture.ts` uses deterministic synthetic keys solely to create local signed receipt fixtures. No user keys, vault, cookies, credentials, provider reads, live simulation, real signatures or transaction sends. No new browser check is claimed because this checkpoint changes no UI or runtime call path.
- Shared build is coordinated with the other chat's frozen exchange work. Its API/UI/tests and project notes remain excluded from this checkpoint. No schema, migration, environment, provider, cron, remote SQL, push or deployment changes.

Next: admit a concrete supported route's instruction semantics and fresh account/program evidence, simulate the complete original unsigned packet, then bind durable reservations and verified settlement transitions. Keep execution disabled until those are complete and separately authorized.
