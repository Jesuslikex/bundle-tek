# Funding to Operations preview

This follow-up to PR 76 adds an optional non-Solana funding-screen action that calls a supplied navigation callback. It does not transfer, fund or sign anything. Solana funding does not show the action.

The protected `app/page.tsx` is unchanged. The proposed callback wiring is in `docs/patches/CODEX-FUNDING-OPERATIONS-20261101.patch`; it uses the same `changeView('live')` path as the existing Plan tools sidebar and has passed `git apply --check`. The button is not connected in the real app until that patch is reviewed and applied by the owner.

Three focused files / six tests passed on Node 24, and scoped lint passed. No full app browser verification, hosted changes, signing or funded activity was performed for this change.
