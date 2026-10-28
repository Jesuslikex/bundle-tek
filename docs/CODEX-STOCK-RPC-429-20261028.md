# Stock qualification rate-limit and refusal evidence, 28 October 2026

Stock read-only qualification now recognizes a JSON-RPC error code 429 inside an HTTP 200 response, including top-level and batch errors with an unmatched ID. This produces the existing fixed-text rate-limit error and stops the bounded campaign before another attempt. The same rule covers setup and the post-attempt reference audit; the response body, provider message, URL and credential are not copied into the diagnostic. HTTP 429 counts and parsed RPC 429 are recorded separately. Other provider failures receive a bounded fixed-enum category without relaxing any RPC response, context, byte, slot or cancellation checks.

The qualification source manifest includes the balance-RPC implementation, campaign summary logic and new helper, so source changes to those paths invalidate the sample. The summarizer rejects a purported passing receipt with an RPC rate limit while retaining compatibility with historical receipts that lack the new field. Tests cover the real balance and pair-reader paths plus the campaign stop and source manifest.

## Fixed Alchemy sample after these changes

Six alternating attempts ran with the existing Alchemy endpoint selected only inside the local qualification process, 16 methods per second, no endpoint fallback and no rate-limit retry. Both HTTP 429 and parsed RPC 429 counts were zero. Every receipt reported unchanged source, zero signatures and zero broadcasts.

| Attempt | Outcome |
| --- | --- |
| SOL 1 | Passed, 26 slots |
| USDC 1 | Refused: original minimum 247473, order minimum 247456 raw units |
| SOL 2 | Passed, 26 slots |
| USDC 2 | Passed, 26 slots |
| SOL 3 | Refused: original minimum 24998, order minimum 24995 raw units |
| USDC 3 | Passed, 18 slots |

The two strict-minimum refusals are valid safeguards, not missing attempts. The fixed sample is **2/3 for each asset** and does not meet the requested repeatability threshold. No provider-read diagnostic category was reached by the failed attempts, so the earlier generic provider errors remain unexplained. Private receipts are retained in ignored `work/stock-repeatability-2026-10-28T17-31-16-331Z/`, and may include provider metadata.

Node 24 focused verification covers 98 tests across balance, pair-reader and pacing files and 18 Node campaign/summarizer/manifest tests. TypeScript, scoped lint and formatting passed. These results are not a full suite, production build, signing qualification or funded proof. No persistent provider/credential change, deployment, signature or broadcast occurred. Preserve the strict early minimum, 32-slot limit and all other guards; do not enable stock signing based on this sample.
