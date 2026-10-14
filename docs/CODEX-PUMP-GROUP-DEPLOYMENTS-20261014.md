# Launch-group deployment metadata checkpoint

14 October 2026, based on 481fa4c. Complete-group simulation now binds executable identities and linked upgradeable deployment metadata across replay and economic verification. This does not audit program code or enable signing.

## Behavior

After mainnet validation, the collector derives every top-level instruction program, create instruction's referenced program accounts and quote token program from the reconstructed complete group. A bounded confirmed snapshot reads these executables. Each account must match its funded source hash and use the supported loader profile. Upgradeable links require an exact 36-byte Program variant and derive their ProgramData address from the encoded public key. Unsupported loaders fail closed. Native-loader acceptance is restricted to the known System program; ordinary BPF loader v2 remains supported.

Linked ProgramData addresses are deduplicated. The creation baseline must contain unique, well-formed hashes and cannot name an unrelated deployment. Every available creation baseline must match the pre-replay metadata observation. Additional programs introduced by holder instructions have their current metadata observed and checked for stability, rather than being mislabeled as creation-attested.

The collector requests 45-byte metadata slices, validating owner, non-executable role, ProgramData variant, authority option and deployment slot no newer than the selected replay bank. Snapshot context floors and the existing 32-slot drift bound are enforced. Following complete replay, rent collection, independent economic prefixes and final source recheck, the same metadata is collected again and must match byte-for-byte by hash. Original blockhash validity, lifetime and mainnet are checked afterward; expiry/cancellation is checked after report hashes are built.

The report adds programDeploymentMetadataValidated=true, programDeploymentMetadataOnly=true, programCodeAttested=false and collected deployment hashes. programDeploymentReviewRequired, authorityReviewRequired and transportReviewRequired remain true. signingAllowed, executionAllowed and completeLaunch remain false. Metadata identity and stability are not an executable-code audit, trusted RPC proof or submission permission.

Native loader identity reference: https://docs.rs/solana-sdk-ids/latest/src/solana_sdk_ids/lib.rs.html . Native executable-account construction reference: https://docs.rs/crate/solana-sdk/1.14.19/source/src/native_loader.rs . The native-loader exception is deliberately limited to the existing known System program. No general loader-v4 support is claimed.

## Verification

- Five selected group deployment/simulation/accounting/trace/funding files passed 46 tests. The focused updated simulation file previously passed eleven cases.
- Upgradeable metadata binds before and after replay. A changed post-replay authority byte rejects; mismatched creation metadata rejects before replay.
- Independent helper tests cover exact link decoding, the System-only native-loader exception, missing/non-executable/unsupported loader accounts, short headers, wrong ownership, invalid authority options and deployment slots newer than the replay bank.
- Existing controlled native SOL, SPL and Token-2022 group economics, source/rent/lifetime/network/cancellation checks remain passing.
- Actual-source TypeScript, four-file typed lint, whitespace checks and production Next.js build passed. Ignored build log: work/group-deployments-build.log.

All runtime evidence in these tests is controlled account data. No actual provider request, program execution, browser operation, wallet signature or broadcast occurred. Full v1 replay/transport, code/authority qualification and the durable owned group approval/signing/submission/recovery/UI remain required. No UI/protected Claude file, migration/remote SQL, credential/provider change, cron, push or deployment changed. Migration 0081 remains local; main's two unrelated dirty files remain preserved.
