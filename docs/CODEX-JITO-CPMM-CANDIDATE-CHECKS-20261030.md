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
