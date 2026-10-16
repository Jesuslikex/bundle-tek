# Opt-in stock transport account cap

The observed QuickNode trial limit is five accounts per actual getMultipleAccounts call. The existing transport could coalesce individually small requests into a larger account request.

`createPairReadRpc` now accepts a server-only optional maximumAccounts argument. Default100 preserves every existing caller. Explicit5 rejects oversized requests before provider IO and prevents coalescing beyond five. JSON-RPC batches still pace the actual method count. Response order, floors, aggregate byte limits, cancellation and fail-closed behavior are unchanged. No caller opts in yet; this is a prerequisite for a reviewed partition collector, not a live compatibility claim.

Verification: 58 transport tests and eight stock Clock tests pass. Invalid limits, oversize ordinary/code scopes before IO, actual coalescing scope and method-counted pacing are covered. Plain TypeScript and scoped typed lint pass. No UI, group code reader, provider setting, credential, migration, network call or deployment change. Stock signing remains off.
