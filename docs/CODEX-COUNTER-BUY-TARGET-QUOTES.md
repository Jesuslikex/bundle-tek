# Counter Buy target pricing adapter

14 October 2026. Added lib/counter-buy-quote.ts and its tests. quoteCounterBuyProposal accepts a decoded saved active Counter Buy plan, an exact recorded proposal identity and an explicit maximum swap-input SOL amount in lamports. The output target comes from the validated stored decision, not a client-supplied token quantity. The adapter snapshots the reviewed plan before provider I/O.

## Provider contract

Current [Jupiter v2 order documentation](https://developers.jup.ag/docs/api-reference/swap/order) supports ExactIn only. The [v1 quote endpoint](https://developers.jup.ag/docs/api-reference/swap/v1/quote) supports ExactOut, where amount denotes output atoms and slippage applies to input. It documents limited AMM support: Orca Whirlpool, Raydium CLMM and Raydium CPMM. This adapter uses that distinct v1 quote-only path; it does not alter or relabel the existing v2 signing preparation.

The request pins WSOL input, the saved mint output, the exact recorded target, ExactOut mode and 50-basis-point input slippage. No taker, wallet or transaction-building request is sent. Response identity, amount, mode, slippage, positive u64 quantities, context slot and bounded route metadata must validate. The provider's maximum input must be at least the estimated input, at most its conservative 50-basis-point ceiling, and no larger than the reviewed swap-input limit. Unrequested nonzero platform fees are rejected. This limit covers swap input, not network fees, rent or all-in wallet spend.

Provider redirects are not followed. Bodies are bounded to 256 KiB; malformed documents, provider failures and network diagnostics are replaced with product errors. Already-cancelled requests never reach the provider, and cancellation is rechecked before returning a preview. Returned data is limited to quote/context/route fields and a 30-second preview deadline. Provider transaction and request material are discarded. executionAllowed remains false, and neither the plan nor its decision is consumed or modified.

## Verification and remaining integration

**59 tests in three main files passed**: 30 new adapter regressions plus the existing Counter evaluator and swap quote tests. They cover exact recorded target, budget/slippage ceilings, wrong mint/mode/output, malformed or oversized responses, inactive/altered/missing proposals, private-diagnostic sanitization, cancellation and preserving the original reviewed snapshot during caller mutation. Actual-source TypeScript, two-file typed lint and production build passed, all exit 0. Reports: work/release-qa/counter-exact-output-reviewed-*-20261014.*. The 1074-file source snapshot stayed unchanged at digest 492c5716efeaff6ffb0f56ee12d3818d0cb839e14c958a30b880d7286527f952.

Tests use synthetic provider responses and recorded-signal fixtures, with no credential access or live quote request. This establishes the adapter contract, not real route availability or funded execution. It is not yet exposed through an owner-scoped endpoint or mounted UI. That integration must reread current project/plan context before and after quoting, enforce request limits and review expiry, and bind proposal consumption durably to transaction review. Fresh source eligibility, wallet balances, mint extensions/fees, actual instruction semantics and user-approved signing/submission remain unfinished. No silent conversion into an ExactIn trade is authorized by this adapter.

Claude's UI scope and the existing DCA/session layout remain untouched. Counter mount coordination is still requested in CODEX-COUNTER-UI-UPDATE-20261014.md. No schema, migration, hosted SQL, CROP candidate, provider credential, push, version save, deployment, signing or transaction changed.
