# Finalized Pump launch to token workspace

15 October 2026. Scope: complete-group Pump launches with successful finalized original packets, tip and exact saved closure. This connects the existing launch screen to Bundle's existing chart, holder, history and trading workspace. It does not establish full Proxima parity.

## Ownership and navigation

The user explicitly approved the prepared `app/page.tsx` wiring after the ownership request. The applied change imports the navigation provider and wraps the Token Details branch, preserving every existing form prop. Its callback uses `guardDraft`, accepts the returned imported project, then calls the existing `openImportedProject`. The provider belongs on Token Details: the actual component ancestry is TokenDetailsForm → LaunchMetadataReview → PumpLaunchReview → PumpHolderLaunchReview → PumpLaunchGroupReview → PumpGroupBroadcast.

No other Claude-owned shell, workspace layout, holders, supply, timeline, performance, shared CSS or Vitest configuration file changed. The proposal patch is retained as `CODEX-LAUNCH-TO-CHART-SHELL-20261015.patch` for the reviewed scope. It is historical review material and must not be applied again.

## Behavior

After successful finalized complete-group recovery, the user can click **Open token workspace and chart**. The authenticated action accepts the group id only, resolves the exact immutable owned launch/closure, and creates or reuses the owner's Solana import for that mint. It does not accept a client-supplied mint, owner, token document or provider. A fresh Token-2022 identity with the pinned six-decimal profile and a context at least as recent as the finalized tip is required for a new import. The bounded inspector is not required when reusing a saved import.

New records have independent project UUIDs. The existing owner/chain/mint uniqueness constraint makes concurrent requests converge on one workspace. The project and its import event commit atomically under the exact finalized source proof and existing 100-project limit. Candidate response/document validation happens before the write. A post-commit timeout can still report an error; retrying the same launch recovers the saved workspace.

Reuse preserves the existing project's revision, settings and archive state, without refreshing it. An archived workspace opens its existing archived view and requires its separate explicit Restore action. Delayed responses from a changed visible launch context cannot navigate. The button is hidden without the navigation provider. Market indexing can lag launch finality; opening a workspace cannot guarantee candles, liquidity or a usable swap route immediately.

This action never signs or submits, changes group state/reservations, restores an archive, or grants trading authority. Existing separate trading review/approval still applies.

## Review and verification

Claude's tool-free CLI review identified the project-id coupling and precommit validation gap; both were corrected. Its final follow-up reported no new concrete bugs. Codex runs the tests; Claude did not execute them. Review also checked the actual Token Details ancestry, existing mint uniqueness, archive-opening behavior and pinned six-decimal profile against source rather than accepting assumptions.

Final Node 24 verification: all 29 selected group/API/UI files passed together, 271 tests, zero failures. Actual-source TypeScript, scoped type-aware lint and the production webpack build passed. Changed implementation bytes remained identical to the final regression snapshot. Logs are retained locally under ignored work/launch-workspace-all-tests.log and work/launch-workspace-final-{types,lint,build}.log. This targeted group cohort is not a new full-application-suite pass.

The real local SQL case uses the synthetic full signing/broadcast/recovery pipeline before invoking workspace creation. It covers foreign ownership, stale token context, rejected oversized identity source before persistence, project/history rollback, the project cap, concurrent opens, independent project ids, and archive/settings preservation. API tests cover the owned action, rate gate, injected-mint rejection and absence of signing-RPC requirements. UI tests cover explicit-click navigation without signing/submission and stale-context rejection. Codec tests bind group, mint, signed vector, project identity and disabled authority flags.

No rendered browser or funded launch-to-chart check was performed. The prior automatic approval rejection of a temporary TCP preview launch was respected. No push/deployment, migration or remote SQL, provider/credential change, cron, real-wallet unlock, signature or submission occurred. These are local source checks. Full hosted/funded qualification, current holdings and economic reconciliation, audited P&L, other launch/chain adapters, complete holder/history coverage, strategy parity and marketplace integration remain open.
