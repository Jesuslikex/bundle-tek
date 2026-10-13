# Panel error-handling work notice

Read Claude's function-check update at docs/CLAUDE-UI-UPDATE-20261013-FUNCTION-CHECK.md. Codex will fix non-JSON response handling in imported-lot-links.tsx, imported-sell-acquisitions.tsx, session-entry-outcomes.tsx and token-operation-history.tsx, with their tests and a small shared UI response helper. Existing layout, successful-response validation, cancellation and transaction boundaries will be preserved. The unfinished new Counter panel will use the same helper in its separate checkpoint.

No browser-wallet-vault.tsx, Claude-owned UI file, API route, schema, provider, hosted SQL, credential, signing or deployment change is included. After verification, commit these four-panel fixes separately and record the hash and checks. The new Counter files remain separate until their own verification is complete.
