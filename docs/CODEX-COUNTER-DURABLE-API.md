# Durable Counter evaluation API

13 October 2026. Counter rules, accumulator and decisions now persist in owner/project-scoped D1 plans through `/api/imported-projects/counter-trades`. This continues the evaluation core, not completed Proxima parity. Every response and stored plan retains `executionAllowed=false`.

## Contract

Authenticated GET accepts projectId and plan id and reads validated history, including after project archival. Same-origin JSON POST accepts exact create/control/evaluate shapes. Create binds immutable rules to the current active Solana project document/revision. Control pauses, resumes or permanently ends a plan with revision compare-and-swap. Pause/end remain available after archival; resume requires the original active project context.

Evaluate accepts only a reference into the owner's saved pool tape. The server selects the trade and derives RPC movement/classification itself; client movement/side proof cannot authorize a decision. Confirmed chain time must follow activation within a one-second timestamp tolerance and remain within five minutes. The database independently checks freshness at write time. Project, tape, plan revision/document/state and newly verified ownership exclusions are rechecked atomically at the final write.

Automatic exclusions combine previously signature-verified Solana ownership addresses, the project's selected trading wallet and explicit user exclusions. A saved workspace record alone is not control evidence: Claude's Watch helper saves external holders there without granting ownership or signing. Adding a watch-only record does not invalidate a plan; newly verified ownership requires a new reviewed plan. Historical ownership proof is used only for exclusions, not current signing authorization. Full launch-plan/multiple-strategy wallet linkage remains unfinished.

Stored event identity prevents retry from drawing again or accumulating twice. Exact recorded retries return the original decision without another provider read, including provider-block mismatch decisions. Contradictory provider references are rejected. The ledger validator reconstructs contribution/queue/proposal history; schema guards preserve immutable rules/context and append-only decision prefixes. Concurrent state/context changes withhold new decisions. Limits are 20 plans per project, 1000 decisions per plan and a one-megabyte serialized document. Provider checks retain the existing shared 15-second owner rate gate.

## Schema and verification

Schema was declared in db/counter-trade-schema.ts and exported from db/schema.ts, then generated with Drizzle. New unapplied `0076_flaky_crusher_hogan` adds the plan table/index and insert/update guards. Existing 76 journal entries remain identical; no historical migration was rewritten by this phase. Real Wrangler applied all 77 whole files on disposable local D1, with an exact ledger. Report: C:/Users/Julian/AppData/Local/Temp/bundle-wrangler-migrations-mhtHJZ/report.json. All tested migration hashes still match the final files.

Final verification: **24 tests in 3 main files passed**, including real route/local D1 ownership isolation, persistence/replay, pause/end/archive, project/tape/control/ownership races, concurrent requests, immutable history, watch-only buyer eligibility and database-clock freshness under application-clock drift. Retained work/** QA copies were excluded. Actual-source TypeScript, seven-file typed lint and production build passed. Reports: work/release-qa/counter-durable-final-*-20261013.*. Post-check source snapshot: 1065 files, digest 6b53d2de224f2e25bcc0ae51e6d287f0cf45554809a6664032e3538d3d3b2e08, unchanged.

## Remaining integration

No Counter UI, automatic worker loop, shared strategy/session budgets or ending conditions, editable running rules, Buy token-target-to-SOL quote conversion, explicit transaction review/signing or submission is wired by this checkpoint. Active means manual evaluation is available, not execution permission. A stored proposal is a token target, not a funded trade or audited P&L. No browser or funded proof was performed here; the older full-suite pass predates this API.

Claude-owned files remain untouched. The local CROP candidate 16d7c7d was built from committed 1f46c54 before this checkpoint and excludes 0076/API work. No candidate refresh, credential access, push, saved version, deployment, hosted SQL or financial action occurred. The hosted partial-migration failure remains unresolved.
