# Saved marketplace evidence pages, 24 October 2026

This checkpoint adds a separate saved-only inspector after the typed full-inventory capacity refusal. It does not make the complete inventory scalable or enable listing, payment, reservation, delivery, signing or execution.

## Behavior

The authenticated GET `/api/marketplace/saved-evidence` returns at most 20 current saved Solana wallet records or 20 retained history records for one exact selected wallet/revision. Keyset cursors are bound to the view and selected address/revision. History document bodies are restricted to a 4 MiB UTF-8 prefix by SQLite before transfer; each actual returned document also passes the unchanged retained-run schema and one-wallet inventory projection. No raw documents, other-wallet observations, private keys or raw error text are returned.

All control, lifecycle, complete-inventory, complete-history, listing, payment, delivery, signing and execution flags are false. Current saved metadata is not proof of control. Captured revisions and timestamps do not prove lifecycle continuity or wallet age. Historical raw lamports are not a current balance; successful signature samples are not decoded trades or funding counts.

Both inventory parents mount a passive disclosure only after the existing strictly typed capacity refusal. Opening disclosures does not fetch. Loading, selecting a read target and requesting its history are separate actions. The read target never becomes the seller-review selection. Next/back reads replace old rows, closing/canceling/unmounting aborts pending requests, and stale responses cannot repopulate them. Authentication and changed-wallet refusals require explicit recovery. Clock mismatch has a fixed device-clock explanation. No automatic provider reads or writes are added.

## Correction and remaining limits

The existing history writer already admits fewer than 100 retained owner runs. A normally admitted 101st run is not the ordinary cause of this capacity refusal. The 101-run fixture is deliberately seeded legacy data, bypassing only fixture setup, not an application admission change. The existing full-inventory byte cap and legacy/imported over-cap data remain relevant. The writer, complete inventory and all financial eligibility guards remain unchanged.

These are partial matching saved records, not one complete or atomic cross-page snapshot. SQLite JSON membership uses first-key semantics while JavaScript JSON parsing uses last-key semantics for duplicate keys. Conflicting legacy data can therefore be absent from SQL matches or refuse when reached. The inspector does not claim that nothing is skipped. Malformed matching data blocks its attempted page; it is not silently accepted. A bad hidden sentinel or post-byte-cut metadata item cannot block an earlier valid prefix, but refuses once actually reached. SQL still scans matching metadata; body/row limits do not establish bounded database scan work.

Printable ASCII legacy IDs, including spaces and punctuation, round-trip through canonical cursors and SQLite binary ordering. Other malformed IDs refuse when reached. Large duplicate-key capacity fixtures are synthetic legacy canaries, not normal writer output, age evidence or funded proof. One-wallet projection is display-only and does not replace complete inventory admission.

## Verification

- Final Node 24.19.0 run: **42 marketplace test files, 769 tests passed** together, including native disposable SQLite/Turso and local Miniflare D1 cases. The new source reader has 46 tests, client contract 33 and browser component 40.
- Plain `tsc --noEmit --incremental false`, scoped type-aware lint and formatting passed on all 14 owned application/test files.
- Chrome desktop and 375px iframe checks used the actual compiled GET routes and components, real local disposable SQLite, synthetic authentication, 42 saved public-address records and 101 seeded legacy history records. Full inventory refused 409; explicit wallet/history pages returned 200 and next history changed run-100..081 to run-080..061. Disclosures and selection produced no hidden requests. Record text wrapped within the mobile pane. This is not signed-in production or real-provider QA.
- Actual `claude-opus-5-5` source-only design and implementation reviews completed, with copied files unchanged and zero permission denials. Reviewer ran no tests/browser. Compatibility, hidden-suffix, partial-coverage copy and clock-message follow-ups were subsequently verified by Codex and the focused helpers, not rereviewed by Opus.
- Named seller financial handlers and original inventory predicates are unchanged under normalized TypeScript comparison. Existing inventory server, history writer, protected page, program pins and group code reader are untouched. This scoped comparison is not full behavioral equivalence or financial qualification.

Private local QA logs and immutable review receipts are retained under ignored `work/release-qa/`. The companion JSON records final source hashes and outcomes without secrets or raw records.

## Coordination and release

Codex/helpers release the saved-evidence claim after this checkpoint. Claude PR57 remains open and untouched at `ecdbb15aab4bb450e60d4375ecddc2714653fcc5`. OpenCode's isolated vault copy fix is already merged through PR58; its usage-limited session was not retried or replaced. The protected recovery navigation parent patch is still pending approval. The four original AGENTS additions and seven frozen 0144 warmup drafts remain unstaged and unchanged.

No deployment, application/hosted migration, provider/credential/cron change, actual wallet generation/unlock/sign/send, strategy execution or funded test occurred. Git deployments remain disabled. Full Jito qualification, complete marketplace commerce/custody, comprehensive inventory paging and full legitimate Proxima parity remain open.
