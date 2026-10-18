# Bundle collaboration

Read `CLAUDE.md` for the repository, wallet, credential and deployment boundaries.

The user requires local Git commits after completing and verifying Codex changes so Claude can follow progress. Inspect the working tree and index first. Stage only owned, reviewed files or hunks, preserve concurrent Claude edits, and exclude credentials and generated/runtime artifacts. Do not use broad reset, restore, clean or stash operations.

Create a coherent local checkpoint before handing completed work back. Record what changed, the exact validation scope and outstanding blockers in the project notes. Report the commit hash to the user. A local commit does not authorize a push, deployment, provider change or live transaction.

Before taking the next task, inspect the latest commit and remaining working-tree changes. Uncommitted work may belong to the other agent; do not treat it as disposable or silently include it in your own commit.

## Claude and Codex coordination (both agents read this first)

Added 18 October 2026 at julian's request. Snapshot at writing: local `main` at `08ca7c2`, 79 commits ahead of `origin/main` (`ea0a120`), working tree clean apart from this file. Detailed history stays in `docs/CODEX-CLAUDE-SHARED-HANDOFF-20261018.md`.

### Before starting work

1. Read this section and `git log origin/main..main` plus `git status --short`.
2. Claim your area by adding a line under "Current claims" (agent, area, paths, date). Remove it when the work is merged or dropped.
3. If an area you need is claimed by the other agent, leave it alone and say so to julian instead of editing it.

### Rules

- Codex (ChatGPT) works in `C:\Users\Julian\Desktop\Bundle` on local `main`, committing verified work locally as described above. Pushing `main` stays julian's decision.
- Claude works only on new branches cut from `origin/main` (never from local `main`, never on `main` itself) and delivers through pull requests. Claude does not commit into this checkout's `main`.
- Nobody force-pushes `main`, rewrites its published history, or deletes another agent's branch or worktree.
- Migrations: take the next number after the highest entry in `drizzle/meta/_journal.json` **on local main**, not on `origin/main`. Local main currently goes up to `0113_pump_group_receipt_evidence`, so the next free number is `0114`. Recheck the journal before claiming it. Claim the number in "Current claims" before writing the file. A Claude branch off `origin/main` must still use a number above local main's highest, and must be renumbered if local main moves past it before merge.
- Never rename, renumber or edit an already-committed migration.
- Shell and layout protection from the handoff doc still applies (`app/page.tsx` and the protected layout files need an approved exact patch).

### Current claims

Codex (ChatGPT) owns the following areas it is actively extending. The original 79-commit count above is a historical snapshot; use Git for the current relationship to origin/main:

- Volume Bot and same-block Volume bundles: `lib/volume-bot*`, `lib/volume-bundle*`, `lib/volume-usd*`, `app/api/volume*`, related tests and fixtures.
- Wallet warmup: `lib/wallet-warmup*`, `lib/warmup-swap*`, `components/wallet-warmup*`.
- Exchange funding, orders and payouts: `lib/exchange-*`, `app/api/funding/**`.
- Strategy drafts, held strategy previews and review capacity: `lib/strategy-*`.
- Launch layers (Front/Back planning, native coverage, history): `lib/launch-layer*`, `components/launch/**`, `app/api/launch/**`.
- Account trade amount presets and keyboard keys: `lib/trade-amount*`, `app/api/trade-amount-preferences/**`, `components/imported-token-quote.tsx`, `components/imported-sell-presets.tsx`.
- Codex (Review current progress), 18 October 2026: account session management audit and implementation, `components/bundle-account.tsx`, new `components/account-sessions*`, `lib/account-sessions*`, `app/api/account-sessions/**` and their tests. Source implementation waits for the current full-suite freeze to end; no provider, credential, password-policy or schema change is claimed.
- Imported token chart and wallet workspace: `app/api/imported-projects/**`, `components/wallet-workspace*`, marketplace catalog/inventory (`lib/marketplace-catalog*`).
- DCA timing and budgets (`lib/dca-trade*`, `lib/duration-parts*`), public wallet tags/watchlist imports (`lib/wallet-public*`, `lib/tracker-bulk*`), sign-in/password rules (`app/sign-in/**`).
- All of `drizzle/**` and `db/**`; the committed journal currently ends at `0113`.


Claude: no active claims. Add one here before starting.
