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

## Completed UI coordination and independent review

Claude merged873ebd1 into PR27, built the panel and posted the exact mount patch in [this comment](https://github.com/Jesuslikex/bundle-tek/pull/27#issuecomment-6255872690). Codex checked the canonical owner file and explicitly approved only the new import and sibling panel in `components/account-launch-evidence.tsx`. Claude applied those two lines on his PR branch asd5cf0f8; root did not edit his UI or its tests. The approved mount is exact. The panel is a sibling of Saved buy costs in launch evidence, not nested inside the purchases panel.

The first UI checkpoint06dfe62 had three independently reproduced failures: an uncaptured sale hit allocation GET404 before exposing capture; a lost record response left another Save enabled; changing reviewId for the same mint retained prior approval. Three isolated adversarial tests failed before the fix and all passed at6f9dc7f. Claude's source fixba87601 and regression commit6f9dc7f defer allocation reads until capture, keep exact pending sale/hash with no second record before GET recovery, reset on context changes and guard late publications. Response bodies are now streamed, capped and cancelled. Root retained before/after logs under `work/pr27-ui-06dfe62/work/release-qa/`; the additional probe is ignored, not a production-source change.

Readable token amounts arrived in156ca52. Codex flagged the new formatter's malformed-unit render failure; Claude fixed it ina88dea1 by reusing the original importedTradeReceipt parser before state publication, requiring matching project/mint/six decimals, at most50 rows and a valid next cursor. A new malformed-row regression passes. No original server parser, signing rule, provider or migration was changed by these UI fixes.

Independent final checks:

- All98 tests across eight capture/model/service/API/UI files pass together at6f9dc7f, terminal0 in322.69s. This includes the real local-SQL HTTP capture→review→wrong-hash refusal→exact approval→record→reload test. Only synthetic finalized receipt RPC is used; the capture adapter's real mocked HTTP transport is covered separately. No additional provider reads or sends occur during allocation approval/reload.
- Finala88dea1 has16 passing tests across the sale panel and mounted parent, plus full plain TypeScript and scoped typed lint. The five reviewed UI/client/CSS Git blobs pass formatting. Windows checkout-only CRLF differences were checked against LF Git blobs without editing Claude's source. An initial TypeScript error was in the extra ignored Codex probe's Element.checked annotation; fixing that test-only generic produced the final full terminal0 TypeScript result. No production TypeScript error was waived.
- Actual component/CSS browser fixtures at375/1440 pass capture, initially unchecked consent, disabled unapproved save, explicit save and saved-only reload. Finala88dea1 renders human token amounts beside raw units and the1,000,000-unit conversion. Phone width375 has document scrollWidth360, no horizontal overflow; product actions and amount input are44px high. The lost-response scenario at6f9dc7f ends with GET7/Capture1/Review1/Save1 after explicit recovery. Final normala88dea1 flow also ends GET7/Capture1/Review1/Save1. No automatic POST/retry occurs.
- Browser artifacts use synthetic data and a previous isolated production-build theme. This is component-level browser proof, not a signed-in production test. Screenshots: `docs/qa/20261018/sale-review-1440.png` and `sale-saved-1440.png`. Harness/source hashes/facts remain in ignored `work/pr27-sale-ui-qa`. The viewport override was reset; the owned temporary server is stopped after capture.
- All eleven frozen peer source/docs files still match WIP9ab3725 byte-for-byte under Git normalization; the peer AGENTS claim remains uncommitted and unstaged. All current capture commits are on origin/main, and all Claude implementation/mount/fixes are on PR27. No overlapping application edit, force push or merge was performed.

## Release hold

Superseding update: the user subsequently approved a source-only merge. PR27 merged as `ad08571`; the code-merge hold is resolved, while production migration verification remains a release requirement. See `CODEX-PR27-MERGE-20261018.md`. The paragraph below records the earlier review checkpoint, not current PR status.

Reviewed PR head: `a88dea1e60328eff941049e9ebe4afb2033bd6e1`. The local capture and approval flow is implemented and checked. Keep PR27 draft and0116 held. Hosted migration state remains separate; no application/hosted migration, deploy, real wallet unlock, funded trade or transaction is authorized by this task. No full regression/build on the final PR, profit calculation, live-chain sale capture or funded proof is claimed. Those are not replaced by synthetic browser/API evidence.
