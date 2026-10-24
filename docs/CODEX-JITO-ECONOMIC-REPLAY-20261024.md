# Jito economic replay checkpoint, 24 October 2026

Base commit: `2801e6f`. This checkpoint follows the existing Jito send-once/recovery fixes, Token-2022 policy comparison and normalized sequential-frame contract. It adds unsigned local economic replay. It does not make the live flow fully bundle-simulated or provider-qualified.

## Ownership and boundaries

Bounded Codex scope: five new files, `lib/jito-bundle-economics.ts` and its test, `lib/jito-bundle-token-state.ts` and its test, and `test/jito-sequential-economics-fixture.ts`, plus this handoff and its JSON proof. No existing application, UI, signing, provider or schema file changes. This claim finishes with the checkpoint. The unrelated dirty `AGENTS.md` and seven unfinished 0144 warmup files remain excluded. Claude can continue on a branch from `origin/main` without touching these frozen new modules unless coordinating a follow-up.

No deployment, application or hosted migration, provider/credential/cron setting change, real wallet unlock/sign/send, strategy run or funded trade. Git deployments remain disabled; an ordinary origin/main push is a source checkpoint only. No protected Claude layout files changed.

## What is verified locally

The new server-internal verifier reuses the real original signing-policy and settlement reviewers, then derives each packet's output from raw sequential account states. It admits the exact unsigned ordered swap-plus-tip vector, canonical envelopes, original inputs/minimums, fees, rent, native conservation, slot floors, custody and key mappings. It independently decodes raw supported mint/Rent observations and their relationship to in-frame state. Snapshots detach bounded parsed JSON before the first await.

All observed supported pair vaults participate in non-native token conservation: changes must match in-frame mint supply changes, or zero when the mint is absent. Per-account checks prevent units disappearing through rewritten mint bytes, changed token programs, mint-shaped replacement or unclean closes. A non-native account can disappear only with zero initial units and a clean zero-lamport close. A surviving WSOL vault must preserve its stored reserve, and its units plus reserve must equal its lamports. Legitimate native wrapping/closing and matching in-frame input burns remain covered.

The verifier retains original per-wallet minimum output and upfront funding checks, adds an explicit observed net native-debit ceiling, rejects another selected wallet's custody changes, and checks the exact tip payer debit, fee, recipient credit and reserve. The tip recipient must already be a plain System account. Output describes only touched wallet accounts and selected pair assets; it is not complete holdings or P&L.

The token decoder uses raw SPL/Token-2022 bytes, original account indices and admitted mint precision/programs. Active delegates, delegated allowance, close authority, unrelated owned token assets and unsupported owned extensions refuse. Inactive COption bodies may retain stale bytes, as the [official SPL pack/unpack implementation](https://github.com/solana-program/token/blob/main/interface/src/state.rs) permits. Opaque foreign programs are not treated as wallet token ownership.

All signing, execution, automatic execution, provider/network qualification, current source, signature, runtime privilege, ALT provenance and receipt flags remain false. `frameEconomicChecksPassed` means local mathematical consistency only. No API, UI, storage or production caller mounts these modules. Production still uses its existing individual simulations.

## Verification and corrections

Final economic cohort: **331 tests across ten files**, zero failures or skips. Existing Jito client/API/preparation/server/send-once/recovery/receipt/activity regression cohort: **71 tests across seventeen different files**, zero failures or skips. Combined: **402 tests across 27 files**. These are targeted local regressions, not the entire repository suite or a signed-in browser/mainnet test. Provider and browser-fixture tests use doubles.

Plain project TypeScript, five-file type-aware/type-checking lint and formatting pass. Isolated Node24 production build results and final source comparisons are recorded in the JSON proof. No env files, application database or excluded drafts are copied into the build. The modules are unmounted, so a successful Webpack build is not runtime/provider execution evidence.

The fixture exercises Buy/Sell, one to four wallets, static/ALT accounts, SPL/Token-2022 and kept/closed WSOL. Foreign asset and WSOL vault balances move with the wallet effects, mint supply is populated, Rent is raw canonical data, and native backing is explicit. Additional input-burn cases preserve supply accounting. Program bytes remain structural placeholders: these are not deployed Jupiter/SPL code-identity fixtures or actual DEX simulations.

Actual authenticated Claude Opus 5.5 performed three source-only reviews using Read/Glob/Grep, no edits/tests and zero permission denials; copied source stayed unchanged. Codex evaluated the findings and ran the tests. Accepted findings added the observed debit cap, independent Rent/System minimum, existing tip recipient, canonical-envelope ordering, decoder compatibility and truthful scope labels. The third review identified vault reclassification and reserve-mutation gaps. Codex fixed those and added four regression cases; that final transition patch and stronger test fixtures were independently verified, not rereviewed by Claude. One intermediate test expected a later refusal message, but the decoder correctly refused earlier; the final valid mint-shaped adversarial fixture now reaches the transition guard. All outcomes remain in ignored local QA records.

## What is still missing

1. **Actual endpoint qualification and collector.** The prior Alchemy probes remain failed/unqualified. This checkpoint makes no new provider requests. Vendor normalization, complete ordered vectors, exact simulation bank, same-bank fees, source/address binding, lossless amounts and bounded transport must be proven without silent fallback.
2. **Runtime and source authenticity.** Parsed caller-supplied states cannot establish actual program code, runtime-effective privileges, genesis, signed execution or ALT provenance. Supplied self-fingerprinted manifest policy is not authenticated owner consent. Historical replay deliberately grants no current authority. The JSON snapshot is not a Proxy detector; raw transport must be bounded before parsing.
3. **Owned integration and signed final replay.** Immutable owner-scoped review/evidence, fresh authorization, exact signed-vector prebroadcast simulation and all source/code/ALT/lifetime checks must precede the existing durable send-once marker. Unknown outcomes must keep original-ID read-only recovery and never automatically resend or refresh expired bytes.
4. **Scope limits.** Observed net debit and initial sufficiency are not an intra-transaction gross trace. Partial supply bounds are not a global supply audit. Previously existing WSOL reserves are preserved, not forced to today's Rent minimum. Complete funded execution/receipt proof is untested and requires separate specific approval.

No migration was added. The journal still has 146 entries through `0146_launchlab_launch_recoveries` (idx145). The excluded 0144 draft remains reserved. Next unclaimed number is 0147, subject to a new journal/claims check.
