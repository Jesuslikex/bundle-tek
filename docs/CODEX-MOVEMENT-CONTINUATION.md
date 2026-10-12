# Foreground wallet alert inspection continuation

The wallet alert transaction evidence panel now offers **Continue index inspection** and **Stop index inspection**. This explicitly started run follows the selected wallet or token-account signature index through its saved alert interval, up to twenty successful pages per start. It does not start for newly arriving alerts or automatically discover/scan every account.

## Behavior

- `lib/foreground-movement-inspection.ts` serializes automatic continuation reads across panels in this browser module. Individual reads cannot overlap. Other supply/manual reads still use their existing server read gate.
- The next page starts thirty seconds after a successful read. Retryable network/rate/provider/storage failures retry the same cursor with exponential backoff and jitter, capped at five minutes before any larger valid Retry-After hint. At most five consecutive retries are attempted. Successful pages reset the failure count.
- Authorization, scope, cursor/anchor inconsistency and malformed successful results stop the run. Repeated cursors and missing progress stop it. Reaching an address boundary is explicitly distinct from full wallet coverage.
- Hidden/offline events, stop and component disposal abort in-flight work and cancel timers. Visibility/connection restoration never implicitly restarts. Queued aborted jobs skip their API call; stale completions cannot advance the scanner.
- Controls for index changes, account discovery and manual reinspection are disabled during continuation. The selected index is retained for a run. Stop releases the busy UI state. Progress, retry reason and page limits are visible.

## Retained page reuse

`app/api/imported-projects/supply-movements/route.ts` accepts an optional boolean `reuseSaved` for inspection. Continuation enables it; manual inspection leaves it off. An owner/project/observation/wallet/index/requested-cursor match returns the latest validated saved page before spending the provider gate. Its record ID and original observation time are retained. This recovers a persisted response after a transport failure without creating a new page for that retry.

Continuation requests still require current authenticated scope and a retained predecessor for non-null cursors. Requested cursor and anchor must match provider evidence before saving. The option is not an exactly-once guarantee across concurrent clients; existing immutable records are preserved. Fresh manual reinspection can produce new evidence and classifications. No database migration is required.

## Verification and remaining gaps

Six controller tests and five existing monitor transport tests passed. They exercise explicit start, serial paging, same-cursor retry/backoff/Retry-After, retry limit, terminal failures, cross-panel queueing, cancelled queued jobs, hidden/offline pause and late-result suppression, page limit, repeated cursor and anchor/missing-progress rejection.

Eleven real Miniflare authenticated API tests passed, including exact saved-page reuse without a provider call or duplicate write, unchanged manual refresh behavior, invalid flag/index scope and project revision drift. The retained-cursor fixture now returns the requested cursor explicitly, matching the strengthened contract. One server-render test verifies the controls and foreground/retained-time disclosures. TypeScript and scoped lint passed.

Browser visual and live multi-page QA remain outstanding after the prior localhost browser policy rejection; no browser workaround was attempted. Loaded history remains limited to the existing twenty returned pages, and activity totals describe those loaded records. Current account discovery can miss closed/reassigned accounts. Full wallet/holder history and continuous background alert classification remain incomplete. No real provider call, credential access, signature, submission, migration or deployment occurred. Claude's protected watch/holder and test-reliability files were untouched. Full Proxima parity remains active.

Final production build passed all five stages; existing large client chunk warning remains.
