# Scheduled unsigned session preparation

The authenticated application can retain preparation jobs for exact saved Buy/Sell session entries. A job is not signing or submission authority. The shared preparation service checks owned current project/wallet revisions, due times, active session controls, balances, route and independent simulation before saving an unsigned packet. Existing signing review still rechecks packet identity and chain context; the user supplies each signature and explicitly submits separately.

## Local workflow

Open a saved session's unsigned preparation jobs. Queue an entry, then choose Prepare next due job to process at most one eligible job for that owned session. Reload jobs to see background results. Prepared entries open their retained unsigned packet through the actual swap preparation review. Expired packets return 410 and require a new job. Historical preparation summaries do not contain raw bytes; the dedicated prepared job stores a bounded public unsigned payload.

GET/POST `/api/imported-projects/session-preparation-jobs` requires the authenticated owner. Reads and packet restoration are scoped by project/session/job. Packet restoration refuses stale project/wallet context, paused/cancelled/busy entries and expired quote/balance captures. It reports the remaining wallet-read gate before eligibility review. No keys or credentials are stored in a job.

GET `/api/imported-projects/session-job-events` reads immutable captured transitions. Optional projectId/sessionId scope requires an owned retained project/session, including archives. A cursor must belong to the same owned scope. Pages contain at most fifty events; captured entry, state, attempts, preparation ID and safe error code are shown without reconstructing historical trade amounts from current records. Reads do not prepare, sign or submit transactions.

POST with action=cancel, id, projectId and sessionId cancels one owned queued/running job. Repeated cancellation returns the retained cancelled row without another transition. It remains available after parent pause/archive. Completed terminal jobs cannot change. Cancelling clears the lease and prevents late responses from persisting a prepared job result. An already started unsigned provider operation may finish; cancellation does not revoke a signature or affect a submitted transaction.

The job panel also provides explicit Start/Stop live preparation status. It reads saved scoped jobs every five seconds after a successful read and backs off failed reads up to thirty seconds. Hidden/offline/mutating panels suspend reads; closing stops the feed. Changed valid snapshots refresh the retained timeline. Status reads do not process a job or enable the background worker.

## Background worker

`workers/session-preparation.ts` contains a scheduled handler and no public execution endpoint. `wrangler.session-preparation.jsonc` is a release template with a placeholder D1 identity, minute cadence and `SESSION_PREPARATION_ENABLED=false`. It is not deployed. The dry run verifies bundling only.

An authorized release must replace the placeholder with the application's actual D1 database, apply migration 0062 after the existing migrations, configure the same Jupiter and dedicated Solana RPC server secrets, and validate the worker/provider environment before enabling scheduled processing. The application and worker must use the same retained data. Keep secrets in the platform's secret store. Do not place credentials in the JSON configuration or client build. Enabling a worker is separate from approving any transaction.

Each tick processes at most two due jobs; the foreground action processes one. Claims use database time, exact control revisions, a 45-second lease and a unique token. Only one live worker job per owner is admitted. Expired leases requeue after 30 seconds, with at most three attempts. A replaced/expired token cannot persist a late result. Provider rate-limit/service failures retry; invalid current context and insufficient/unsupported balances are terminal. Cancellation/archival cancels queued work. Pause keeps queued work waiting and invalidates a preparation result that crosses a control-revision change.

Migration 0062 stores jobs and immutable captured transition events. It enforces immutable identities and terminal records, one queued/running job per owned entry, current owned admission, due claims, retained packet/preparation binding and event rollback. Storage is bounded to 100 jobs per owner/project and existing preparation history limits. Job lists expose neither lease tokens nor raw packets. Completed packet retrieval is a separate authenticated operation.

## Remaining verification

The local API/SQL, cryptographic fixture review and rendered synthetic flow are verified. The disabled worker handler and bundle are checked. Production bindings, scheduler deployment, provider-backed background operation, real user-wallet approval and funded execution remain unverified. Retained job events are connected to the saved-session job timeline and account Activity with owner-scoped cursor pagination. No automatic funded execution is implemented.
