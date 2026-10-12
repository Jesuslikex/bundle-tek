# Watch wallet baseline persistence fix

## Task

Implement the Watch wallet persistence fix in the current Bundle checkout. This is an ordinary application bug fix already requested by the user. Summarize the scoped changes and proceed; another approval is not needed for local code changes and targeted checks. Preserve all existing dirty work. Commit history is not required; do not retry or circumvent the blocked git log call.

## Concrete failure

In components/imported-supply-tracker.tsx, watch(owner) creates a client-only WorkspaceWallet with revision 1 and selects it as external. It never saves the owner to workspace_wallets.

In app/api/imported-projects/supply-history/route.ts, POST checks every scope member against the authenticated user's active saved Solana workspace_wallets. Any missing member produces HTTP 409 with "Select active saved Solana wallets." Therefore a newly watched sampled holder cannot save the baseline through the real API.

This is the intended fix. Disabled-button explanations are a separate UI improvement, not the reported defect. The earlier browser QA used in-memory history writes and did not exercise this route guard.

## Expected behavior

Click Watch wallet on an active project's sampled holder. Persist that public address through the existing authenticated /api/wallet-workspace wallet.add action before selecting it for monitoring. Use chain Solana and role Recipient; this is public watch-only tracking, not proof of ownership or signing capability. Clearly tell the user that watching saves a public address to their wallet roster.

Use the real returned workspace wallet record instead of fabricating revision/updatedAt. Reuse an existing active saved record when applicable. Handle archived records and failures explicitly; do not silently unarchive a record or show a false success. Keep duplicate requests and cap races from adding invalid selections. Preserve the 12-wallet monitoring cap and project archive checks. Do not add keys or signer permissions.

Once persistence succeeds, select it as external and open Wallet alerts. Save baseline through the actual history route, then a second changed observation should produce a movement alert. A failed save should leave the prior scope intact and show a useful error.

Keep the supply-history server ownership/active-wallet checks intact. Do not loosen the route to accept arbitrary unsaved addresses.

## Scope and verification

Start with components/imported-supply-tracker.tsx and the existing wallet-workspace request/response helpers. Add meaningful focused tests for persistence before selection, failure handling, and reuse of existing wallets. Exercise the real supply-history route with an active saved wallet and verify baseline, subsequent observation, and alert behavior using mocked RPC rather than funded transactions. Extend existing route fixtures if needed; no schema change should be necessary.

Run the relevant targeted tests and TypeScript/lint checks. Report exact changes, check results, and remaining limits. No funded signing, transactions, provider credential changes, paid setup, publication, or deployment is part of this task.
