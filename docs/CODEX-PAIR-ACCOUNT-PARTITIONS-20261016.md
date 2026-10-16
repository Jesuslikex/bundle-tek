# Review prototype: five-account stock evidence partitions

## Problem and proposed admission

QuickNode's free trial refuses the existing seven/eight-account wallet read. Transport cap prerequisite: `f3e6f0f`. This separate collector is deliberately not wired into the stock runtime or production service. Review its observation semantics before changing those consumers.

`collectPairAccountPartitions` makes concurrent full-account reads with at most three original non-Clock positions plus two actual Clock copies per provider request. It must be composed with a request-scoped `createPairReadRpc` transport using maximumAccounts5. The integration test exercises that real transport with mocked HTTP, including actual method pacing and original wire account positions. No provider call was made in this change.

Each response passes the existing stock Clock wrapper: exact or+1 Clock/context relation, duplicate agreement, 30-second wall-time bound and requested floor/32-slot bound. All partitions must then have exactly the same raw context slot and complete canonical Clock account. Mixed contexts or differing Clocks refuse the whole collection, even when each response is individually valid. There is no retry, fallback, maximum-slot relabeling or synthetic merged JSON-RPC response.

The returned evidence retains original positional indexes, each scoped response, and each actual provider request/response including both Clock values. Non-Clock duplicates are preserved. The aggregate retained provider envelopes must fit the existing512KiB ordinary response budget. This new collector is for full wallet accounts only, not sliced code. Group signing and its one-at-a-time code reader are untouched.

## Verification

Node24.19.0: seven files,137 tests passed together: pair-account-partitions, pair-account-partitions-transport, pair-read-rpc, pair-stock-clock, imported-pair-runtime, pair-runtime-ordering, pump-group-code-identity. Plain `tsc --noEmit`, five-file typed lint and formatting pass.

New coverage includes actual five-account wire calls with duplicate Clocks, original-position mapping and duplicates, raw context versus+1 effective Clock evidence, mixed-slot refusal, cross-partition Clock disagreement, stale floor, incomplete results, within-response Clock disagreement,+2 refusal, provider failure, aggregate size and pre-cancellation. Existing transport tests cover reordered/partial batch mapping and bounded stream cancellation. No full-suite, build, browser, live latency or new qualification result is claimed.

## Remaining integration and limitations

Consumers still expect single RPC envelopes. A subsequent reviewed change must consume partition evidence explicitly, preserve the later effective slot for every floor/span, propagate every actual observation into qualification receipts, and close the transport on cancellation/refusal. Any sliced inventory/code request above five must be addressed separately without removing identity reads, byte bounds or the final code recheck. This prototype cannot yet make the existing qualification campaign pass.

Same-slot admission can fail when the node advances between chunks. That is an intentional refusal, not a reason to merge different slots or loop until a pass. Only after reviewed integration should a new fixed three-SOL/three-USDC campaign run, retaining every outcome. Initial minimum output, fresh-reference tolerance, writable custody checks,32-slot ceiling and signing gate are unchanged. No UI ownership files, provider settings, credentials, migrations, cron or deployed release changed.

## Scope audit follow-up

The collector now requires exactly one original Clock position, matching the actual wallet reader's unique scope. Previously, multiple original Clock positions could be collapsed while partitioning. Rejecting such requests before IO prevents losing requested observations. Added zero/two/three-original-Clock refusal tests and controlled cancellation while both reads are pending. Both partition test files pass,17 tests. Production remains unconnected.
