# Open an older saved venue launch

Source checkpoint based on `0932278`, 25 October 2026. This is source-only work; production was not inspected or changed.

Meteora DBC, StonkFun and LaunchLab already retain owned launch reviews and receipts. Their history query deliberately returns the latest 20. The shared history panel now accepts a complete saved launch UUID so an older record can be inspected without its local browser reminder. It reuses the existing `select()` path and owner-scoped exact GET. It does not renew approval, inspect the chain, recover an outcome, unlock a wallet, sign or broadcast.

The input validates UUIDs before making a request, clears on project/venue context changes, and is disabled during loading or a parent task. A different ID cannot replace a known unresolved original. Unknown preparation IDs require identifying the original active record through refreshed history. Failed history reads keep manual lookup blocked. Existing stale history rows also remain disabled after a failed reload when no original ID is known. Successful explicit history reload restores ordinary inspection. Errors retain the typed ID for manual retry; no request retries automatically.

## Validation

- 153 tests across eight related component, recovery-service and API-route files passed on Node 24.19.0. These include 33 new lookup cases. All 33 passed again after the final wording correction.
- Plain TypeScript, two-file typed lint, formatting and source comparisons passed.
- The original hook is byte-identical after removing the additive `contextKey` return property and normalizing line endings. Existing admission, request, preparation, approval/registration/submission, selection, cancellation and recovery logic is unchanged. Nine protected parent/server/signature files also match the base source.
- 28 UUID edge cases match the installed server `z.uuid()` admission.
- A compiled local browser fixture exercised the actual component, existing GET routes, recovery service and production SQLite adapter against disposable synthetic cancelled rows. Each venue had 22 records, with the oldest absent from its latest-20 list. Exact opening succeeded for all three; a wrong-venue ID returned 404. Every recorded request was GET. Provider requests and POSTs were blocked by the fixture.
- Current component utility styles and application globals were compiled for the fixture. Desktop 1920px and phone 375px had no horizontal document or descendant overflow, excluding the text input's normal internal text scrolling. Browser extension warnings were present; no application error was identified. The owned test tab and server were closed.
- Two actual `claude-opus-5-5` source-only reviews completed with unchanged source copies and zero permission denials. The first found the failed-history uncertainty gap; regression tests and UI guards close it. The second confirmed that fix and the three original keyed parent wrappers. Its follow-up stale-row guard and clearer unknown-preparation wording were independently tested afterwards, not rereviewed by Opus. The reviewer did not run tests.

Private evidence is under `work/release-qa/venue-known-id-browser-20261025`, `venue-known-id-guards-20261025.json`, and the two `opus-venue-known-id-*` folders. These contain only synthetic fixture evidence/source copies, not production credentials. The browser fixture uses the original table declarations with synthetic cancelled records; it does not assert migration, write-trigger, signature or transition qualification.

## Ownership and remaining work

Application edits are confined to `components/venue-launch-recovery.tsx` and its new `components/venue-launch-recovery-known-id.test.tsx`. No protected parent or Claude PR57/59/60 file changed. Original four unstaged AGENTS additions and seven frozen warmup drafts remain outside this checkpoint. No migration was added; 0150 remains next unclaimed, subject to recheck and Claude's 0147 reservation.

This closes a recovery discovery gap, not the full Proxima objective. Jito runtime qualification/program provenance, durable automation accounting and execution continuity, wallet-scoped collaboration and Claude's marketplace-payment blockers remain open. Do not infer a fresh approval or safe transaction outcome from inspection of a saved record.

No deployment, application/hosted SQL, provider/credential/cron changes, real wallet action or funded trade occurred.
