# Bounded funding history hardening

22 October 2026. Source base `787eeb5663886c5c31db776980dfeb262b753d56`.

## Existing wallet timing indicator

The selected-wallet recorded-funding feature remains unchanged: explicit Check recorded funding times, red clock/details strictly below 30 minutes, exact gaps such as 24m 34s apart, and visible known/unknown counts. It uses most recently SAVED finalized native SOL receipts, not first funding or complete external history. It is an indicator, not a running countdown. See CODEX-WALLET-FUNDING-PROXIMITY-20261022.md.

## Corrected history evidence

The existing Bubble Map reader could skip a missing oldest transaction and call a later transfer the first funder. It also treated missing transaction metadata as success and grouped all outer instructions before inner transfers. The new regression file initially had eight failures against the original reader.

The reader now requires a terminal empty provider page, allows at most three nonempty pages, validates descending slots and unique 64-byte signatures across pages, and binds the transaction to the requested signature and slot. Missing, failed, unsupported or ambiguous oldest evidence returns unknown without later fallback. Equal oldest slots are unknown because transaction indices are unavailable. This is bounded provider evidence, never a full archive guarantee.

Native transfer admission requires explicit successful metadata, actual inner-instruction recording, valid System program identity, a positive exact uint64 amount and canonical addresses. Outer/CPI execution order is preserved. Missing CPI records, malformed matching transfers and unidentified instructions cannot silently disappear before a later supported transfer. Optional block time comes from the actual transaction only; invalid or future timestamps are refused. Batch lookup has a bounded address/concurrency scope and stops new calls on the first failure, waits for in-flight reads and discards late output. It does not cancel already-started transport requests.

Minimal owned Bubble Map copy now discloses incomplete provider history and unknown evidence. API production code, its gate, protected Claude UI and the red timing component are unchanged. Its existing empty-history expectation and static-502 regression are updated/tested.

## Existing provider capability probe

Using the existing ignored local Alchemy holder setting, a read-only probe returned the correct mainnet genesis and one ascending getTransactionsForAddress signature record with a pagination token. Only method availability was established, not first funding, full-transaction availability, archive completeness, runtime qualification or production plan access. Three RPC requests total included the initial failed network comparison: that script incorrectly used a truncated genesis constant, then was corrected from Bundle's actual constant. The original failed receipt is retained. No provider setting or credential was changed; no URL/key or wallet data is published.

Official method reference: https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/get-transactions-for-address . The ascending method is NOT wired into wallet timing or Bubble Map in this checkpoint.

## Verification and review

54 tests pass across nine related files, including the actual wallet-table mount, timing model/server/API and Bubble Map parser/history/API/panel. Plain TypeScript and seven-file typed lint pass. Initial formatting/lint found an unescaped apostrophe in new copy, corrected without changing behavior. Seven-file formatting and the final isolated production build pass with all seven overlay hashes unchanged. No environment files were copied. The earlier build compiled but source changed during the accepted review corrections, so its overall unchanged-source check correctly failed; it is not counted as final-source verification.

Actual claude-opus-5-5 reviewed an 11-file source-only copy using Read/Glob/Grep, zero permission denials and unchanged copies. It ran no tests. Codex evaluated the findings: missing CPI data, malformed transfer fallback, unidentified instructions and indistinguishable same-slot oldest records were tightened, with pagination/cursor/cross-page/seeded/u64/API regressions added. Final follow-up was independently verified, not rereviewed. Unrelated zero-value System transfers can conservatively make the whole lookup unknown; this sacrifices coverage rather than inventing evidence.

## Remaining limits

Externally funded wallets still need a separate bounded provider/source design before funding-time warnings can claim broader coverage. Provider-parsed history is not independent verification or common-control proof. Bubble Map's existing UI32/API20 batching versus its ten-second gate remains open, as do its transport/body/response bounds, total timeout and per-wallet unknown-reason disclosure. No new rendered/signed-in browser QA is claimed. Full Proxima parity and automatic warmup execution remain unfinished.

No deployment, application/hosted SQL write, migration, provider/credential/cron change, real wallet unlock/sign/send or funded test. Group/stock/warmup signing gates are unchanged. Source publication is not a production release.

Local ignored reports: `work/release-qa/bubble-funding-evidence-{baseline,final}-20261022.json`, `bubble-funding-evidence-final-build-20261022/result.json`, `opus-bubble-funding-evidence-20261022/` and `funding-history-capability[-corrected]-20261022.json`. The sibling evidence JSON is portable and contains no provider URL or key.
