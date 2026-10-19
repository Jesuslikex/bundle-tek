# Launch-layer history and close recovery

Before editing, 19 October: Codex claims its own `components/launch/launch-layer-history.tsx`, `pump-layer-planner.tsx` and existing planner tests. After a validated save, an already-open history list currently remains stale until manual reload. Introduce a save refresh version: invalidate an old in-flight history response, clear the stale index and refresh once if open, or defer the GET until the closed panel is opened. No automatic write, provider read or retry loop. Preserve exact snapshot-opening admission and all execution/signing guards.

Remaining follow-up, separately reviewed before editing: clarify the result of closing a planner while a save may be pending. No protected Claude UI, account-session, library, API or database path is claimed. No deployment or funded activity.

History refresh committed as `d1a157d`:11 files/121 tests, lint/format/TypeScript and synthetic browser1440/375/320 checks pass. Before the next UI edit, Codex also claims its owned `launch-layer-planning-entry.tsx` and existing entry/planner tests. Opus5.5 confirmed that unmounting on Close hides uncertain-save outcomes. Add a parent-held recovery notice for an unconfirmed planning save, using local attempt numbers only to distinguish old acknowledgement from a newer pending attempt. Closing reads remains available, and all actual save admission, parsing, cancellation and signing gates stay unchanged. Do not clear an earlier closed-save warning merely because a different later save succeeds.

The recovery notice uses native `output` semantics and an owned `launch-layer-planning-entry.module.css` rule for readable spacing, wrapping and a44px dismissal target. No shared stylesheet or protected layout change.
