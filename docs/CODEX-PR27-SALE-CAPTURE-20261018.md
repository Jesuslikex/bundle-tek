# PR27 sale evidence capture and review

User scope: independently check PR27, coordinate with Claude and finish capture and explicit acquisition approval without overlapping. No deployment, funded trade, hosted SQL or provider/credential changes.

## Agreed ownership

Confirmed directly in Claude's active Opus5.5 thread and on [PR27](https://github.com/Jesuslikex/bundle-tek/pull/27#issuecomment-6255587062):

- Codex: new sale-evidence route, bounded RPC adapter and capture HTTP tests.
- Claude: selection/approval UI, client admission tests and the sale-allocations route. Claude will provide the exact purchases-panel mount patch before editing it. His real-SQL allocation HTTP test may be extended to include the new capture endpoint. Neither agent edits shared schema/services without coordination.
- The peer chat confirmed its original0116 draft is frozen WIP. Its twelve canonical dirty files remain intact and unstaged. PR27 carries Claude's verified continuation; root does not replace that draft.

## HTTP contract

`GET /api/account-launch-activity/sale-evidence?saleReceiptId=<uuid>` reads retained evidence only. `POST` to that path accepts exactly `{ "saleReceiptId": "<uuid>" }` and explicitly captures original finalized Sell evidence. Both return the existing service's public summary directly:

```ts
{ receiptId, mint, wallet, entry: null | {
  sha256, observedAt, slot, tokenUnitsRaw, networkFeeLamports,
  nativeSettlementRaw, executionAllowed: false, profitCalculated: false
} }
```

Sign-in, exact ownership/source registration, same-origin JSON writes,1KiB body,5-second body deadline,30-second operation deadline, existing per-owner/per-receipt5-second gate and immutable0115 storage apply. The transport initializes only after source admission, and saved-only retries do not read a provider. One lazily pinned server endpoint uses ordinary wallet pacing; only mainnet genesis and exact finalized base64 transaction reads are admitted. Responses are capped at512KiB with lossless integer parsing, no redirects or retries. Unknown failures return a static error. Cancellation returns408 and advises saved-only recovery. Raw signed evidence stays server-internal. No new schema or execution authority.

Claude's UI discovers finalized Sell IDs through the existing imported-project receipts route and buy origins through purchases history. Capturing evidence and approving an exact allocation are separate actions.

## Independent checks

Review baseline: exact PR head `6ac62316124f4219df19297ca34660a116bcb02c`, isolated clone under ignored `work/pr27-review-6ac6231`. All37 tests across the allocation model, real allocation service/SQL and allocation HTTP route pass. Read the model, service, API and0116 triggers independently: owner/source replay, global origin intervals, integer conservation, old-ledger exclusion, atomic trigger checks, exact-hash consent and saved-only recovery remain enforced. No blocking finding on that baseline; this is not approval of later UI changes or a full-suite pass.

Capture verification:52 tests across four files pass, including14 new route/transport tests. Real local SQLite uses historical table definitions and the actual0115 triggers, real capture service/parser and synthetic finalized HTTP receipts. Tests cover empty history, exactly two read methods, retained retry/reload without RPC, owner/Buy refusal before gate/RPC, invalid origin/body/query, unavailable schema/network/receipt,429 without retry, gate retention after failure, lost insert response, committed insert followed by cancellation, stalled-body cancellation/deadline and late transport completion without retention. Original finalized parents are explicitly seeded; historical signing admission and live chain behavior are not claimed.

Standalone TypeScript for the new capture import closure and scoped typed lint pass. All four new TypeScript files pass formatting. Runtime logs/configs live only in ignored work folders. No environment file is copied into the review clone, and an offline preload blocks unmocked external sockets/fetches during tests.

Follow-up independent checks on the same PR baseline plus capture overlay: full plain `tsc --noEmit --incremental false` passes, and the real whole-file Wrangler command applies all117 migrations to a fresh disposable D1 database with an exact117-entry ledger match. Logs: `work/pr27-review-6ac6231/work/release-qa/pr27-full-typecheck.log` and `pr27-migrations.log`; migration report/state retained at `C:\Users\Julian\AppData\Local\Temp\bundle-wrangler-migrations-YEqiOj`. The Node offline preload also propagates to Wrangler child processes. No application or hosted schema was changed. The earlier committed0008fb8 full regression has also reached terminal success:603 files,5329 tests, zero failures, native script exit0 and unchanged source/harness. That older source does not cover PR27 or the capture additions.

## Remaining integration

Claude must merge this checkpoint into PR27, finish client admission/selection/approval UI and supply its mount patch. Independently rerun the combined HTTP capture→review→wrong-hash refusal→explicit save→reload regression and render the completed screen. Keep PR27 draft and0116 held. Hosted migration state remains separate; no migrations or deploy are authorized by this task. No profit, real signing or funded proof is claimed.
