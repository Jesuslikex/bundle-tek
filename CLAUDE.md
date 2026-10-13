# Claude Code project notes

This folder is the Bundle application repository. Start with `PRODUCT-PARITY.md` and `PROXIMA-REVIEW.md` for the current product context, and read `HOLDER-RPC-SETUP.md` when working on holder reads.

## Preserve the working tree

Before changing files, inspect `git status --short`. This checkout contains a large amount of intentional uncommitted and untracked work. Preserve it. Do not reset, clean, stash, or restore broad file sets, and keep edits focused on the requested task.

## Git on this machine

Git is available through the local Codex runtime even when the Claude desktop terminal does not have it on PATH. In PowerShell, run:

```powershell
& 'C:\Users\Julian\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe' -C 'C:\Users\Julian\Desktop\Bundle' status --short
```

This executable was verified as Git 2.53.0.windows.3. Do not infer that Git is missing from `where git`: PowerShell aliases `where` to `Where-Object`. Use `Get-Command git` or `where.exe git` when checking PATH. Use the verified absolute executable above for this project; no Git installation is needed.

## Project and evidence context

The Proxima reference is a static browser client capture at `C:\Users\Julian\Desktop\REA\targets\proxima-20261009`, captured on 2026-10-09. Treat it as client-side evidence only, not current server behavior. For further Proxima reverse engineering, first read `C:\Users\Julian\.agents\skills\reverse-engineer-anything\SKILL.md` and follow its evidence and coverage requirements. The latest read-only review is `C:\Users\Julian\Documents\Codex\2026-10-09\https-github-com-morluto-rea-https\claude-opus-5-5-rea-review.jsonl`.

## Wallet and transaction boundaries

Wallet private keys belong encrypted in the browser with user-controlled export. A user must explicitly review and approve each transaction before signing. Do not automate signing or send transactions. Do not read or print `.env*` files, keys, clipboard contents, or other credentials. Do not create paid services, change provider credentials, or deploy unless the user explicitly asks for that action.

## Review discipline

Keep claims tied to the code or captured evidence you inspected. State when provider data is sampled or incomplete. Before any code change, summarize the files and behavior you plan to change; for financial actions, credential changes, or deployment, wait for explicit user authorization.

## Commit checkpoints and current handoff

The user requires Codex to commit completed, verified work locally so Claude can follow progress. Both agents should inspect the latest commit, index and remaining working-tree changes before editing. Commit only owned files or hunks, leave concurrent work separate, and report the local commit hash. This does not authorize pushing or deploying.

The current Codex checkpoint integrates conditional Buy/Sell Limit and Grid review, exact SOL input budgets, explicit transaction approval, all-wallet session outcome reads, atomic cancellation of pending unsigned jobs, token chart/history and holder continuations, and mainnet funding history. See `docs/CODEX-CURRENT-FULL-SUITE.md` and `docs/CODEX-PROXIMA-COMPLETION-MATRIX.md` for validation and remaining requirements. The latest Codex feature run passed 322 targeted tests across 36 files, TypeScript, typed lint and production build; the older 1,919-test full-suite result covers an earlier source snapshot.

Claude's timeline changes in `components/account-performance.tsx`, `components/performance-timeline.tsx`, `lib/performance-timeline.ts` and `lib/performance-timeline.test.ts` were committed separately as `2e2d177` while this checkpoint was being prepared. They are not part of Codex's staged changes. Inspect any newer edits before taking ownership of those files. CROP hosting remains blocked by missing runner, failed SQL and migration ledger diagnostics. No live transaction or deployment is part of this checkpoint.

