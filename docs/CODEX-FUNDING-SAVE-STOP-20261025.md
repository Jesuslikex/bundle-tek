# Terminal funding draft-save recovery

25 October 2026. Source base `21f7d42`. This supersedes the missing terminal-fence limitation in `CODEX-FUNDING-RELOAD-RECOVERY-20261025.md`.

## Behavior

An unknown funding draft save can now be stopped with a separate, initially unchecked approval. This stops the original **draft mutation**. It does not cancel transfers, release reservations, remove signatures, refund fees or grant signing authority. The UI warns that advancing the saved revision invalidates earlier unsent funding reviews.

The browser retains a separate owner-scoped stop ID and original ID/action/revision/document hash before sending the stop. Both save and stop paths use the same owner WebLock. Pending stop metadata blocks another tab from retrying the original save. Unknown replies, cancellation and reload retain the original references; checking uses GET, and retrying sends only the exact same stop request. Metadata contains no allocation document, addresses or signing data. Hashes are identifiers, not encryption; these local references survive sign-out.

The server stores an immutable, owner-scoped request/receipt and fences the original revision atomically:

- An absent initial save gets a permanent creation fence without a fabricated funding plan.
- An existing plan at the expected revision advances exactly once, preserving raw document bytes and archived state.
- A later revision is left intact. Its receipt proves the old revision can no longer write; it does not establish which earlier save won.
- Unreachable future revisions are refused. Future ordinary edits use the advanced revision and retain the existing CAS rules.

Exact funding recovery reads the plan and matching fence in **one SQL observation**. Older clients receive a failure for a fenced plan instead of mistaking a no-op revision advance for a successful save. Current clients bind recovery to the original expected revision, so later ordinary saves remain recoverable. Stop receipts remain readable even when the source document is corrupt.

Once a strict receipt establishes the revision fence, local records are removed only under the owner lock and only when they still match. A competing stop ID can be recovered through explicit original-revision inspection; an ordinary saved row cannot clear an unresolved stop. Partial local clearing remains recoverable from the remaining stop metadata. A stopped initial draft gets a new ID. Current editor text is preserved, and opening a saved plan remains explicit. The existing read-only history panels retain an earlier-revision entry in the mounted planner; transfer state is unchanged.

## Verification

- **254 tests across 10 files pass** on Node24: strict contracts, actual funding/stop routes, native storage, actual local D1 and production Turso adapter exercises, planner recovery, owner scopes and existing funding/exchange review behavior. The final two engine exercises additionally cover all rowid aliases and the rare negative-rowid case.
- Plain TypeScript, twelve-file typed lint and fourteen-file formatting pass. The local browser fixture compiles the actual planner/hook/API with the production Turso adapter and disposable SQLite; it is not a full Next production build or a real authenticated session.
- Actual Chrome: the first create is held before dispatch, the stop commits, and the delayed original is refused. Its stop acknowledgement is then lost. A real reload followed by explicit exact-stop GET clears recovery; a new draft with a different ID saves once. The disposable database ends with one creation fence, one different saved plan at revision1 and one creation event. A second synthetic account sees no first-account draft or recovery controls. Desktop1920/phone375 have no horizontal overflow; recovery buttons measure44px. Final acknowledgement-policy/copy and rowid hardening follow-ups are independently tested after this browser run, rather than represented as another browser execution.
- All **151 whole-file migrations** apply through Wrangler's real local command. A separate native upgrade preserves all150 prior ledger checksums,185 prior table snapshots and two funding rows, with integrity/foreign-key checks passing. New `0152_funding_save_stops` is source-only, timestamp1794860000013. The150 earlier SQL files and journal entries are unchanged. Claude's0147 remains reserved; the next unclaimed number is0153, subject to fresh inspection.
- Source/AST guards retain the original funding document validation, CAS SQL/bindings and atomic event batch; the five financial enable predicates and six original planner handlers are unchanged. Twenty-three protected parent, vault, Jito, automation and financial-child files remain unchanged.

Two actual **Claude Opus5.5** source-only reviews completed with unchanged review copies and zero permission denials. The first identified the competing-stop dead end, now covered by actual route/UI tests. The second identified an ambiguous committed-batch error incorrectly becoming a definitive rejection; the API now leaves `already_advanced` unknown, and a real commit-then-error regression covers it. A separate root audit found SQLite rowid replacement paths: the new receipt table uses `WITHOUT ROWID`, and funding triggers guard all rowid aliases even with recursive triggers off. These final fixes were independently tested; no final-snapshot Opus approval is claimed. Opus did not run tests.

## Limits and release boundary

This is bounded funding-draft recovery, not full Proxima parity. No live provider, funded execution, production authentication or hosted migration was exercised. No full application suite or production build is claimed.

Stop history has a hard1000-record owner cap and an integer revision ceiling. At capacity or an unreachable revision, unknown operations remain held; there is no unsafe erase or quota bypass. Detailed stop-history discovery, support for exhausted histories and earlier-revision navigation across a later fresh app reload remain follow-ups. The stop receipt is its own immutable audit; it does not manufacture a `funding_events` transfer/update event. Legacy clients without an expected revision fail closed for a fenced ID. A rare pre-existing fenced rowid=-1 also blocks automatic new inserts because SQLite uses-1 for an unspecified insert rowid; both local engines explicitly test this conservative refusal. Normal API-created positive rowids are unaffected.

The browser run first observed the late-create refusal as503. The final API returns409 only after admitting a matching pre-commit fence; an `already_advanced` outcome or unavailable proof stays503/unknown. These distinctions have direct route regressions.

No application/hosted SQL, deployment, provider/credential/cron change, real wallet unlock/sign/send, strategy run or funded action occurred. Git deployments remain disabled. Claude PR57/59/60 application files and protected parents, the four original AGENTS additions and seven frozen warmup drafts remain intact. Broader durable Auto Sell run accounting, full read-only Jito qualification and the remaining legitimate marketplace/launch functionality stay open.

Private reproducible evidence is under `work/release-qa/funding-stop-*`, `opus-funding-stop-20261025`, `opus-funding-stop-final-20261025`, the guard script and the disposable Wrangler report.
