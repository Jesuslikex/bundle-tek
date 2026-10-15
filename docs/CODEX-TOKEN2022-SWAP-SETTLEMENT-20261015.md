# Token-2022 native buy/sell settlement

15 October 2026. This continues the Proxima goal after the finalized launch-to-chart handoff in `7d4536a`. Source inspection found that Jupiter's Pump venue variants were already decoded, but V2 program checks, binary account bindings, native signing settlement and finalized receipt recovery still admitted only legacy SPL tokens. That excluded the Token-2022 program used by the pinned Pump create path.

## Implemented scope

The existing Metis ExactIn SOL buy/sell path now admits a native pair whose other mint uses Token-2022, with only metadata-pointer/token-metadata mint extensions and immutable-owner token-account extensions. Bare initialized Token-2022 mints/accounts also have canonical base support; a newly created associated account must have the expected immutable-owner allocation. Transfer fees, hooks, confidential/unknown extensions, alternate wrapped-native programs and unsupported layouts remain rejected. The separate ExactOut Counter path remains legacy-only.

Every signing simulation independently reads both mint accounts, matches their programs against V2 declarations (or legacy defaults for V1), and rechecks program/precision/authority/extension policy after simulation and lookup rechecks. Policy SHA-256 excludes only supply bytes 36 through 43 so routine mint/burn activity does not prevent an unrelated swap. Program, decimals, authority fields and all extension bytes remain bound. The RPC wrapper preserves integer spellings as strings; numeric context slots from an unsanitized caller are rejected.

Account bindings match the program declared for each side as well as the exact account, mint, wallet and initialized state. Token-2022 pre/post accounts are decoded canonically with a narrow extension allowlist. V2 route recognition is a field comparison; it does not independently prove mint identity or grant signing clearance.

For Token-2022, native settlement version 2 retains the fresh mint policy evidence and the separately read 170-byte ATA rent requirement. It derives associated addresses using the correct per-mint program, verifies post-state program/allocation/authority, and reconciles actual wrapping, balances, rent and fees. The rent RPC has no context slot; its value is bounded and must agree with actual simulated post-state allocation and lamports. Native WSOL remains under the legacy program. The existing debit, output, compute-fee, account-scope, cleanup, lookup and explicit approval checks remain required. Legacy settlements keep version 1.

Finalized Token-2022 receipts require that saved version-2 approval proof, the exact saved packet hash, verified wallet signature, account-key hash, expected mint/program/precision and native/token settlement. Receipt recovery without the corresponding proof continues to reject Token-2022. The owned imported signing API carries that proof through durable review, registration, one-attempt mocked submission and atomic recovery, including after archiving the source project. No new schema is required.

## Review

Claude reviewed the implementation through the existing tool-free CLI review session. Its first pass led to explicit missing-proof rejection, fresh mint reads even for legacy declarations, and program-aware account bindings. Its follow-up found no new safety-critical issue. The suggested lower recheck-slot problem was checked against `readSwapLookupAccounts`: it already rejects a returned slot below the requested simulation slot, and `readSwapMintEvidence` enforces its requested lower bound too. API receipt recovery reads the saved preparation by owner and the intent's preparation id; the decoder binds the exact packet hash, wallet and version-2 mint pair. Existing preview limitations explicitly withhold ownership/debit/signing clearance. Claude did not run tests.

## Verification

Final Node 24 verification passed all 35 selected files together: 589 tests, zero failures, 349.63 seconds. Actual-source TypeScript, scoped type-aware lint and the production webpack build passed. All twelve changed implementation/test files matched their frozen hashes throughout verification, and main's two unrelated dirty files retained their original hashes. Logs are retained locally in ignored work/token2022-swap-regression.log, work/token2022-swap-{types,lint,build}.log and the source-freeze JSON. This targeted pass does not replace the older full-application-suite snapshots.

Coverage includes actual synthetic packet construction, fresh controlled RPC simulation, browser-local signing, exact signed receipt decoding and real local D1 API transitions for legacy and Token-2022 Buy/Sell. Negative cases cover substituted/missing programs, metadata policy changes, stale slots, unsupported/duplicate/truncated extensions, native-program substitution, missing proof, wrong precision/rent, frozen post-state, proofless receipt recovery. A positive test verifies that supply-only changes do not alter mint policy. Existing manual consent, reservations, cancellation, session/conditional and recovery rules are regression-tested.

No Claude-owned UI/layout, shared CSS, migration, hosted SQL, provider configuration, credential, cron or production setting changed. No push/deployment or real provider request, user-wallet unlock, signature or submission occurred during QA. Transaction sends in API tests are intercepted by mocks.

This removes a local compatibility blocker. It does not prove immediate Jupiter indexing/liquidity for a new Pump mint, a rendered signed-in workflow, funded buy/sell execution or full Proxima parity. Trading directly against a selected stock quote asset, the separate ExactOut Token-2022 adapter, other launch venues/chains, comprehensive holders/history, audited economics and marketplace integration still require work.

## Source references

- Solana's [immutable-owner guide](https://solana.com/docs/tokens/extensions/immutable-owner) and installed `@solana-program/token-2022` 0.15.0 codecs inform canonical account/extension allocation.
- [Jupiter's program update announcement](https://t.me/s/jup_dev?before=139) explains V2 Token-2022 program support. Account ordering remains the project's existing pinned program interface; no new venue layout was invented here.
- `token-withdrawal-extensions.ts` supplies the existing canonical TLV decoder; this path narrows its allowlist further by refusing transfer-fee extensions.
