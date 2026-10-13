# Live hypothetical buy-to-sell quote check

12 October 2026, observed at 22:01:34.897 UTC. The existing approved opt-in harness `work/live-provider-qa/roundtrip-quote.qa.test.ts` passed against the configured Jupiter service. It allowed only two GET requests to `/swap/v2/order`, prohibited a taker/wallet parameter and blocked all other operations. Both returned HTTP 200; duration was 588 milliseconds.

The requested buy was 10,000,000 lamports of SOL into public USDC. The returned 1,070,839 USDC atomic units were used exactly as the hypothetical sell input, without rounding through a floating-point amount. Both returned Metis quotes with the requested mint/amount binding and fifty-basis-point slippage protection. The existing validator rejected any prepared transaction in this wallet-free mode. Quotes expire after thirty seconds and this report is a historical snapshot, not a reusable execution authorization.

There were zero application database writes, signatures, broadcasts or transaction preparations. The service key was loaded only inside the opt-in harness; credentials were not displayed or saved in the report. The sanitized report is `work/live-provider-qa/roundtrip-quote-report.json`. Its previous successful 11 October result was preserved as `roundtrip-quote-report-20261011-preserved.json` before the new run.

This supports current provider connectivity and a sequential hypothetical SOL/USDC buy-to-sell quote contract. It does not establish funded execution, automatic wrapping instruction correctness, broader venue/launch support, Token-2022 execution, holdings acquisition, fee-complete net return, profitability or hosted readiness. Existing per-transaction review and approval remain required; the broader Proxima goal is incomplete.
