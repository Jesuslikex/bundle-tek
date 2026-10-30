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
