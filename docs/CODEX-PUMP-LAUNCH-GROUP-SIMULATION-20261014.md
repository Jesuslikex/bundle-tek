# Collected complete-group replay and economics

14 October 2026, based on 1c4b353. Connects the complete trace collector to independent prefix accounting and observed rent, using an explicitly supplied read-only provider. No API or signing permission is added.

## Implemented

The collector clones the complete input, allowance, funding and creation evidence. It enforces the creation observation's finite, unexpired, at-most-sixty-second lifetime and a shared thirty-second cancellation deadline. Funding remains slot-bound through the existing trace gate; the funding report does not contain a wall-clock expiry field.

The existing trace collector performs exactly one ordered bank-selected simulateBundle with the original packets and lifetime. The new collector retains that response for independent revalidation rather than trusting the trace report's flags. It gathers every nonempty non-executable account size appearing in any post-frame snapshot, reads each rent size once, and rejects more than sixteen distinct sizes. Rent comes from the supplied provider, not caller-authored settlement figures. Rent RPC has no contextual slot field; commitment is requested, and account sources are independently rechecked afterward.

The economic verifier checks every prefix, per-packet SOL conservation, cumulative positive wallet debits, fee/rent/custody/reserve/lifecycle state and final complete coverage. Then the complete original source union is read again in chunks of at most 100 addresses. Each attempted snapshot requires one provider-reported bank, with at most three attempts and the existing 32-slot drift bound. All normalized own/configuration/custody identities must match the original funded trace. Only the previously permitted shared fee-account normalization applies.

Final original-blockhash validity, ten-block headroom and mainnet genesis are rechecked after economic verification. Every provider call races cancellation, including a provider that ignores its abort signal. A method allowlist and group-derived read budget prohibit sends, signatures, independent simulation and second replay attempts. Groups above five packets reject before provider requests; no partial execution policy is implied.

Reports identify the manifest, allowance, exact network fees, bank and final source range, observation expiry, read count and single replay count. The collected accounting can clear rpcCollectionRequired. programDeploymentReviewRequired, transportReviewRequired and authorityReviewRequired remain true; signingAllowed, executionAllowed and completeLaunch remain false. This is observed simulation evidence, not signing authority or proof of an actual submitted bundle.

## Verification

- Four selected group collector/accounting/trace/funding files passed 38 tests, including the first seven collector cases.
- Final collector file passed all eight cases. Native SOL, SPL and Token-2022 controlled multi-packet economics pass. Tests assert exact original packet order and one replay, unique rent reads and no send/sign/independent simulation methods.
- Provider rent mismatch rejects; post-accounting source mutation, expiry and network change reject; a stalled rent provider is cancelled. Malformed, expired and excessive observation lifetimes reject before any provider request.
- Actual-source TypeScript, scoped two-file typed lint and production Next.js build passed. Build log is retained in ignored work/group-simulation-build.log.

Fixtures contain independently constructed account bytes and integer reserve/fee math, not BPF execution. No actual provider request was made in this checkpoint. The retained empty-bundle capability result still proves only method acceptance. Full unsigned v1 replay, response/request-size limits, deployment metadata, tip and send transport remain unqualified.

## Next

Collect and bind linked program deployment metadata across the same replay window; qualify real complete unsigned v1 replay on the approved provider. Then build durable owned group preparation/review/reservations, explicit browser-local signing, one-attempt submission and complete/partial/unknown recovery/UI. The existing single-packet flow is unchanged.

No UI/protected Claude file, remote migration/SQL, provider/credential change, cron, push, deployment or real-wallet action occurred. Migration 0081 remains local. Main's two unrelated dirty files remain untouched. Full Proxima parity remains unfinished.
