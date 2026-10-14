# Solana wallet sign-in

Local implementation checkpoint, 14 October 2026. Production is unchanged.

The user requested the previous choice of Google or wallet login. New Vercel hosting uses Bundle's Better Auth sessions rather than the old Sites identity. Google OAuth code already exists, but its consent agreement and provider credentials remain pending. The user previously chose to review that agreement personally. No Google agreement was accepted and no OAuth credential was created in this checkpoint.

## Implemented

- Continue with wallet discovers installed Wallet Standard wallets with Solana message signing. Connecting and signing require the user's wallet approval.
- POST `/api/auth/solana/challenge` generates an exact server-owned domain/address/nonce/expiry message, a signed HttpOnly browser cookie and a five-minute database challenge.
- POST `/api/auth/solana/verify` requires that browser cookie and exact request origin, atomically consumes the challenge with `DELETE RETURNING`, verifies Ed25519 against the stored message, and creates a normal Better Auth session cookie. Plugin endpoints use database-backed rate limiting.
- Concurrent first logins converge on a deterministic wallet identity with an atomic user/account batch. No email lookup or implicit account merge occurs. Placeholder addresses use the reserved `.invalid` domain and remain unverified.
- Wallet accounts reopen with the same wallet and remain separate from existing email/Google profiles. They do not offer the currently email-matched Google link action.
- Existing Google and email login remain available according to provider configuration. No wallet secrets, RPC, on-chain transactions or fees are involved in authentication. Signing a login message does not approve later trades.
- Uses existing authentication tables. No migration or hosted SQL is required.

## Verification

Node 24: six focused test files, 22 tests passed. Real disposable libSQL and Ed25519 tests cover session creation/reopening/revocation, browser and origin binding, bad signatures, modified messages, expiration, concurrent replay, concurrent first logins across two auth instances and input overrides. UI tests cover cancellation, wrong-site messages, wallet changes, missing wallets and Google/email regressions.

TypeScript, scoped typed lint, production build and `git diff --check` pass. An initial standalone typecheck overlapped Next's regeneration of `.next/types` and failed on missing generated files; the sequential check after the build passed. The build includes the pre-existing untracked initial-buy research files, but those are excluded from this commit and have no new routes/UI.

Chrome rendered the actual local sign-in page and detected Phantom, MetaMask and Jupiter. At 390px viewport width, document width was 375px with no horizontal overflow. Screenshots are ignored local artifacts under `work/wallet-login-desktop.png` and `work/wallet-login-mobile.png`.

## Remaining

No real wallet was connected or asked to sign. No successful real-extension login or hosted flow is claimed. Production deployment and a human-approved real-wallet login check remain outstanding. Google requires completion of its consent configuration and OAuth credentials before deployment can enable that provider. Wallet authentication does not depend on Google setup. Cross-provider wallet linking and recovery are not implemented.

No push, deployment, hosted SQL, provider change or transaction occurred. Main's unrelated dirty files and the initial-buy research remain separate.

Protocol references: [Solana message authentication](https://solana.com/docs/frontend/messages-and-auth), [Better Auth plugin endpoints](https://better-auth.com/docs/1.6/concepts/plugins). Implementation also follows the installed Better Auth 1.7.7 session/cookie APIs and Wallet Standard types.
