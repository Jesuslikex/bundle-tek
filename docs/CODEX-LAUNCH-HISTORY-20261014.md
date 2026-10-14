# Saved launch recovery checkpoint

14 October 2026, based on 40ae02e. This adds project-scoped recovery navigation below the current Pump launch panel. The draft's holder/developer mode no longer determines which saved launch types can be inspected.

The new panel explicitly loads create-only, developer-buy and holder histories in parallel. It lists every record returned by each existing route, including records older than that route's newest review. Each route currently returns at most twenty records. Partial failures leave successful launch types available and show plain per-type errors. Foreign-project, duplicate, malformed or mismatched recovery summaries are rejected. Status labels report saved server state, not independently audited chain proof.

Only an explicit recover action is exposed for previously approved/signed/submitting/submitted records. The request contains exactly the selected id and recover action on that record's original route. There is no prepare, approval, signing, registration, cancellation or submission action in this panel. Unsigned reviews remain unsigned and link conceptually to their original review. Unknown send responses are not resent. Expired-unobserved fees remain unresolved. Changing projects aborts pending requests, remounts the list and prevents stale responses from updating the new project.

## Verification

- Node 24: seven selected UI and route files passed 89 tests, including existing Pump create, initial-buy preflight and holder routes and launch/metadata panels. After the accessible button-label refinement, the history/parent pair passed all fifteen tests again. The parent panel additionally passed its ten tests after assertions that recovery remains mounted in holder and create-only modes.
- Five new component tests cover all launch types/older records without automatic reads; exact selected-record recovery; partial HTML failures; foreign projects/mismatched replies; and project changes during recovery.
- Actual-source TypeScript, four-file typed lint and final-source production Next build pass.
- Existing Chrome rendered actual component code/application CSS with controlled local history responses. Six rows across three types were visible. Desktop and 390 by 844 phone screenshots are in ignored work/launch-history-desktop-20261014.png and work/launch-history-mobile-20261014.png. Phone document width equalled 390. No actual API/provider read or recovery mutation was invoked in browser QA. The local harness was stopped, tab closed and viewport reset.

## Limits and handoff

The existing twenty-record-per-type history limit remains; full pagination and direct archived-record navigation are unfinished. Original signing panels still load their newest review for continuation. This separate panel recovers older signed outcomes without restoring old draft terms or granting signing authority. More extensive authenticated workspace/provider/funded proof, large-group launches, scheduling, StonkFun and wider Proxima parity remain open.

No server API, migration, global CSS or protected Claude file changed. No remote SQL/migration, credential/provider change, cron, push, deployment, wallet unlock, real signature or broadcast occurred. Migration 0081 remains local only and production remains 11ad20b. Main's two unrelated dirty files remain preserved.
