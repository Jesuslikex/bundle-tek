# Fresh revalidation of immutable group reviews

14 October 2026, based on bd33c30. Adds read-only server revalidation needed before durable group approval. It neither updates the saved review nor changes approval, signature or reservation state.

## Implemented

The service requires the installed group guards, authenticated owner/format, unsigned review state, a live reconstructed complete review and the exact current saved project bytes/revision. Fresh owned preparation receives the original blockhash and last-valid height from the saved review. It recollects creation, funding, deployment metadata, sequential replay and independent economics, with owned binding rechecks and the shared sixty-second cancellation deadline.

The group manifest contains historical configuration observation slots as well as transaction bytes. Fresh preparation therefore has a server-internal originalInput option: it first compares fresh server-derived inputs with the frozen input, ignoring only the three known configuration account observation slots. All account identities, owners, executable flags, raw bytes, names/URI, quote/mint/payer, lifetime, developer/holder targets and caps must match. Only then can it rebuild the original input and preserve the original manifest. Client request terms still reject input/target overrides. Fresh configuration collection and independent source hashes establish current data; historical manifest slots are not relabeled as fresh observations.

Fresh evidence is compared with the saved checked result for owner/revision bindings, metadata identity, complete targets/allowances, manifest, per-packet/network fees, every ordered normalized funding source identity, program deployment hashes and complete prefix accounting. Only the current accounting bank slot is omitted from that economic comparison. Existing shared buyback balance normalization is reused; ordinary wallet balance/custody/configuration source changes do not become acceptable simply because the wallet still covers its cap.

The service re-reads the immutable row after collection and compares state, review, simulation, signatures and receipt against the original row. Cancellation during collection rejects the stale result. It checks cancellation and the original review expiry again after computing the fresh simulation digest. Fresh observation expiry never extends the saved review's expiry.

The result includes fresh checked evidence, its simulation digest, the saved review context digest and original expiry. sourceRevalidated=true records this comparison only. approvalRequired remains true; signingAllowed and executionAllowed remain false. The 0082 stage guard still blocks approval/signing transitions; there is no new API/UI or durable approval event here.

## Verification

- Eight selected group service/preparation/review/simulation/accounting, holder review, paged history and holder route files passed 81 tests with two workers.
- The initial focused service file passed twelve cases. Final regression includes the strengthened source-change case with internally consistent changed before/after simulation balances.
- Fresh configuration observations and producer bank advance from 100 to 200 while the manifest retains its original configuration slot and exact packet bytes. Saved review/simulation/state bytes remain unchanged.
- Changed fresh configuration bytes reject before replay. A wallet gains one lamport and still covers all caps; a consistent fresh replay/economic result is nevertheless rejected against its saved source identity. Cancellation during rent/economic collection rejects the stale refresh without restoring its row.
- Actual-source TypeScript, three-file typed lint, whitespace checks and production Next.js build passed. Ignored build log: work/group-review-revalidation-build.log.

The disposable database and controlled provider fixtures execute the real owned/group/funding/replay/economic code, with only create preflight mocked. This is not live RPC, BPF, funded or transaction submission proof.

## Next

Add immutable durable consent/approval events and atomic owned revision transitions, without bypassing the stage guard. Connect full-group browser-local signatures/registration, qualified one-attempt submission and complete/partial/unknown recovery/UI. Live unsigned v1, code/authority and tip/send transport qualification remain open. More than five packets still has no enabled execution policy.

No migration/remote SQL, API/UI/protected Claude file, actual provider read, credential/provider change, cron, push, deployment or real-wallet action occurred. Migrations 0081/0082 remain local; main's unrelated dirty files remain untouched. Full Proxima parity remains unfinished.
