# Warmup save recovery UI scope

19 October 2026. Codex owns only `components/wallet-warmup-plans.tsx`, its tests and focused QA documentation for this step. Existing wallet creation, vault/password, protected layout, account sessions, funding handlers and transaction consent remain unchanged.

Confirmed source issue: pending save recovery remembers only the plan ID. After cancelling an update, a reload of the previous revision can clear the warning and replace the current form as though the update completed. Recovery must compare the expected next revision and the exact normalized submitted document, while preserving edits and requiring explicit reopening when storage differs. A normal successful mutation must also verify its reloaded draft before showing success.

No deployment, hosted SQL, provider settings or funded wallet action. Actual Opus 5.5 review will be requested with tools disabled; Codex owns verification.
