# Bundle Tek shared Git repository

16 October 2026. The user requested Git or Vercel sharing so Claude can help with the UI.

- Private repository: https://github.com/Jesuslikex/bundle-tek
- Shared branch: `main`. Implementation checkpoint before this documentation: `70a423e`.
- Existing desktop checkout: `C:\Users\Julian\Desktop\Bundle`. Claude Code can continue opening that folder; it does not need another clone on this machine.
- `origin` now names the private GitHub repository. The friend-owned `pulseforge-legacy` push remains disabled. No Vercel Git integration, automatic deployment, production release, database migration or provider change is part of this handoff.
- Repository-local GitHub credentials use the existing Git Credential Manager login. This avoids the user's global helper pointing at a missing GitHub CLI executable; no credential was printed or committed.

## Working together

Read `CLAUDE.md` and `docs/CLAUDE-UI-SPLIT-AND-LAUNCH-FIXES-20261015.md` first. Keep the existing UI ownership split. Use separate branches/worktrees for concurrent changes, stage explicit files, commit completed changes, and review before merging to `main`. Do not reset or overwrite the shared desktop checkout to synchronize it. On a clean separate checkout, fetch `origin` and branch from `origin/main`.

The Counter UI checkpoints are `ad2f5e4`, `ef9d57d` and `cb38d2d`. Their notes describe synthetic desktop/phone checks and the remaining execution boundaries. Read `docs/CODEX-PAIR-QUICKNODE-FIXED-SAMPLE-20261016.md` for the latest stock qualification: SOL 0/3, USDC 0/3, with account-count and strict minimum-output refusals retained. Stock signing stays off.

Local source is ahead of production. The live URL https://bundle-tek.vercel.app/ is useful for the existing release, but is not proof that these newer commits are deployed. Do not deploy this branch or apply pending remote migrations merely to inspect UI.

## Verification and exclusions

Before upload, all 2,777 blob versions reachable from `main` were scanned for common private-key, GitHub-token, QuickNode URL, Helius URL, AWS-key and provider-secret assignment patterns, and sensitive environment/key filenames. No matches were found. This bounded pattern scan is not an exhaustive security audit. Git ignores local environment files, dependencies and generated runtime output.

Only committed content is shared. The two pre-existing unstaged desktop edits remain local: `docs/CODEX-JITO-ATOMIC-BUNDLES.md` and `drizzle/0068_remarkable_frightful_four.sql`. No application or UI code changes in this handoff; no application test rerun is claimed. Verify remote `main` equals the new documentation commit after pushing.
