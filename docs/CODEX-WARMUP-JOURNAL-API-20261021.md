# Owned warmup journal API

`/api/wallet-workspace/warmup/session-journals` now connects existing immutable journals to authenticated requests. It records recovery metadata only; it does not start an automatic session, authorize an order, sign or submit a transaction.

## Contract

- `POST {operation:"record", id, consentId, termsSha256, recordRequested:true}` records the exact owned consent-bound root, or recovers that original ID. The old consent and original source-review deadline are preserved. This requires an explicit metadata-recording request, not a new or implicit execution approval.
- `POST {operation:"control", id, journalId, expectedVersion, expectedHeadSha256, control}` accepts only `begin-review`, `pause`, `resume` or `stop`. The UUID `id` identifies this one command. The existing journal writer provides exact original-command replay, head compare-and-swap, immutable event storage and one-write lost-response recovery. Resume cannot revive Stop.
- New `begin-review` actions are selected by the server from the replayed source. The client cannot choose an action, amount, wallet, receipt, timestamp or settlement. The current plan/wallet revision/archive/document are prechecked. Final preparation and future signing must repeat their own insertion-time source/runtime checks; a review slot is not a reservation or permission to execute.
- `GET ?id=<journal UUID>` returns verified historical progress without writes. Optional `eventId=<command UUID>` returns the exact accepted command receipt or `null` if that command is absent. GET does not imply permission to replace/retry an unconfirmed command. Historic progress can be recovered after expiry/archive; no deadline is renewed.
- Responses whitelist identity, version/head, phase, pending action summary, original deadline, wallet budget accounting and a compact command receipt. Internal plan/source/context/proof/raw-event documents and transaction bytes are omitted. All authority flags remain false.

Both methods authenticate before storage. Writes require exact same origin, JSON media type, strict fields/canonical UUIDs and at most2048 UTF-8 request bytes. Responses are no-store. Cancellation retains original identity recovery and never grants a replacement write; unexpected errors return a fixed503 message.

## Verification

The final 24-file related run passes **603 tests**. The39 new real HTTP/production-Turso-adapter cases cover authentication, owner isolation, strict input/media/size/query handling, forbidden client execution labels, cancellation, server-derived review, pending holds, immutable consent/root identity, pause/resume/terminal Stop, stale/concurrent heads, changed plan/wallet/archive, exact-ID lost-root-response and post-command-cancel recovery, historical expiry reads, missing command receipts and sanitized storage failures. Provider fetch is forbidden in these tests; no funded action or live RPC occurs.

Plain `tsc --noEmit --incremental false`, three-file typed lint and formatting pass. Source freeze: `work/release-qa/warmup-journal-api-freeze-20261021.json`,2696files, digest `8cf06964faa34f79e815b5c10e2eb9a962fbd6a48f544586de34a69e1c0fbf5c`. No SQL changed, so the prior131-migration checks are not rerun or claimed as a new check. No production build, signed-in rendered Bundle session, real provider, full repository suite or deployment is claimed.

## Remaining work

The new endpoint is not yet wired into the wallet warmup UI. Real quote/simulation preparation and its strict API/DTO, request deduplication/pacing, shared wallet/lot reservations, short authorization, browser signing, scheduler and running/completed multi-wallet UI remain open. Original60-second source preview and every signing prohibition stay in place. A successful journal response must never be rendered as an automatically running session.

Opus5.5 review is pending against the committed checkpoint; its final findings and limits will be added after delivery. No protected Claude UI files, migration, provider, credential, cron, application/hosted SQL, deployment or real wallet was changed.
