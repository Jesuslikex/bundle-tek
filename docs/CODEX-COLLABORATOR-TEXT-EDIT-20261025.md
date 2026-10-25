# Default-off collaborator saved-text editing

Source checkpoint based on `787b7ec`, 25 October 2026. Nothing is deployed or applied to an application or hosted database. The separately approved recovery-navigation patch is already on main as `e9a210c`; this checkpoint does not edit its protected parent.

Project shares already had invitations, membership, expiry, revocation and selected read-only assignment references. This change adds an optional immutable owner grant to edit only the saved project name, symbol and description. Older shares and new invites default to view-only. Artwork, links, launch settings, wallets, publishing, trading, signing and transaction submission remain owner-only.

## Review and persistence

The owner must explicitly check the saved-text permission for a new invitation. Changing that permission requires revocation and a new invite. The returned permission must match the requested permission before the UI displays an editing invite. Switching projects resets the checkbox and selected scope.

The collaborator explicitly loads the current three saved values. A canonical before/after review and a separate initially unchecked approval precede one save attempt. The hash binds the exact share, project, saved revision and before/after values. The server recomputes it; neither a client hash nor a cached receipt grants authority.

The atomic SQL insert rechecks the accepted member, immutable grant, ownership, SQL-time expiry, revocation, archive state, exact raw source document and revision. It also repeats the owner's current wallet eligibility predicate, including role, revision, folder membership and folder revision. Only the three text paths are updated with `json_set`. The new project revision, immutable edit receipt and readable owner project event are committed together or rolled back together. Other raw fields are preserved.

Raw source text must already be canonical; legacy whitespace or unsupported text requires an owner refresh rather than silent rewriting. Service and SQL enforce the owner's 24,000 UTF-16-unit save-envelope budget. Name and description limits count valid supplementary characters as two units. NUL and isolated surrogates are refused before hashing; SQL independently requires canonical JSON roundtripping before extracting text into a project. Alternate valid JSON escape spellings can fail closed; the actual service writer always emits canonical fixed-order JSON. Existing unrelated source fields are never normalized by the collaborator write.

Saved text is off-chain draft data. The owner must publish changed metadata and request a fresh launch review before launching with it. This checkpoint changes no release, historical recovery, packet admission, simulation, signing or execution code.

## Lost responses and limits

Before sending, the browser retains only the mutation/share/project IDs and review hash. A missing or invalid local reminder prevents a new save. No automatic POST retry occurs. Recovery explicitly fetches the original mutation ID and admits its exact bound, hash-verified receipt. An exact already-saved request replays without a second project update or event.

Pending IDs remain reachable in a separate recovery-only section after a share disappears through expiry, leaving or revocation. This section grants no current source read or editing access. A locked/archived editor can check a past receipt, but cannot load, review or save current text. Server receipt reads return past facts only to the original editor or owner, independently of the current grant.

An absent receipt is not terminal proof. Even a failed save response conservatively holds the ID; the UI does not clear an unknown outcome or resend it. If no receipt appears, end the old grant by leaving or revoking it before a new invitation and edit. No cancellation tombstone is implemented. Malformed local records remain retained with a readable warning. Edit history is capped at 1,000 records per owner/project with no eviction. Historical receipts currently use the version-one project/text admission rules; future validator changes must preserve versioned recovery compatibility.

## Verification

- Final related regression: 440 tests across 14 files pass on Node 24.19.0. Includes canonical review/hash/receipt admission, v1/v2 permission decoding, default-off and immutable grants, same-origin/body bounds, real SQLite storage/API composition, SQL-time revoke/expiry/CAS/wallet races, rollback, duplicate-ID recovery, text/size boundaries, surrogate refusal, unknown saves, orphan receipt recovery and context cancellation.
- Plain TypeScript, scoped typed lint and formatting pass. This is not a new full application suite or production build claim.
- All 150 whole migration files apply through real Wrangler to disposable D1. A separate native SQLite upgrade preserves all 149 prior ledger rows and seeded rows across 184 prior tables, verifies all 150 canonical checksums, retains default-off legacy shares and passes integrity/foreign-key checks. No guards are removed. Initial verifier-only CRLF and seed-expiry assumptions were corrected; these were not application fixes.
- The local Chrome fixture compiles the actual components, sharing and metadata routes, and production Turso adapter against disposable SQLite with all 150 migrations. Owner opt-in, member acceptance, explicit current-source loading, before/after review, unchecked approval and one save produce the expected receipt. A second fixture deliberately drops the successful save reply, revokes the share and reloads the member screen. Recovery then finds the original receipt without restoring project access or issuing another save. Database assertions show one edit and one event; private links, fee-share settings and wallet selections remain intact. Subsequent Unicode/canonical-SQL edge guards were verified separately by the final native/API tests.
- DOM layout checks at 1920 and 375 pixels show no horizontal overflow; new recovery/editor controls have 44-pixel targets. This is synthetic local account data, not signed-in production, live provider or funded proof.
- Two actual `claude-opus-5-5` source-only reviews completed with unchanged bounded copies and zero permission denials. The first found recovery and text-budget edge cases. The second reviewed their fixes and identified an isolated-surrogate path in its earlier contract snapshot. The final contract rejects it, crafted HTTP cases return 400 without writes, and native direct-SQL cases now prove refusal and rollback. The final canonical JSON guard and error-label follow-ups were independently tested by Codex after that review; Opus did not run tests or approve an unexamined final snapshot.
- Source comparison preserves 18 protected owner-save, layout, vault, automation, Jito and signing files, the original sharing accept/revoke/leave handlers, all 149 prior SQL files and the prior journal entries. Windows line endings are normalized for Git source comparison; canonical migration checksums are verified separately.

Private evidence is retained under `work/release-qa/metadata-edit-*` and `opus-collaboration-metadata-*`. The structured companion contains exact source hashes and verification receipts.

## Release and coordination

Source-only migration `0151_project_collaboration_metadata` has journal index 149 and timestamp `1794860000012`. Claude's 0147 reservation remains unchanged; insert it in its reserved position when its PR is ready, without rewriting published SQL or timestamps. Next unclaimed number is 0152, subject to a fresh journal/claim check. An approved release must audit the actual remote ledger before applying pending migrations.

Claude PR57/59/60 application files and protected parents remain untouched and unmerged. Four original unstaged AGENTS additions and seven frozen warmup drafts are retained. Git deployments remain disabled. No deploy, application/hosted SQL, provider/credential/cron change, real wallet unlock/sign/send, funded trade or strategy run occurred.

Full legitimate parity remains incomplete. Broader collaborator wallet-action roles, durable automation continuity/accounting, held marketplace payment fixes, and complete live read-only Jito qualification remain open. This bounded edit claim is released after publication.
