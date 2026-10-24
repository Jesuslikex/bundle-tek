# Coherent Jito lookup-source fixture, 24 October 2026

Base: `8d64a58`. Scope is exactly `test/jito-sequential-economics-fixture.ts`, new `test/jito-sequential-lookup-fixture.test.ts` and this handoff/JSON proof. The shared native warmup fixture and all production code remain unchanged in this checkpoint.

## Corrected test evidence

The aggregate multi-wallet fixture previously inherited one ALT address from the single-wallet fixture while assuming different table contents for each wallet. Earlier economic tests could still pass because that verifier explicitly does not authenticate raw lookup sources and retains false ALT authority. Those passes were not lookup-provenance proof.

Each aggregate wallet now uses a distinct deterministic table address. The rebuilt packet, its preparation/hash and the original simulation's table identity/hash are updated coherently before the existing actual signing-policy reviewer runs. Full raw synthetic table records are exposed as `lookupAccounts`: address, correct ALT owner, non-executable state, rent-backed lamports and canonical 88-byte table data. The data contains one active destination, initialized discriminator, undeactivated state and extension slot80, consistent at the synthetic bundle bank101.

Six focused tests use the real existing `readSwapLookupAccounts` and `assertSameSwapLookups` against an exact-request local callback, twice per table. Buy/Sell, SPL/Token-2022 and four-wallet ALT cases check loaded vectors, raw byte hashes, reviewed source identity, rent and unique addresses. Additional cases check absence of conflicting bytes under a single address, Rent/other-wallet composition and no-ALT/legacy-tip behavior. They also replay the complete economic verifier. These are synthetic decoder/source-consistency tests, not live RPC or actual ALT/runtime qualification. Executable program bytes remain placeholders.

## Verification

The combined final cohort passes **327 tests across eight files**, zero failures/skips: six lookup-fixture cases, nine streamed-flow, 100 economic, 88 frame/wire, 30 token decoder, 14 existing provider, 77 JSON-reader and three existing lookup-decoder cases. Four-file scoped typed lint/format and plain project TypeScript pass. The helper separately verified 115 cases across the new fixture, economic and streamed-flow suites. Codex inspected the diff and reran the combined cohort itself.

Claude Opus5.5's preceding bank-builder review did not include this fixture patch. No new reviewer, Webpack build, full repository suite, browser, live lookup admission, provider call or funded proof is claimed here. Complete packet-bound raw fee/ALT evidence admission and a full bounded vendor-response adapter remain the next integration work.

No deployment, application/hosted SQL, migration, provider/credential/cron change, actual wallet unlock/sign/send, strategy run or funded trade. Protected Claude files, the original AGENTS.md dirt and seven excluded warmup drafts remain intact. The current journal ends0146; next unclaimed0147 subject to recheck. This fixture claim is released after commit.
