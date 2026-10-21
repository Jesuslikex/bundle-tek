# Owned warmup journal API

`/api/wallet-workspace/warmup/session-journals` now connects existing immutable journals to authenticated requests. It records recovery metadata only; it does not start an automatic session, authorize an order, sign or submit a transaction.

## Contract

- `POST {operation:"record", id, consentId, termsSha256, recordRequested:true}` records the exact owned consent-bound root, or recovers that original ID. The old consent and original source-review deadline are preserved. This requires an explicit metadata-recording request, not a new or implicit execution approval.
- `POST {operation:"control", id, journalId, expectedVersion, expectedHeadSha256, control}` accepts only `begin-review`, `pause`, `resume` or `stop`. The UUID `id` identifies this one command. The existing journal writer provides exact original-command replay, head compare-and-swap, immutable event storage and one-write lost-response recovery. Resume cannot revive Stop.
- New `begin-review` actions are selected by the server from the replayed source. The client cannot choose an action, amount, wallet, receipt, timestamp or settlement. The current plan/wallet revision/archive/document are prechecked. Final preparation and future signing must repeat their own insertion-time source/runtime checks; a review slot is not a reservation or permission to execute.
- `GET ?id=<journal UUID>` or `GET ?consentId=<plan approval UUID>` returns verified historical progress without writes. Exactly one selector is allowed. The second form finds an existing owner-scoped journal if a local journal reminder was lost; it never creates one. Optional `eventId=<command UUID>` returns the exact accepted command receipt or `null` if absent. Without it, `commandReceipt` is null, including a recovered record response. GET does not imply permission to replace/retry an unconfirmed command. Historic progress can be recovered after expiry/archive; no deadline is renewed.
- Responses whitelist identity, version/head, phase, pending action summary, original deadline, wallet budget accounting and a compact command receipt. Internal plan/source/context/proof/raw-event documents and transaction bytes are omitted. All authority flags remain false.

Both methods authenticate before storage. Writes require exact same origin, JSON media type, strict fields/canonical UUIDs and at most2048 UTF-8 request bytes. Responses are no-store. Cancellation retains original identity recovery and never grants a replacement write; unexpected errors return a fixed503 message.

## Verification

The final 24-file related run passes **603 tests**. The39 new real HTTP/production-Turso-adapter cases cover authentication, owner isolation, strict input/media/size/query handling, forbidden client execution labels, cancellation, server-derived review, pending holds, immutable consent/root identity, pause/resume/terminal Stop, stale/concurrent heads, changed plan/wallet/archive, exact-ID lost-root-response and post-command-cancel recovery, historical expiry reads, missing command receipts and sanitized storage failures. Provider fetch is forbidden in these tests; no funded action or live RPC occurs.

Plain `tsc --noEmit --incremental false`, three-file typed lint and formatting pass. Source freeze: `work/release-qa/warmup-journal-api-freeze-20261021.json`,2696files, digest `8cf06964faa34f79e815b5c10e2eb9a962fbd6a48f544586de34a69e1c0fbf5c`. No SQL changed, so the prior131-migration checks are not rerun or claimed as a new check. No production build, signed-in rendered Bundle session, real provider, full repository suite or deployment is claimed.

## Remaining work

The new endpoint is not yet wired into the wallet warmup UI. Real quote/simulation preparation and its strict API/DTO, request deduplication/pacing, shared wallet/lot reservations, short authorization, browser signing, scheduler and running/completed multi-wallet UI remain open. Original60-second source preview and every signing prohibition stay in place. A successful journal response must never be rendered as an automatically running session.

The initial checkpoint changed no migration. The additive source-only finish guard below was added after review. No protected Claude UI files, provider, credential, cron, application/hosted SQL, deployment or real wallet was changed.

## Opus review and accepted changes

Actual `claude-opus-5-5` reviewed committed `e45aef5` read-only with Read/Glob/Grep, zero denials, no delegation/tests/edits, and unchanged2136file source-copy hashes. The final result succeeded. Original logs/status remain under ignored `work/release-qa/opus-journal-api-review-e45aef5-20261021/`.

It found M1: opening review was constrained by the source preview but not the user's own possibly-earlier session finish. The fix keeps both original dates and returns `effectiveReviewExpiresAt = min(source preview expiry, approved session finish)`. `sourceReviewFresh` and the review-required phase now respect that effective boundary. Historical source/head documents are not rewritten. New begin-review, binding and preparation writers check it, including after asynchronous work; additive0131 repeats the approved finish at journal/binding/packet insertion using the SQL clock. Missing write guards refuse new work. Late settlement evidence, historical reads and Stop remain available after expiry.

The four low notes are also addressed: new IDs cannot redundantly Pause/Stop; unrelated command receipts are omitted; owner-scoped consent lookup recovers a lost journal ID; and concurrent same-ID/same-command writes return the first accepted event even with different server timestamps. Header/predecessor/operation/action identity must still match exactly, so a different command under that ID refuses. No provider, INSERT or action retry is added.

Read scope: full new diff, journal storage/replay/sequence, wallet request parser,0124 SQL and handoff; selected consent/view/storage/preparation/binding code. It did not reread0125 settlement SQL, full settlement writer, actual authentication implementation or fixture bodies, and ran no tests. The later fix is independently tested by Codex; its targeted follow-up review is pending until recorded below.

## Final local verification of the finish fix

The final24-file related run passes **619 tests**, including47 API,35 journal,56 preparation,34 binding and27 verified settlement storage cases. New tests prove the exact millisecond finish boundary, a shorter consent deadline while the60-second source remains fresh, quote work crossing the finish, direct SQL late review/binding refusal, unchanged late Stop/history recovery, guard availability, duplicate control capacity and first-event recovery with competing timestamps. All provider/signature fixtures are synthetic; no real wallet or live quote is used.

Plain TypeScript,13-file typed lint and14-file formatting pass. All132 migrations apply to a fresh disposable checksum-runner database (736 schema objects) and the real whole-file Wrangler CLI; the ledger matches and exit0. Final Wrangler report: `C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-2eN20O\report.json`. The application and hosted databases were not touched.

Final source freeze: `work/release-qa/warmup-journal-finish-verified-freeze-20261021.json`,2699files, digest `85f8d815f786974874ee312c90a88b4fb78088d39fa0b19227210d853b568feb`. Verify unchanged before committing. Earlier frozen checkpoints are retained as historical evidence, not the final candidate. No UI, automatic execution, short signing authorization or full-product parity is claimed.
