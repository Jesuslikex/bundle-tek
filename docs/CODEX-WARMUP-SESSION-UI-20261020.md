# Warmup session review panel

20 October 2026. Follows `165ce2b`. This checkpoint adds a usable review surface, not automatic execution.

The selected active Solana plan now offers **Review automatic session** alongside recorded cycle progress. The panel fetches only after that click and posts only the saved plan id/revision. It shows the remaining action count, original/effective start, total and per-wallet maximum further spend, remaining buy inputs/reserve and already-counted costs. An expandable list displays buy inputs and exact saved-lot sell sources; future buys' acquired quantities remain unknown until their finalized receipts. Actions are paged in groups of 20 with continuous numbering.

The client parses the bounded public context and reruns the same pure session builder, binding it to the exact displayed saved plan. Changed amounts, action vectors, wallet revisions, authority flags, expiry, scope or context are refused. Canonical comparison tolerates JSON object key ordering. This is a consistency check on the authenticated server response, not independent on-chain verification or a cryptographic authorization. All authority flags remain false. Display lifetime is capped at 60 seconds locally even if the server clock is ahead; stock/runtime Clock rules are unchanged.

Cancel, context replacement, receipt updates, storage changes, page exit and expiry discard the review without an automatic request. Late responses cannot repopulate a cancelled or replaced context. HTML and timeout failures produce controlled messages with a manual retry. The panel contains no password, approval checkbox, wallet unlock, signing, submission or Start control. It states that automatic Start is unavailable and leaves the existing manual transaction flow intact.

## Verification

- 11 related files and 142 tests pass together. New coverage includes 16 public-view admission tests and 11 component lifecycle/error/pagination tests. The DOM timeout test initially exposed cross-realm error classification; the component now recognizes timeout names without relying on `instanceof Error`.
- Whole-project TypeScript, typed lint and seven-file formatting pass. Final isolated production build passes (`165ce2b` plus the seven owned source/test/style overlays, exit 0 and unchanged source hashes).
- Existing Chrome rendered the actual component/CSS with a synthetic public-plan context. The desktop view shows 26 remaining actions for one wallet and exactly 0.023 SOL further budget: 0.013 SOL inputs plus 0.01 SOL reserve. An HTML response shows a usable error; manual retry restores the review. No provider or database is used by this browser fixture.
- At 375x812, document client/scroll widths are 360/360, panel widths are 326/326 and review/dismiss/pagination controls are 44px high. The second action page contains six entries and reports actions 21 to 26. Original Proxima tab and viewport restored. Local screenshots: `work/warmup-session-ui-browser-20261020/session-review-desktop.jpg` and `session-review-phone.jpg`.

The existing manual buy/sell component workflow and the read-only owner API tests pass in this cohort. No real signed-in browser/API integration, live-provider qualification, full-suite run or funded proof is claimed. No protected shell/token-layout file, schema, provider, credential or cron setting changed. No deploy or funded action occurred.

Next: durable exact session approval and action/budget state, scheduler, fresh per-signature authorization, one-send/finalized-receipt dependencies and cancellation/unknown-outcome recovery. Full Proxima parity remains open.
