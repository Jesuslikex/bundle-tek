# Raydium CPMM candidate checks, 30 October 2026

These checks are isolated research code and are not connected to the Jito qualification, UI, signing or sending paths. They retain `sourceAuthenticated`, `programApproved`, `packetVerified`, `economicOutputVerified`, `providerQualified`, `signingAllowed`, and `executionAllowed` as false. No policy, slot, bank, signing or execution guard was changed.

## Implemented

`lib/jito-cpmm-candidate-instruction.ts` checks a supplied instruction candidate against Raydium's published `swap_base_input` form: exact discriminator and 24-byte layout, thirteen ordered accounts, signer and writable constraints, distinct roles, the program-derived pool authority, canonical SPL Token ATAs for the payer and the two mints, and exact positive u64 input and user-supplied minimum output. It refuses Token-2022, temporary non-ATA accounts and unrecognized variants. These are conservative restrictions, not support for every valid CPMM swap. The caller-supplied instruction, metadata and expected amounts are not authenticated or bound to a real packet.

`lib/jito-cpmm-candidate-balances.ts` uses that inspection and compares supplied SPL Token account pre/post images for the source, destination and both vaults. It checks token program ownership, initialized account state, mint and authority, disallows delegates and close authorities, keeps all other token-account bytes unchanged, checks exact input and vault conservation and minimum output, and checks wrapped SOL reserve/lamports consistency. Raw account inputs are bounded and snapshotted before async work. This is not proof the images came from a real simulation, or from the same bank, nor a quote, whole-packet, full economic or provider verification.

## Live program recheck

The existing strict Jito runtime scan against the configured Alchemy holder endpoint, without a wallet or transaction, observed the same 793,824-byte CPMM program and full-code SHA-256 `b6dbea8cefc2e7d490775ce6115e34a2ba480c0853c359e0bb4043b9381ef09a` as the previous observation. Floor 463345597, maximum slot 463345605, nine HTTP reads, no 429. It correctly refused the unlisted program; no policy was added. This is not a before/simulation/after scan and does not qualify a route.

The OtterSec status endpoint again reported `is_verified: false`, `last_verified_at: null`, and no matching executable hash for CPMM. The referenced public source commit has not been proven to produce the deployed binary. This machine has no accessible Docker, Solana CLI or solana-verify command, so no independent deterministic build comparison was completed. Other verification sources may exist, but none was established here. Even a matching reproducible build is not a security audit.

## Remaining before qualification

- Independently verify the deployed program's source and build, then separately review and pin its identity under existing policy.
- Bind instruction review to the exact transaction bytes, account privileges, selected route and approved quote. Verify the actual pool, config, mint, vault and oracle data and freshness, all instructions and all economic/rent/fee effects. Only then can a complete adapter use these isolated checks.
- Obtain synchronized, authenticated same-bank simulation and independent fee evidence. Perform both existing full program scans and the actual full-swap bundle simulation within the original 32-slot window. No run in this change did that.
- Keep signing and execution disabled until the full existing qualification succeeds. No deployed or funded actions were taken.

Sources: https://github.com/raydium-io/raydium-cp-swap/blob/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce/programs/cp-swap/src/instructions/swap_base_input.rs ; https://solana.com/docs/programs/verified-builds ; https://verify.osec.io/status/CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C

## Follow-up audit, 30 October 2026

The candidate inspectors remain imported only by each other and their tests, not by an application API, UI or Jito admission path. Their false authority flags are intentional. A caller can supply internally consistent synthetic instruction/account data, so passing these inspectors alone cannot establish a safe real swap.

Fixed a candidate shape gap: the CPMM executable address is now forbidden in every one of the thirteen data-account roles. Added thirteen regression cases plus exact minimum-output boundary cases (110 accepted, 111 refused against an actual output of 110). This tightens checks without changing any production policy.

Current completion map:

| Layer                                                                        | State                                                      |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Candidate instruction structure, canonical ATAs and amount binding           | Implemented and unit tested; caller inputs unauthenticated |
| Four supplied SPL account balance transitions                                | Implemented and unit tested; provenance unauthenticated    |
| Exact transaction decoding, complete instruction coverage and lookup binding | Missing for this direct-route adapter                      |
| Pool/config/vault/oracle ownership, mint/rent and independent price evidence | Missing for this direct-route adapter                      |
| Deployed Raydium binary matched to a reproducible reviewed source build      | Not established                                            |
| Raydium trusted program policy approval                                      | Absent; existing refusal preserved                         |
| Authenticated same-bank simulation and independent fees                      | Not established                                            |
| Full swap with both runtime scans inside 32 slots                            | Not qualified                                              |

No production/live-site audit, complete product parity, deployment or funded verification is claimed by this source audit. Preserve the three unrelated untracked recovery-password files.

## Exact unsigned packet binding

Added `lib/jito-cpmm-unsigned-packet.ts`: canonical transaction and message decode/re-encode, 1232-byte cap, exactly one unsigned payer, exact fee payer, unique static keys, no unresolved lookup tables, no unused keys, and a single read-only-program CPMM instruction. Account signer/writable roles and data are derived from message bytes, then passed to the existing candidate inspector. Original transaction/message hashes accompany the diagnostic. Signatures, extra instructions, lookup-based routes, setup/wrapping instructions and malformed envelopes are refused. This is a narrow existing-ATA profile, not full real-world route support.

Validation: two candidate test files pass 59 tests including an independently constructed raw-wire packet and signed/header/trailing-byte/amount mutations. Typecheck and scoped lint pass.

`instructionBoundToPacket` is true only after byte binding. `packetVerified`, `accountStateVerified`, `priceVerified`, `economicOutputVerified`, program/source/provider approval and signing/execution remain false. Blockhash lifetime, pool/config/oracle and raw mint/rent/independent price evidence are still missing, as are actual same-bank provenance and the full runtime qualification. No call site enables this module for signing. No new live provider or funded run was made in this step.

## Packet-bound mint and Rent read collector

`lib/jito-cpmm-asset-evidence.ts` derives the two mint addresses from the unsigned packet inspector and reads them with the fixed Rent sysvar through an injected read-only RPC. It uses the existing mint and Rent parsers, allows only the classic SPL Token profile, repeats observations at a monotonic floor, and refuses a changed mint transfer policy or Rent profile. Both observations must fall inside the original 32-slot window. Reads have cancellation, a 30-second collector deadline and bounded JSON snapshots; no retries or fallback provider. The returned rent minimum is for a 165-byte token account, not proof that any actual account is rent-exempt or that creation funding is sufficient.

The collector is unmounted research code, not a runtime admission proof. RPC provenance is supplied by the caller and not independently authenticated. The two reads do not surround an actual swap simulation, and no same-bank claim is made. Pool/config/oracle verification, independent market-price evidence, full mint/account/rent conservation, source-to-binary approval and actual same-bank qualification remain incomplete. The existing false authority fields remain false.

Validation: 65 tests across the three CPMM test files, typecheck and scoped lint passed. After adding the explicit timeout, all six new collector tests passed again. New tests mock the packet inspector and RPC to isolate collector behavior; separate packet tests test real synthetic transaction bytes. No live provider run, deployment or funded action occurred in this step.

## Pool relationship and actual rent coverage observations

The new unmounted `readJitoCpmmPoolEvidence` binds to the same unsigned packet, reuses mint/Rent evidence, then reads the pool and four token accounts with a floor at or above the asset observations and within the original 32-slot window. The conservative 637-byte historical PoolState profile checks owner, discriminator, config/observation addresses, vault/mint direction, mint decimals, token programs, authority bump and swap-disabled bit. Unknown layouts refuse. The actual pool and token-account lamports must cover their decoded-size rent minima. Classic token accounts must match expected mint and wallet/vault authority and have no delegate/close authority; wrapped SOL must carry the exact observed Rent reserve with matching lamports and token amount.

This does not validate config/oracle account contents, pool open-time against Clock, mint account rent, independent prices or simulated post-state rent. It is not proof the referenced source equals the current deployed binary. `poolVerified`, `priceVerified`, same-bank/provider and signing/execution remain false. No application path imports this collector.

Validation: 81 tests across four CPMM files, typecheck and scoped lint pass. Pool tests use mocked packet and asset collectors and synthetic raw accounts; they cover account rent shortfalls, changed pool relationships, disabled swaps and the original slot bound. No live provider run, deployment, signing or funded trade occurred in this step.

## Independent market-value comparison

`readJitoCpmmPriceComparison` reuses the existing server `observeTokenMarket` adapter and packet/mint collectors. It requires explicit external input/output market-pair addresses and refuses either reference if it equals the packet's execution pool. It checks exact Solana mint/source identity, a unique selected pair, positive supported decimal prices and observations no older than five minutes or future-dated. No stablecoin peg is assumed. Integer cross-products normalize the packet input and encoded minimum output using observed mint decimals. A worse minimum exceeding 2 percent requires acknowledgement; missing observations also explicitly require acknowledgement. This diagnostic does not grant that acknowledgement or permission to sign.

This compares the encoded minimum's market value, not an expected executable quote or guaranteed fill. Dexscreener retrieval time does not attest the timestamp of an underlying trade. Market provenance, saved owner approval/revision, selected reference authorization and a fresh executable quote still need the actual server/UI integration. The module is unmounted and `priceVerified`, provider/signing/execution flags remain false. It uses bounded snapshots, a 30-second collector deadline and cancellation, with no retries. It does not alter existing minimum-output rules.

Validation: 93 tests across all five CPMM files pass, plus typecheck and scoped lint. New cases cover the exact 2 percent boundary, better prices, mixed mint decimals, execution-pool exclusion, stale/future/unrelated/source/duplicate/missing observations and redacted provider failures. Tests inject synthetic observations and packet/asset inspectors. No live price, funded trade or full Jito qualification is claimed; no deploy was made.

## Config and oracle structural observations

The pool collector now requests the packet-bound config and observation accounts in the same account response as the pool/vaults. The referenced historical source profile requires a 236-byte AmmConfig and a 4075-byte ObservationState, the correct Anchor discriminators and CPMM owner, and actual rent coverage. Config checks bound trade/protocol/fund fees to the published millionths denominator and reject a protocol-plus-fund share above the denominator. The oracle bool and ring index are bounded and its stored pool ID must match the packet pool. Oracle cumulative prices are not used as an independent price reference. Unknown layouts refuse.

Source references: https://github.com/raydium-io/raydium-cp-swap/blob/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce/programs/cp-swap/src/states/config.rs and https://github.com/raydium-io/raydium-cp-swap/blob/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce/programs/cp-swap/src/states/oracle.rs . Exact source-to-deployed-binary matching, config/oracle PDA derivation, pool open-time/Clock and full runtime admission remain open. No signing, provider or bank authority flag was enabled.

Focused pool tests cover seven new corruption/fee/ring-index cases (23 pool tests total). Typecheck and scoped lint pass. These are synthetic fixtures, with no live RPC, funded transaction or deployment in this step.

## Canonical PDAs and pool opening time

The config index is decoded little-endian from account bytes and encoded big-endian for the published `amm_config` PDA seeds; address and stored bump must both match. The observation PDA uses `observation` plus pool bytes, and vault PDAs use `pool_vault` plus pool and exact mint bytes. PoolState itself is not forced to a PDA: the referenced Raydium initialization explicitly permits a random signed pool account.

The same eight-account pool response now includes the fixed Clock sysvar. Existing `pairClockUnixTimestamp` enforces exact Clock/context slot equality and its unchanged 30-second wall-time bound. Pool open_time must be no later than this Clock, and an initialized oracle's latest ring entry cannot be future-dated against it. This uses ordinary equality, never the stock-only +1 rule. These observations are still not proof that simulation and independent fee reads share a bank, nor a verified source/binary policy.

Sources: https://github.com/raydium-io/raydium-cp-swap/blob/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce/programs/cp-swap/src/instructions/admin/create_config.rs and https://github.com/raydium-io/raydium-cp-swap/blob/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce/programs/cp-swap/src/instructions/initialize.rs .

Validation: 106 tests/five CPMM files, typecheck and scoped lint pass. Fixtures derive actual Solana PDAs and test config index/bump mutations, an internally linked wrong oracle PDA, Clock behind/+1 refusals and a future pool open time. Tests remain synthetic and isolated; no live provider, deploy, signing or funded run occurred. Remaining full qualification includes mint rent, full economic/fee/rent settlement and lifetime integration, authenticated source/build and same-bank provider evidence.

## Actual mint rent coverage

Both asset observations now require positive rent coverage for each decoded classic SPL mint: exact 82-byte account data, canonical u64 lamports, and lamports at least the rent minimum calculated from that observation's Rent sysvar. Per-mint actual and required lamports are retained in each observation. A mint rent shortfall on the final read is refused even if the initial read passed. This does not establish simulation post-state rent or a payer's whole-transaction fee budget.

Validation: 111 tests across six focused CPMM/qualification files, typecheck and scoped lint pass. Added synthetic underfunded-input/output and final-read-shortfall regressions. Existing tests now supply actual mint lamports rather than leaving them absent. Program/source approval, same-bank provider proof, full economic/lifetime integration and live repeatability remain open; no qualification or signing flag changed. No live provider call, deploy or funded action occurred here.
