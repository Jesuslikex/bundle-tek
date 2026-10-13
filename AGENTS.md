# Bundle collaboration

Read `CLAUDE.md` for the repository, wallet, credential and deployment boundaries.

The user requires local Git commits after completing and verifying Codex changes so Claude can follow progress. Inspect the working tree and index first. Stage only owned, reviewed files or hunks, preserve concurrent Claude edits, and exclude credentials and generated/runtime artifacts. Do not use broad reset, restore, clean or stash operations.

Create a coherent local checkpoint before handing completed work back. Record what changed, the exact validation scope and outstanding blockers in the project notes. Report the commit hash to the user. A local commit does not authorize a push, deployment, provider change or live transaction.

Before taking the next task, inspect the latest commit and remaining working-tree changes. Uncommitted work may belong to the other agent; do not treat it as disposable or silently include it in your own commit.
