# Owned stock-pair runtime preview

15 October 2026. Extends the unsigned candidate/simulation checkpoints. This is local work; production remains source 34bcd9a.

## Runtime evidence path

`POST /api/imported-projects/pair-order-runtime` requires the current owned pair/wallet request, `prepareUnsigned: true`, and explicit `inspectRuntime: true`. It creates a fresh wallet-bound candidate through the existing quote gate, then inspects that exact packet. Caller-supplied packets, code vectors, policies or signing authorities are rejected. Authentication, same origin, exact JSON MIME, bounded/cancellable UTF-8 body, no query overrides, owner/revision/archive checks and final saved-context checks remain enforced. Only the existing manual quote gate is written; no approval, reservation or signing material is stored.

The preview resolves account tables independently and scans every message account, including executable accounts not called in the observed simulation. All top-level and reported inner programs must be covered. The profile rejects writable executable accounts, nonempty System-owned writable state such as nonce accounts, and unsupported writable stake/vote/config/lookup-table/loader custody, both in observed accounts and simulated post-state. This is a trading profile, not support for every Solana protocol or route.

The existing bounded launch-group collector supplies full ELF byte hashes, loader, deployment link/slot and upgrade-authority observations. Two complete collections bracket a fresh economic simulation of the original unsigned packet. Program vectors and executable coverage must match. The Compute Budget builtin uses a separately identified native account marker; native markers do not attest validator machine code. Selected wallet/account state, lookup tables, network, original blockhash, remaining height, quote expiry and the combined 32-slot bound are rechecked before publication. Changed code or authority is not silently adopted as policy.

The simulation explicitly requests inner instructions. The parser supports compiled, partially decoded and parsed RPC forms, with bounded data, account/program mapping, ordered groups and validated stack/parent relationships. Parsed labels are retained as a canonical information digest and labeled as lacking raw instruction bytes. They never become opcode verification or signing permission. The report binds trace coverage, reachable code identities, packet/pair/preflight/review identities and expiry.

`codeIdentityObserved=true` means these provider observations match. `programCodeAttested`, `trustedProgramPolicyEstablished`, `semanticAuditEstablished`, `innerInstructionPolicyVerified`, `signingAllowed` and `executionAllowed` remain false. Same-slot rewrites during sliced code collection cannot be ruled out, and a matching vector is not a semantic audit or an atomic bank snapshot. Later approval must bind the actual preview and limits; this endpoint cannot authorize signing.

## Shared collector correction

Account normalization dropped RPC `space` metadata before the collector could apply its existing declared-size checks. The collector now retains validated unsigned space metadata. A new test rejects a response that declares more code than it returns. Legacy no-space observations retain the existing bounded short-chunk profile. No historical schema, identity format, code-consent requirement or signing permission was broadened.

## Verification

Final qualification passed: 671 tests across 30 selected files together, production Next webpack build, standalone TypeScript after the build, twelve-file typed lint, formatting and whitespace checks. All 1,272 implementation/configuration/style hashes remained unchanged through the final run. The complete repository-wide suite was not rerun. The selection includes native quote/signing/receipt regressions and shared group code-identity/runtime-service/authorization cases. New tests use real v0 wire packets, local owned SQL and controlled full-code/inner-trace RPC fixtures. Synthetic ELF prefixes establish collector behavior, not executable AMM correctness or a semantic audit. No live provider runtime preview or funded test was performed.

Initial focused failures were a fixture context inconsistency: its response slot was held constant while its synthetic Clock data still advanced. Correcting both together restored the runtime path. The cancellation test now races its start handshake against setup failure rather than waiting for an impossible read. Final hardening also applies unsupported writable-custody checks to newly created simulated state, not only real pre/post read snapshots. The final focused run passed 58 tests across four files; the combined run started at 22:55:38 local time and completed in 246.69 seconds.

Ignored receipts: `work/pair-runtime-{tests,build,types,lint}.log`, `work/pair-runtime-test-files.json`, `work/pair-runtime-source-freeze.json` and `work/pair-runtime-focused-final.log`. These are local qualification artifacts, not deployment or funded evidence.

Primary RPC formats were checked against https://solana.com/docs/rpc/json-structures and https://github.com/anza-xyz/agave/blob/master/transaction-status/src/lib.rs . Agave's simulation inner-call conversion can produce parsed instructions. These mutable references were inspected on 15 October 2026, not used as proof of any deployed binary's behavior.

## Remaining product work

A reviewed runtime/inner-instruction policy or explicit bound code-review flow, currency-aware durable reservations and approval, encrypted-browser signing, registration, broadcast/recovery, exact quote-asset settlement/accounting, stock-launch scaling and protected UI integration remain required for the end-to-end stock workflow. Proxima parity remains incomplete. Existing SOL-only signing adapters do not consume this preview.

No UI file, migration, remote SQL, provider/credential setting, cron or production deployment changed. No real wallet was unlocked, signed or submitted. Main's two unrelated dirty files remain protected.
