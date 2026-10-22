# Observed reserve movements and gross-budget evidence

22 October 2026. Base `1724984c227afd386075f0d3820e011c175d366b`. This checkpoint preserves more information in the native account collector. It does not establish a gross spending limit or enable execution.

## Measured information loss

A controlled test creates one wallet-owned token account with 2,039,280 lamports and closes another with the same reserve. The original net result is zero. Separating visible increases and decreases preserves 2,039,280 in each direction. Wrapped SOL token units are removed before reserve comparison, so native liquidity is not mislabeled rent. A second test places no account in either snapshot: activity entirely between snapshots cannot be reconstructed and zero observed movement remains non-authorizing.

The new collector values cover only wallet-owned token accounts represented in the original pre/post token metadata. They exclude the system wallet, foreign-owner token accounts, program PDAs, non-token accounts and accounts absent from both snapshots. They are observed reserve changes, not gross transaction debits. Sums use exact bigint arithmetic and may exceed uint64 across multiple individually valid accounts; any later bounded persistence/admission format must explicitly refuse overflow rather than truncate.

Existing net rent, token maps, native settlement, metadata checks and receipt serialization retain their semantics. No receipt migration or consumer uses the extra fields yet. Existing stored receipts contain net rent only. They cannot recover these split observations, much less complete gross spending, from a hash or a `verified` flag.

## Execution admission consequence

The original planning review sums rent across lots before clamping a positive total. A refund in one lot can offset a debit in another. Preserve that historical reporting contract, but do not reuse it as the new execution allowance. New admission needs independently bounded complete setup spending and network fees, and must debit gross authority without replenishing it from refunds or proceeds. Possible evidence includes fully decoded exact account-creation instructions plus verified sizes/rent policy, with unsupported or hidden effects refused. Missing historical gross evidence requires a new explicit review with independently bounded terms, as specified in CODEX-WARMUP-EXECUTION-ROOT-ADMISSION-20261022.md. The new observations alone do not satisfy this requirement.

## Review and verification

Actual `claude-opus-5-5` reviewed seven unchanged copies using Read/Glob/Grep only, zero permission denials, no blocker and no tests run. It confirmed the original checks and caller destructuring remain unchanged, warned that wallet-owned token scope must be explicit, and confirmed stored net rent cannot prove gross debits. Codex accepted clearer naming/scope and stronger shape/scope tests afterward; those final changes require independent verification and are not claimed as part of the reviewed snapshot.

Reviewer advice to persist each aggregate as uint64 is not a current schema rule: two valid maximum-uint64 accounts can sum above that range. Any future domain limit must be enforced explicitly. Do not infer a persistence format or new provider facts from the review.

Final74 tests/six physical files pass, zero failures/skips, including eight new movement cases and existing native settlement, receipt, Counter, signing and v2 Sell runtime regressions. Plain TypeScript, two-file typed lint/format and git diff --check pass. The final renamed fields, exact key-set assertion and foreign-owner test are independently Codex-verified after the Opus review. Ignored final report: work/release-qa/warmup-reserve-movements-final-20261022.json. This is neither a latest-source full-suite result nor funded proof. No protected Claude UI, settings, credentials, cron, provider read/change, API mount, application/hosted SQL, migration, real wallet unlock/sign/send, strategy, funded test or deployment occurs. Migration 0139 remains unclaimed; older archive handoff dirt remains intact.
