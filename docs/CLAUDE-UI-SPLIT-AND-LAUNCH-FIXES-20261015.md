# UI ownership split and launch-screen fixes for Codex

15 October 2026. The user asked Claude to decide how UI work is split. This note replaces the "Codex takes over UI" arrangement in CLAUDE.md now that Claude is working again. It changes no code.

## Ownership

- **Codex owns the launch screens**: `components/launch/pump-*.tsx`, `components/launch/launch-metadata-review.tsx`, the DCA, Counter and conditional-order components, and all API, `lib/*`, migration and hosting work.
- **Claude owns the app shell and workspace layout**: `app/page.tsx` (topbar, sidebar, status bar, page composition), `app/sign-in/*` presentation, `components/project-dashboard.tsx`, `components/workspace-activity.tsx`, the token workspace layout (`imported-token-projects.tsx`, `imported-token-quote.tsx`, `imported-token-market.tsx`, `imported-pool-candles.tsx`), and the Claude-owned holder, supply, timeline and performance files listed in `CLAUDE-UI-WORK-NOTICE-20261013.md`.
- `app/ux.css`: either agent may append rules. Neither rewrites or reorders existing rules.
- Before editing a file owned by the other agent, post a short note in `docs/` and wait for the user or the owner.

## Launch-screen fixes for Codex

Found by reviewing `main` at `b58355d`. Please fix these in your next launch UI change.

1. **History reads like a debug log** (`pump-launch-history.tsx`). Show human state labels ("Waiting for signature", "Submitted", "Finalized"), a short signature with an explorer link and copy, and the saved date. Sort all three launch types together, newest first.
2. **History starts empty and has a dead end.** Load the first page when the panel mounts. For an unsigned review, give a real action that opens that review instead of the text "Open its launch review".
3. **Disabled buttons give no reason** (`pump-holder-launch-review.tsx`). "Read current holder targets" is disabled when the mint key, payer, saved plan, release, unscheduled plan or idle launch state is missing. Show which requirement is missing next to the button.
4. **Mint backup restore has a hidden order.** Choosing the file unlocks it immediately with the passphrase field, so the passphrase must be typed first. Either say so above the file input or wait for an explicit "Restore" click after both are provided.
5. **No step indicator.** The holder flow runs mint key, limits, targets, simulation, approval, signing, broadcast and recovery in one form. Add a compact step list that marks the current and completed steps.
6. **Inline styles.** These screens hard-code layout styles. Move them to CSS classes (an appended block in `app/ux.css` or a CSS module) so they follow the app's shared look.

Keep all existing consent, signing and broadcast safeguards unchanged. Report the commit hash and tests when done.
