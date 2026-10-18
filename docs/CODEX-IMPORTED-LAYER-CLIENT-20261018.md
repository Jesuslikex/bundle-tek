# Imported-token layer client and lifecycle

18 October 2026. This implements the client/API/planner foundation. It does not yet mount an imported-token picker in the production launch workspace.

## Exact selection and transport

The client can now represent an imported target with its owned imported record ID, current revision and expected public mint. Request serialization sends only ID/revision for imported targets: the server remains responsible for resolving the mint. New-token requests retain their existing mint shape.

readLaunchLayerContext now returns imported ID/revision derived from the validated request and owned load. The client verifies that echo, resolved mint, source project/update and all authority-off flags. A wrong or missing imported identity, different revision/mint/kind, or enabled signing flag refuses. The owned server query still rejects foreign, archived, non-Solana and stale records; no provider request is added.

Saved-plan responses now expose imported identity from the already-retained immutable snapshot selection. The snapshot schema, stored JSON and hashes are unchanged. The client requires that identity for imported envelopes, checks it on save acknowledgement and uses it for reopening eligibility. Reopening requires both the current imported ID/revision and exact mint, rather than accepting another owned record just because it represents the same mint. New-token history remains compatible.

## Imported roles and UI

Imported drafts require a saved scheduled Solana Block-0 plan and complete current final-holder assignment. They omit the developer row and role, even if the source project has a deployer saved. Requests containing an imported developer refuse. Saved imported ceilings can be copied into a draft only after exact current identity checks; a new review is still required. Changing imported revision remounts the planner and makes old snapshots ineligible for reuse.

The planner displays Imported token and the selected imported record/revision. Its instructions no longer refer to a new mint, ordinary launch below or required developer for imported plans. All existing wallet uniqueness, budget, fee/rent/reserve, scheduling, quote, Stonk Front-only and authority checks remain. No financial handler, schema, migration, protected layout or signing gate changed.

## Verification

Final offline Vitest: 15 files / 167 tests passed together, zero failures/pending/todo. JSON/config prefix work/release-qa/imported-layer-final-20261018. The earlier 167-test run is retained separately. A local database-backed client test exercises owned resolution, request mint exclusion, strict context identity, missing developer, unscheduled refusal, exact save acknowledgement, reopen and stale revision refusal. An actual planner/API/database test loads, fills, reviews, saves and reopens the imported plan, then increments the imported revision and confirms the old snapshot cannot be reused. Existing new-token/Stonk/holder/native/history/vault paths run in the same selection.

Five-file type-aware lint, formatting, whitespace and whole-project TypeScript pass. A deprecated Zod safe alias was replaced with int, which already bounds safe integers, before the final test run. Existing planner-history React act warnings are still reported; this patch does not claim to fix them.

The actual planner browser fixture loaded a synthetic imported context over its controlled GET transport; the fixture rejects a caller-supplied mint in the serialized imported request. It blocks all writes, unrelated/provider requests and wallet actions. Chrome showed Funder, Front buyer and two Final holder rows, with no Developer. Client/scroll widths were 1440/1440,360/360 at375px and305/305 at320px. Public record/revision and mint stayed visible. Source, context and screenshots are under work/imported-layer-qa-20261018; mobile.png is the final phone view. Tabs/server stopped and viewport reset. This synthetic fixture is not proof of a production navigation slot, live providers or funded execution. The fixture bundle builds; no new Next production build or full-suite green result is claimed.

## Handoff and remaining work

The production entry must let the user explicitly select an owned active Solana imported record and current revision for a saved scheduled source plan. Do not default to the first imported project, accept an arbitrary mint as owned, or mount through a protected layout without its agreed exact-patch approval. The implemented shared entry can now carry that complete selection, but no production picker is wired by this commit.

The other chat separately committed receipt-history work in dd63e24. Its pinned production build predates these layer edits and does not qualify them. All account/receipt/schema work and user AGENTS text were preserved. No push, deployment, hosted SQL, provider/credential/cron change, real wallet unlock, signature or funded trade occurred. Stock signing and staged funding/execution remain off/unimplemented.
