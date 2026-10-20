# Auto Sell exact edit review engine

20 October 2026. Engine checkpoint only; the modal does not expose Edit yet.

An existing session must be paused and every pending read/sell settled before an edit can be reviewed or applied. Review retains a detached configuration and exact session evidence. Applying requires the exact retained review key and explicit approval; cancellation, resume, changed progress or a newer review invalidates the old approval. Applying remains paused and does not unlock another wallet or resume execution.

Sold amounts, uncertain spending, completed limit-order identities and original elapsed clocks survive edits. Removing a strategy retains its accounted spending against the shared cap and permanently retires its identity. Removing a queued strategy explicitly cancels its unsent queue. Queued limit rows cannot be rewritten in place. Lower per-strategy limits clip existing queues before a later sell. An approved limit below already consumed budget can end the session immediately. Changing the initial delay cannot restart it.

The difference formatter exposes changed settings, removed/added strategies, priority changes and replacement limit-order identities even when their price and size match. This formatter is preparation for the UI, not an approval surface by itself.

Verification: all 10 Auto Sell test files pass together, 80 tests. These include 15 engine edit cases and four difference-format cases. Typed lint and formatting pass for the five implementation/test files. Tests use controlled clocks and synthetic feeds/execution; no provider request, real wallet unlock, signing or transaction occurred. Whole-project TypeScript (`tsc --noEmit --incremental false`) passes.

Next: add the modal's before/after review, initially unchecked approval, invalidation on draft changes, cancel/close restoration, and separate Resume action. Verify the actual component on desktop and phone before claiming the edit feature is available. No deploy, hosted SQL, provider, credential or cron change is included.
