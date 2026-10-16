# Visible Claude Code UI session

The user requested a visible Claude Code UI worker, like their BestTek setup. This notice authorizes a bounded pass in the dedicated `C:\Users\Julian\Desktop\Bundle-Claude-UI` worktree on `claude/bundle-ui-20261016`. Start from main1ca5ab5 plus this handoff. The main checkout's two unrelated dirty files are excluded.

The user explicitly requires Opus5.5. Pin `--model claude-opus-5-5`; do not use Haiku or silently fall back. Session8b2f1c6d-350a-4f9f-9f09-895f216a207b. The initial inherited Haiku worker was stopped before any UI edits. Desktop `Bundle Claude UI.cmd` resumes this session with the explicit Opus model.

## Task

Improve the existing token workspace's Proxima-style desktop proportions and responsive clarity. Inspect the current source before deciding what is missing. Preserve the existing stats strip. Aim for a dominant chart, compact surrounding controls, a stable trading column and wallet navigation/table beginning within a900px-high desktop viewport where practical. Preserve the phone stack at375px without horizontal page overflow. Make a bounded pass rather than a broad redesign.

Read AGENTS.md, CLAUDE.md, docs/CLAUDE-UI-SPLIT-AND-LAUNCH-FIXES-20261015.md and docs/CODEX-PROXIMA-WORKSPACE-VISUAL-REFERENCE.md. The latter describes the retained actual1920x945 Proxima reference and its limitations. Current UI may be ahead of historical notes: inspect it. Do not invent market data, actions, provider support or execution readiness.

Allowed UI files: components/imported-token-projects.tsx, components/imported-token-market.tsx, components/imported-token-quote.tsx, components/imported-pool-candles.tsx. You may add a scoped CSS module or append a clearly scoped block to app/ux.css without rewriting/reordering existing rules. Prefer two to four UI files. app/page.tsx remains yours under the standing split, but this bounded pass should avoid it; propose an exact patch if needed. Record progress in docs/CLAUDE-VISIBLE-UI-STATUS-20261016.md.

Keep existing fetching, selected-pair publication, event handlers, authorization, approval resets, unsaved-draft protections, accessibility and truthful missing-data/error states. Do not edit lib, API routes, migrations, wallet/signing controls, launch/DCA/Counter components, dependencies, providers or credentials. Do not read/copy environment files, unlock a wallet, sign, submit, push, merge or deploy. No live financial actions. Stock signing stays off.

Run only relevant existing tests/typecheck if available; clearly state any inability to verify. Codex will independently check the diff, run verification, render desktop/phone and create the final reviewed commit. Leave UI changes uncommitted on your isolated branch, and summarize exact files, behavior and remaining checks in the status note. Do not commit someone else's files or touch main. Stop after this pass and remain available in the visible session.

## Local tooling

Git: C:\Users\Julian\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe

Node24: C:\Users\Julian\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe

Dependencies are linked from Bundle only for existing tooling. Do not install, update or mutate node_modules. No environment, production database or Vercel link is copied into this worktree. The latest reviewed backend work and its unresolved qualification findings remain in main; this is UI work only.
