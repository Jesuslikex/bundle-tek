# Trusted local HTTPS for signed-in warmup verification

17 October 2026. Desktop Bundle, based on `9ce8de7`. This adds local development/verification tooling; it does not change the deployed app, auth guards, wallet signing code, providers or database schema.

## Start and trust

After the existing production build, run from PowerShell:

```powershell
.\scripts\start-local-https.ps1
```

The default is https://localhost:3443. The launcher requires Node 24 and defaults to this machine's bundled Codex Node path; `-NodePath` can select another Node 24 executable. It creates a 30-day localhost TLS server certificate in the Windows CurrentUser certificate stores. Its public certificate is trusted only for this Windows user. No system-wide certificate store, provider credential or environment file is changed.

Private TLS material is in ignored `work/local-https/`: an encrypted PFX plus a password protected with Windows DPAPI, bound to this user and machine. Never commit or share those files. The public `certificate.json` records the thumbprint and expiry. The launcher reuses that certificate, refuses expired/untrusted state, and restores its process environment on exit. Stop the server with Ctrl+C.

To remove the local trust later, inspect `work/local-https/certificate.json` and remove only that exact thumbprint from `Cert:\CurrentUser\Root` and `Cert:\CurrentUser\My`. Removing it makes this local HTTPS certificate unusable; do not remove unrelated localhost certificates.

## Process-only auth origin and request filter

`scripts/local-https.mjs` serves the existing Next production build. It sets `BETTER_AUTH_URL=https://localhost:3443` only inside this local Node process. Next sees that exact public HTTPS hostname/port and origin. Better Auth's existing CSRF, origin, session and secure-cookie checks stay enabled.

Both listeners bind only to 127.0.0.1. The private upstream on port 3188 requires a fresh random in-memory edge token, so directly requesting it cannot bypass the verification filter. The TLS edge overwrites forwarded origin headers and preserves auth cookies. It never logs request bodies, passwords, cookies, signatures or tokens. Request bodies are bounded at 64 KiB.

This local origin defaults to refusing POST/other writes unless explicitly listed for verification. Allowed: email sign-in/sign-out, Solana wallet challenge/verify, warmup history/preflight/quote/unsigned preparation/balance inspection, saving public warmup drafts and review/cancel/recover of warmup approvals. Warmup `register` and `submit`, withdrawals, launches, imported swaps and other mutations are refused before Next receives them. This is a local transport guard, not a new production security boundary.

Wallet sign-in uses a user-approved authentication message, not a trade transaction. The actual login component requires a compatible Solana account and a message that says `Sign in to Bundle Tek. This does not authorize transactions.` Wallet and email accounts remain separate. Creating an email account, wallet generation/import and Bundle-vault unlocking are outside this verification mode. Do not sign trade packets even though the normal UI may still show its signing control; the guarded origin refuses packet registration and submission, but does not replace a browser wallet's own controls.

## Verification so far

- Chrome opens the trusted HTTPS sign-in page without a certificate-warning bypass. Windows HTTPS validation passes.
- Actual `/api/auth/ok` and `/api/auth/get-session` return 200, with the latter initially signed out. The old secure-origin exception is resolved.
- A synthetic, nonexistent email account produces the expected 401 `INVALID_EMAIL_OR_PASSWORD`; no account was created and no real password was read.
- The first local filter omitted wallet-login challenge/verify, which blocked the user's MetaMask attempt. Those two authentication endpoints are now explicitly admitted. Runtime probes with invalid empty bodies reach the auth validation layer (400 `VALIDATION_ERROR`, not the local filter). Trading endpoints remain blocked.
- Actual transaction-submit and direct-private-upstream probes both return HTTP 403. Nothing is submitted to a provider.
- `node --test scripts/local-https-guard.test.mjs`: two passing suites/cases exercising the action allowlist and real local HTTP forwarding, secure cookie retention, overwritten forwarding/edge headers, rejected submission/registration and unrelated writes, wrong host/origin, malformed/non-JSON/oversized bodies and unsupported methods. Scoped typed lint and formatting pass.
- PowerShell certificate creation/reuse and the production HTTPS startup both succeeded. Private material stays ignored under work; only scripts and this note are intended for Git.

The user then completed Solana wallet sign-in. The actual HTTPS dashboard rendered a signed-in account, its existing saved import and live source-backed panels. My wallets loaded successfully with zero saved addresses and no service-unavailable error. Consequently Wallet warmup is correctly disabled until an intended public Solana address is saved and selected. The user has been asked which public address to use; no address, wallet or key is fabricated for this real check.

An earlier MetaMask attempt reported that its connected account did not advertise Solana message signing. That account-capability check was retained; it was not bypassed and the login component was not changed. After the user retried Solana, the HTTPS session succeeded. Official MetaMask documentation confirms its Solana message-signing feature, but this run does not establish why the earlier selected account lacked it.

Actual signed-in warmup preparation remains pending the user's public wallet selection. No claim of completed real warmup, funded execution or provider repeatability is made. No trade was signed or sent, no deployment/push occurred, and no production environment setting was changed. Concurrent commit ea0a120 adds Git/deployment configuration independently; this task does not edit or stage those files.
