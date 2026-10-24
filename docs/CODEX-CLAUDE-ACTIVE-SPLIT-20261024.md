# Active Codex / Claude split, 24 October 2026

This is a coordination update, not a new parity-completion or release claim. User asked both agents to stay in touch and finish the legitimate remaining features. Preserve the standing no-deployment, no-hosted-SQL, no-funded-trade and no-real-wallet-unlock/sign/send boundaries.

## Current authoritative state

At inspection, local and origin/main were `3605074`. The latest committed Jito checkpoint is `CODEX-JITO-RAW-RESPONSE-ADAPTER-20261024.md/.json`: 436 targeted tests, project TypeScript and scoped lint pass. The raw adapter remains unmounted and grants no signing/execution authority. Both new live captures stopped before simulation on differing fee-context slots; this is not full live qualification.

Current canonical checkout: `C:\Users\Julian\Desktop\Bundle`. Existing dirty AGENTS.md content and the seven unfinished 0144 warmup files are preserved. Do not delete, stage or resume those drafts by assuming that an old claim means they are ready. Root has two new unfinished `lib/jito-fee-batch.ts`/test files; they belong to Codex and must stay out of unrelated feature PRs.

The migration journal currently has 146 entries through `0146_launchlab_launch_recoveries` (idx145). Next unclaimed number is **0147**, subject to a fresh check. All `drizzle/**` and `db/**` remain Codex-owned under the existing split. Never edit/rename/renumber committed migrations. Older dates and numbering in AGENTS are historical snapshots, not the current journal.

## Codex active ownership

Codex owns current Jito fee-source, raw-response, sequential simulation and recovery integration: `lib/jito-*`, `test/jito-*`, their tests and focused QA/handoff notes. In progress: bounded fee batching, exact ordered string reply IDs, common actual bank, unchanged 32-slot floor/span, raw capture and same-request evidence. No automatic fallback, source-price substitution or new signing authority.

**Codex is not currently editing warmup or Auto Buy feature code.** The older note that Codex is "deep in warmup execution and Auto Buy right now" is stale. Those features still require their own current-state audit and an explicit bounded claim before another agent resumes them. Existing incomplete execution/approval guards must not be bypassed or relabeled as complete.

## Claude's visible proposed areas

Codex inspected the existing Claude Desktop Bundle Tek / Build remaining Proxima features session. Its visible plan named non-Pump Sniper Guard first, then cleanup, a launch-to-chart recovery view and portfolio P&L. This records that plan; it does not assert that any patch or PR is complete. No open PR was listed at this inspection.

Claude should take disjoint, precisely claimed slices on a new branch/worktree from current origin/main and deliver normal PRs. Add the actual paths under Current claims before edits, and update the claim/handoff after each commit. If current source already implements a step, extend and verify it rather than rebuilding it. Recheck latest main before merging, preserve both agents' work and never force-push main. A push/merge is not deployment authorization.

For the proposed slices:

- **Non-Pump Sniper Guard:** inspect existing `lib/sniper-guard*`, `components/launch/sniper-guard-panel.tsx`, venue-specific launch flows and current decoders. Preserve program/data admission, ownership/exclusion, coverage and signing gates. Do not allow a program by ID alone.
- **Recovery view:** durable recovery already exists for Pump, Meteora DBC, StonkFun and LaunchLab venues. Start with `449d920`, `lib/venue-launch-recovery.ts`, `components/venue-launch-recovery.tsx`, `lib/launchlab-launch-recovery.test.ts` and `components/launchlab-launch-review.tsx`, then inspect current venue/Pump sources before choosing a new UI/controller gap. Read APIs or adapters are preferable to duplicating saved recovery writers. Coordinate any shared parent/layout or Jito changes first.
- **Portfolio accounting:** reuse existing finalized receipt and purchase/sale source APIs. Distinguish missing basis, unvalued assets, failed fees and outside activity. A saved approval or partial receipt list is not full audited P&L. Schema changes need Codex coordination before a migration is claimed.
- **Cleanup:** legitimate user-directed asset/rent recovery only. The user explicitly excluded artificial volume and deceptive wallet history; do not reintroduce those through repeated buy/sell cleanup or alternate-routing work.

A later read-only inspection showed Julian's own reply in that Claude session: he wants the marketplace. Preserve that product scope and inspect the existing catalog/inventory before adding anything. This is not authorization for actual payment, private-key delivery, purchasing or funded tests. Keep the existing execution safeguards; do not delete marketplace work based on an older summary. No message, acknowledgement or permission click was sent by Codex through that window.

## Communication and evidence rules

Use this note plus Current claims in AGENTS as the shared record. Link each new commit/PR and its exact test scope. Read the other agent's fresh claim before starting the next slice. If overlap is needed, exchange the exact path/patch first. Do not infer live deployment, provider qualification or funded execution from merged source or synthetic tests.

The existing Claude session and plan were inspected read-only. No approval prompt was accepted, no marketplace choice selected, no new Claude session launched and no message or acknowledgement is invented. This file is the concrete repository handoff available to that session; a future acknowledgement must be observed before reporting it as received.
