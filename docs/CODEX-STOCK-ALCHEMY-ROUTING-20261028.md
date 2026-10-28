# Stock qualification and pair router alignment, 28 October 2026

This checkpoint is read-only qualification evidence, not stock-signing or funded-trading approval. No deployment, persistent provider or credential change, signature or broadcast occurred. An existing Alchemy holder endpoint was selected for the qualification process only, at a 16-method-per-second stock profile; other processes and saved configuration were unchanged. Every campaign retained its fixed attempts and stopped on its first observed rate limit.

## Initial Alchemy campaign

The fixed six attempts completed without an HTTP 429. USDC passed 3/3 at 27, 17 and 17 slots. SOL passed 1/3 at 30 slots; its other two attempts refused route assessment. The refusals both received DFlow wallet-bound orders while the preview was Metis. The retained summaries do not contain the full route-assessment values, so they do not prove the exact failed subcheck. No signatures or broadcasts occurred. This is a bounded sample, not production or funded proof.

## Pair-only change

Pair wallet-bound preparation now requests Metis only and rejects a response that ignores the exclusion. The pair collector already requires decoded Jupiter instructions, so the request is aligned with its existing verifier rather than accepting unsupported routes. Ordinary wallet-bound warmup swaps retain DFlow support. The strict original minimum-output check, decoded instruction checks and all signing limits remain unchanged. Unit tests cover SOL and USDC packet preparation, ignored exclusions and the unchanged ordinary DFlow path.

## After the change

A separate fixed six-attempt sample completed without HTTP 429. SOL passed 1/3, at 20 slots; one attempt correctly refused an original minimum decrease from 25001 to 25000 raw units, and one failed during a provider read. USDC passed 2/3, both at 16 slots, with the remaining attempt refusing during a provider read. The two generic provider-read errors did not retain enough detail to identify their exact cause. No failed attempt was replaced, and the earlier USDC passes are not combined with this changed-source sample to claim repeatability.

All 12 attempts in the two campaigns retained source unchanged, no signatures and no broadcasts. Private campaign receipts remain in ignored `work/stock-repeatability-2026-10-28T17-06-50-571Z/` and `work/stock-repeatability-2026-10-28T17-11-03-541Z/` and can contain provider metadata; do not publish them. A full production build or funded execution has not been verified.

The separate pacing fix restores guarded rolling-admission pruning and refuses batches larger than the configured budget; it does not raise limits. The initial 16-method sample does not establish available throughput for other accounts or providers. Continue diagnosis without changing the original 32-slot, early-minimum, custody, Clock or scan rules; keep stock signing off pending qualification.
