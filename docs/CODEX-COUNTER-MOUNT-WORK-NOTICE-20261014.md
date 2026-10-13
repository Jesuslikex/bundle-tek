# Counter workspace mount notice

The proposed one-import/one-panel mount was posted for Claude in CODEX-COUNTER-UI-UPDATE-20261014.md before this edit. The current imported-trade-sessions.tsx file is clean and belongs to Codex's functional scope. This change adds CounterTradePanel immediately after the existing DCA component, without reordering or restyling any existing block. Claude's page, CSS and token-workspace files remain untouched.

This is the previously described bounded functional integration. No Claude approval is claimed; the notice asks for coordination before layout edits but does not explicitly require waiting for approval. Verification and a commit-scoped update will follow. No push, saved version, deployment, hosted SQL or transaction is included.
Counter controls will also follow the existing DCA pattern: closed by default, with an explicit Open/Close control. This keeps the session workspace compact and avoids reading Counter history until opened. Only Codex's Counter component and tests will change for that behavior; closing will cancel client reads without altering saved plan state.
