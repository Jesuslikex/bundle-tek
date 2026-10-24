# Imported Jito sequential evidence handoff, 24 October 2026

Base: `449d920`. Policy fix: `d0728dd`. Local source and verification only; no deployment or funded transactions.

## What changed

| Area                   | Current state                                                                                                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token-2022 refresh     | Mounted fix in `lib/jito-bundle-server.ts`, after the existing real fresh simulation and settlement reviewer. Strict stable-policy comparison allows only coherent forward observation slots. Economic fields, mint policy, rent, custody, fees, signatures, one-send claim and original expiry are unchanged. |
| Sequential frames      | New unmounted `lib/jito-bundle-simulation-frames.ts`: exact ordered request contract and normalized response-integrity verification. It cannot authorize signing or execution.                                                                                                                                 |
| Full bundle economics  | Still missing: decoding raw per-account SPL/native effects and enforcing every original input, output minimum, fee/rent allowance and exact final tip together. Individual simulations remain the production behavior.                                                                                         |
| Provider qualification | Not achieved. The configured Alchemy holder endpoint answered bounded read-only probes, but the pinned-bank profile was refused and the documented tip-bank probe returned a failed partial result. No configuration changed.                                                                                  |

## Do not misread these artifacts

`jito-bundle-baseline.ts` is activity backfill, not an economic baseline. `WarmupSettlement` stores custody/setup/rent/debit policy and ALT hashes, not realized output. Comparing that structure cannot prove that shared-pool output is unchanged.

The frame verifier is a pure normalized profile. It is not a raw Alchemy/QuickNode adapter. Its source has no provider, default client, database, API or UI caller. It requires caller-observed exact fees and independently resolved ALT vectors; neither input establishes its own provenance. It binds the result slot to the exact requested bank and the existing 32-slot minimum floor. It rejects v1, invalid program references, empty ALT lookups, altered readonly/executable state, discontinuity, fee/conservation mismatch and incomplete account vectors. Returned masks are requested privileges, not runtime-effective privileges. Runtime-reserved-key admission, ALT provenance, signatures, network identity and economic outcomes remain separate. All authority and qualification flags are false.

Limits: 2–5 packets, 1,232 serialized bytes each, 4 MiB normalized wrapper, 2 MiB total decoded account data, 512 KiB per account, compute at most 1.4 million per frame and loaded data at most 64 MiB. These are refusal bounds; they are not a claim that all legitimate routes fit. A future transport must bound raw response bytes before parsing and normalize vendor fields explicitly.

## Actual provider observations

Existing setting read: `SOLANA_HOLDER_RPC_URL`, hostname `solana-mainnet.g.alchemy.com`. Values and access keys were not displayed or copied into this note. No other endpoint was substituted, and no Vercel setting changed.

Three retained local probe records, seven total RPC calls:

1. The first script stopped after one successful genesis read because its locally written comparison constant was truncated. Its outcome is retained; it establishes no network mismatch or simulation result.
2. Corrected genesis comparison uses the existing source constant. Genesis and latest blockhash returned HTTP 200. One `simulateBundle` with `{slot}` bank returned HTTP 200 / RPC `-32602`.
3. A distinct documented string-`tip` compatibility probe also passed genesis and blockhash reads. Its one simulation returned a structured failed/partial result, one frame for a two-packet request. No success or full qualification is claimed. Only field names/cardinalities and safe status metadata were retained, so the exact transaction-refusal cause is not available from this sanitized record.

Both simulation calls used public tip references, zero-value unsigned System transfers, original blockhashes and `skipSigVerify:true`. No signatures were created by the probes and no send method was permitted. Test fixtures separately create synthetic signatures only.

Official references: [Alchemy simulateBundle](https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/simulate-bundle), [Alchemy Jito availability](https://www.alchemy.com/docs/chains/solana/solana-jito-bundles-and-transactions), [QuickNode simulateBundle](https://www.quicknode.com/docs/solana/simulateBundle), [Solana v0 loaded privileges](https://github.com/anza-xyz/solana-sdk/blob/master/message/src/versions/v0/loaded.rs). Documentation and method availability do not establish this app's endpoint qualification.

## Verification

The completed joint regression run passes 287 tests across 27 files, zero failures or skips. Separately, 173 distinct current tests across eight focused files pass. This is the per-file latest-result union of the 95-test production integration run, 122-test reviewed follow-up and final 78-test frame hardening run. One intermediate expectation still matched the old v1 refusal text; it was corrected and all 78 final cases passed. Project TypeScript, scoped type-aware lint and formatting pass. An AST/printer comparison against 449d920 proves the only existing Jito server changes are the comparator import and comparison call; every other server statement is unchanged.

Two isolated Node24 production builds completed successfully; the reviewed build copied 3,765 files without env files or excluded drafts, with every copied hash unchanged at build completion. The final application source still matches that build. Only the unmounted frame module and its tests changed afterward for explicit shape/version/header/program hardening; final project TypeScript, lint and 78 tests passed after those changes. This is not a claim that the post-hardening unmounted files were rebuilt in Webpack.

Actual authenticated Claude Opus5.5 completed two source-only reviews, using Read/Glob/Grep only, zero denials/edits/tests and unchanged copied files. Initial review found no production comparator bypass and identified normalized-frame gaps; the follow-up confirmed those corrections and found no remaining internal false acceptance within that limited scope. Final field-name matching, explicit version allowlist, integer headers, executable-program refusal and test-message fixes were independently verified by Codex, not rereviewed.

The separate 27-file broader regression run completed with exit 0: 287 tests passed, zero failures or skips. Its result is work/release-qa/jito-sequential-final-20261024.json, including all 78 final hardening cases. Earlier observation timeouts were correctly treated as a live run; it was not restarted. The committed JSON summary records this terminal outcome. This is a related regression cohort, not the entire repository suite or funded qualification.

## Next integration requirements

1. Explicit vendor normalization and actual endpoint profile qualification, including v0/ALT, full frame cardinality, exact bank, same-bank fee provenance and signed verification. No silent profile or provider fallback.
2. Raw-state economic decoding for both Buy/Sell and supported Token-2022 policies, original per-wallet minimums, unrelated-asset refusal, native/rent conservation and exact tip credit/debit. Keep conservative upfront funding checks.
3. Owned immutable review and prebroadcast evidence, schema and claim guards, plus truthful UI admission. Historical bundles must never be relabeled as fully simulated.
4. Exact signed-vector replay before the existing durable one-send marker, source/program/ALT/genesis/lifetime rechecks, and original-ID read-only recovery. Do not renew expired packets or automatically resend unknown outcomes.

No hosted migration, cron/provider/credential change, real wallet unlock/sign/send, strategy run or deployment. Protected Claude parent/layout files and the unrelated dirty `AGENTS.md` remain untouched. The seven untracked unfinished 0144 warmup files remain excluded. No migration added here; current journal ends at 0146 (146 entries, idx 145), next unclaimed number is 0147 after rechecking concurrent work.
