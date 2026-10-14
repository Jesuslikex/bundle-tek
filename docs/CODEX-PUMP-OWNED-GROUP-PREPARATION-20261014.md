# Owned complete-group preparation

14 October 2026, based on 084a135. Connects complete-group assembly, funding and sequential economic simulation to the existing saved-project and owned-wallet selection logic. This is server-internal preparation, not a persisted review or an enabled API/signing flow.

## Implemented

The existing holder preparation's shared context now derives immutable creation input, developer/holder targets and canonical limits independently of packet count. It retains the authenticated owner's saved project/revision, metadata release, deployer proof/revision/folder, every ordered holder proof/role/revision/folder and distribution/denomination validation. Unexpected target overrides and per-wallet fields reject. Zero slots require zero fee/rent allowance and no buy limits. The existing create preflight still obtains configuration, quote and metadata evidence.

The single-packet wrapper still uses the original holder-message builder and public packet report format. After building it now rechecks the complete owned target/deployer binding before capturing the input. Existing funding and simulation callers retain their binding rechecks.

The new group preflight uses a shared sixty-second cancellation deadline and an explicit provider. It builds every packet from the server-derived input, rejects groups above the current five-packet execution profile, and checks the owned bindings after assembly, funding and complete economic simulation. Funding and simulation manifests and allowance digests must match the rebuilt group. No subset, client-authored simulation or independent-simulation fallback is accepted.

Only after final owned binding and cancellation checks can an internal caller capture the public unsigned input. The report contains the complete group, targets, canonical allowances, ownership-binding digests, collected creation/funding/simulation evidence and disabled signing/execution flags. Durable reviews/reservations and program/transport/authority review remain explicitly required.

## Verification

- The five new preparation cases passed in isolation using a disposable local SQLite database through the actual Turso/D1 adapter.
- Owned deployer/project/release and holder proof/role/revision/folder reads, target derivation, group assembly/funding/replay/rent/economics and post-collection owned binding checks use real code. Only create preflight is mocked with complete controlled creation evidence; its existing route tests are part of the regression scope.
- An eighteen-slot all-base saved plan builds the exact expected multi-packet manifest, retaining its zero slot, and performs one sequential replay without signing permission.
- Another owner and reversed limit order reject before provider calls. A holder revision changed during funding rejects before replay. A proof revoked during rent/economic collection and a same-revision project content change reject.
- An initial run had two concurrency-test timeouts while compilation was also active; all five passed when rerun alone. The broader regression run uses two workers, with compilation/build kept separate. Passing checks do not qualify a live provider or funded flow.

- Nine selected owned-group preparation, existing holder review/signing, group review/simulation/funding/accounting and holder/create-preflight route files passed 124 tests with two workers. The affected route and single-packet regressions pass on the shared-context refactor.
- Final focused preparation file passed all six cases, including direct one-packet compatibility: four signers, original report format, no exposed internal input, one final capture and no funding/replay call.
- Actual-source TypeScript, four-file typed lint, whitespace checks and production Next.js build passed. TypeScript/lint were rerun before the final focused test. Ignored build log: work/owned-group-preparation-build.log.

## Next

Add tested durable group review persistence, atomic project/wallet reservations and revision transitions, explicit approval and full signature registration. The new format cannot safely use the existing single-holder review guards without an append-only migration. Then qualify complete live unsigned v1 replay, program/code/authority and tip/send transport, and connect one-attempt submission and complete/partial/unknown recovery/UI. Groups beyond five packets still need an explicit execution policy.

No API/UI/protected Claude file, migration/remote SQL, actual provider request, credential/provider change, cron, push, deployment or real-wallet action occurred. Existing dirty files on main are preserved. Migration 0081 remains local, and full Proxima parity remains unfinished.
