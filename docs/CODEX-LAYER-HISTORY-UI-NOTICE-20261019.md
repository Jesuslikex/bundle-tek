# Launch-layer history and close recovery

Before editing, 19 October: Codex claims its own `components/launch/launch-layer-history.tsx`, `pump-layer-planner.tsx` and existing planner tests. After a validated save, an already-open history list currently remains stale until manual reload. Introduce a save refresh version: invalidate an old in-flight history response, clear the stale index and refresh once if open, or defer the GET until the closed panel is opened. No automatic write, provider read or retry loop. Preserve exact snapshot-opening admission and all execution/signing guards.

Remaining follow-up, separately reviewed before editing: clarify the result of closing a planner while a save may be pending. No protected Claude UI, account-session, library, API or database path is claimed. No deployment or funded activity.
