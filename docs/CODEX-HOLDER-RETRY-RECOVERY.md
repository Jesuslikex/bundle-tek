# Holder scan retry and lost-response recovery

12 October 2026. This repairs the holder index's foreground continuation. It does not establish universal holder coverage or complete Proxima parity.

Previously, the first temporary page-read failure ended the scan. The user had to resume manually, even though the server already supported idempotent retrieval of saved pages.

The holder panel now calls a holder-specific reader that retries the exact JSON body for the same project, revision, run ID and page. It makes at most four attempts per page. Temporary network failures, timeouts, 429 and selected 5xx statuses use bounded exponential delay with jitter and honor Retry-After. Each request is limited to 30 seconds. A retry that would exceed the existing five-minute scan-resume window stops and preserves saved pages rather than starting a different scan.

Authorization failures, project/run conflicts, invalid successful JSON and mismatched response identity are not retried. Page numbering, cursor, mint/program, supply and duplicate-account validation still occur before the client adds a page. The reader is specific to the idempotent holder endpoint and is not used for signing, submissions or any financial request.

The UI shows page number, retry reason, delay and attempt count while retaining Stop. Hiding the page, going offline, stopping or unmounting aborts the active request or wait. Reloading reads saved history and does not automatically start provider calls. Existing 500-page and 20-saved-run limits and the provider-coverage disclosures remain.

## Verification

- Twenty-nine focused tests passed across the retry helper, holder index/store/history and existing route cases. They cover Retry-After, identical request bodies, bounded exhaustion, timeout recovery, user cancellation, expired resume windows, authorization/context failures and malformed successful responses.
- A separate production-route test uses a disposable real Miniflare D1 with the full 69-migration chain. Its provider is a synthetic fixture, not a live indexer. The first response is deliberately lost **after** 1000 distinct accounts are saved. The retry returns that saved page without another provider invocation. The second page adds one account. A real GET/history-client reload restores two pages, 1001 accounts and exactly 1000000 atoms with zero remainder, no duplicate pages or inflated totals.
- TypeScript, scoped lint and production build passed. Claude's protected files were unchanged.

Actual live large-token/Token-2022 coverage, rendered interaction QA, cross-project provider behavior and hosted deployment remain outstanding. The original live proof remains a two-owner token; the 1001-account test is isolated route/storage recovery evidence. No provider secret was read or changed, no wallet signed or submitted anything and no new deployment occurred. This work is not yet present in the separate hosted version 115 candidate.
