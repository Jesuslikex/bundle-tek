# Exchange order history UI work notice

## Implemented checkpoint

Authenticated GET `/api/funding/exchange-orders` now reads either one saved order (`id`) or a page for an owned funding draft (`planId`, optional owned `before` cursor). It has no POST handler or provider/RPC adapter. Responses are `no-store`; ambiguous, duplicate and unknown query parameters refuse. Authentication supplies the owner; request parameters cannot choose an owner or provider reference. Unexpected storage failures return a fixed message.

History pages use one bounded list query (10 items plus one lookahead), with separate owned plan/cursor admission. There is no per-item database fanout. Same-time reviews use descending immutable ID as the tie-breaker. Every returned review is revalidated against its owner-bound content digest. Archived/edited plans and old wallet revisions do not hide historical records. Cursor IDs from another owner or funding plan refuse.

The public projection contains the saved native SOL quote, historical receiving/refund wallet, human-readable stage, retained-attempt/report metadata and an independently retained payout receipt summary when present. Private exchange IDs, rate IDs and deposit addresses are excluded. A list's `receiptRetained` means a record exists, not a new verification claim: opening detail runs the existing immutable stored-receipt checks, then returns only the exact wallet/amount/signature/slot/read-time summary. It performs no new RPC verification and never treats a historical receipt as current spendable balance.

The Codex-owned funding panel mounts a collapsed saved-order section independently of provider setup and quote eligibility. Opening it explicitly reads saved records; no quote, exchange order, provider lookup, payment or signing request is made. Older pages append, exact order detail opens in place, changing funding-plan context aborts old work, closing cancels pending reads and a 401 clears private history. HTML/empty/error responses cannot surface parser text. Empty history explains that a quote is not an order. Uncertain creation, verification requests and unverified payouts/refunds have distinct messages; there is no unsafe retry/deposit button.

The saved-quote card also displays its own historical funder explicitly, separately from the current draft's receiving address. This fixes a misleading context when the user has changed the current funder after an earlier quote.

Authority remains unchanged: order creation, deposit instructions, funding, signing, execution and retry creation are false in the API projection. Existing five-second approval, one-attempt hold, custody checks and receipt rules are untouched. No schema migration, provider/credential configuration, hosted SQL, live order, wallet unlock, real signature, funded transaction, push or deploy occurs in this checkpoint. Exchange creation, live provider contract qualification, deposit/refund proof and the separately approved distribution handoff remain incomplete.

## Verification

- Nine targeted exchange/quote/payout/API/UI files: 221 tests pass on pinned Node 24.
- Existing real libSQL service fixture exercises bounded/tied pagination, another owned plan's cursor refusal, foreign ownership, archive/wallet changes and exact payout detail projection without new RPC calls or private reference leakage.
- New route tests exercise authenticated owner forwarding, duplicate/ambiguous query rejection, no-store and safe storage/domain errors. Route boundary tests use explicit service doubles; they are not an authenticated full HTTP/database test.
- Mounted React tests exercise explicit-open reads, historical wallets/amounts, uncertain-order copy, verified receipt links, no payment actions, safe HTML errors and explicit reload, invalid context/authority refusal, cancellation/late response, pagination and sign-out clearing. Saved-quote test covers changed current funder. These are DOM behavior checks, not visual layout evidence.
- Plain TypeScript, 11-file scoped typed lint, 12-file formatting and staged whitespace checks pass on frozen source. Code checkpoint: `e75b634`.
- The other Bundle chat ran the combined production webpack build (live handle 98528, exit 0): compilation 58 seconds, Next TypeScript 64 seconds, six static pages and final route tracing passed. It includes frozen `e75b634` plus that chat's Volume checkpoint `96d0ce1`. The isolated Claude token-layout branch is excluded.
- After the normal guarded HTTPS app was restored, Codex independently checked anonymous GET `/api/funding/exchange-orders?planId=test`: 401 with `Cache-Control: no-store`; `/sign-in`: 200. No account, provider or stored history data was read by those anonymous requests. This verifies route presence/authentication, not a signed-in rendered order-history workflow.
- No new rendered desktop/phone or authenticated production check is claimed. The earlier automatic-review rejection for restarting the isolated chart QA server/CDP attachment has not been retried or worked around. The separate token UI candidate remains unmerged.

Codex owns this bounded continuation of Smoke-style exchange funding. Planned UI edits: `components/launch/exchange-funding-review.tsx` plus a new scoped `exchange-order-history.tsx` and CSS module/tests. No Claude shell/token/market/pool styles, wallet/vault files or global CSS will be edited.

Add authenticated read-only saved order history and exact receipt detail. No exchange order creation, provider lookup, RPC receipt collection, deposit instructions, payment, signing or distribution action is exposed. Existing order and execution authority flags remain false. Reads must remain useful when providers are disabled or drafts are archived/changed. No migration or hosted SQL is planned.

The separate Claude token UI branch `9f95a1a` remains isolated and not merge-ready pending final client-shell browser proof. The other Bundle chat owns wallet-save recovery and its current staged/dirty files must remain untouched. Coordinate the shared index and build before committing or building.
