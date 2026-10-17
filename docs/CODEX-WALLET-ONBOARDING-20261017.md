# Guided browser wallet creation

The user requested a real locally generated wallet for the signed-in warmup check and simpler first-use UX. This follows the successful Solana login and zero-wallet workspace recorded in CODEX-LOCAL-HTTPS-20261017.md.

## Change

Create wallet now opens a focused form. It uses Wallet password and Confirm password wording, retaining the 12-character minimum. Submitting it creates exactly one wallet, encrypts and persists it locally, then saves only its public address to the authenticated workspace. Existing vaults must be unlocked and are extended using the existing ciphertext conflict guard. The confirmation offers an encrypted backup and Continue to warmup, which selects the new public wallet and opens its warmup panel. The vault locks when leaving the dialog.

A failed public-address save retains the encrypted wallet and offers a save retry without generating another key. A storage change during pending creation cancels generation/publication. Existing crypto, passphrase requirements, visibility/idle locks, import/export and ownership-signing controls are retained. Restore is collapsed on first use; advanced operations remain under Browser vault. Removed the stale blanket claim that mainnet execution is unavailable.

The local HTTPS filter now accepts exactly one Solana wallet.add public-address object with no additional wallet/body fields. It rejects bulk/EVM additions, extra secret fields, other wallet mutations and all transaction registration/submission. Production API validation/ownership checks are unchanged. No credential, provider, deployment or SQL change is included.

## Validation

- Five mounted UI cases cover one-wallet generation/encryption/public save/continuation, retained-key retry, passphrase mismatch, existing ciphertext preservation and pending storage invalidation. Crypto and ownership regressions bring this run to 24 tests across three files, all passing.
- Three local guard tests pass, including real HTTP forwarding and refusal before upstream, plus the narrow public-address shape.
- Plain TypeScript check and scoped lint pass.
- Production webpack build passed. The search-clearing integration also passed a production build. Browser review then caught and corrected a stale submit-button caption; the final password-wording build and form evidence are recorded below. The superseded reviewed build was cancelled after the other chat relayed the user's explicit password-wording request, which was verified in that thread.

## Scope and remaining handoff

The agent does not choose, enter, read or submit the user's new vault passphrase. Browser credential rules require the user to complete that step themselves. No real wallet has yet been created by this change's automated checks; mounted tests use synthetic public fixtures and mocked vault operations. The real wallet creation and unfunded warmup inspection remain pending that handoff. No trade is signed or sent; the local edge keeps transaction registration/submission blocked.

Concurrent warmup preflight/quote/read-panel work was independently committed as 0e23d73 and 4878b66 during validation. Those files were preserved and are excluded from this checkpoint. This is local-only work, with no push or deployment.


The user explicitly authorized coordination in the Study and use REA chat. Read the actual user request there before messaging that chat. Ownership was agreed: this chat owns wallet onboarding and HTTPS build/restart; that chat owns warmup panels and read-only follow-up. No parallel edits to those owned files or shared build/server operations are intended.


## Final browser checkpoint, 18 October

The final password-wording production build exited 0 (work/release-qa/wallet-password-final-build-20261017.log). The HTTPS server was restarted with certificate reuse; runtime handle 95223. Chrome's previous tab could no longer attach, so a new tab was opened in the same Chrome profile at the same HTTPS origin. Its existing signed-in account/session and saved ROADSTER import loaded correctly. My wallets loaded zero saved addresses. The actual Create wallet dialog now shows Wallet password, Confirm password and Create wallet, with Restore a backup instead collapsed. Both password fields were left empty and focused for the user. Screenshot: work/release-qa/wallet-password-ready-20261018.png. Handoff tab ID 1751427517.

The final five mounted UI tests were rerun and pass after the wording correction; scoped lint passes. The earlier 19 crypto/ownership cases and three guard cases passed unchanged. The real wallet-specific warmup check remains explicitly pending the user's own password entry and submission. No real key was generated, password entered, trade signed/sent or deployment performed by the agent.
