# Local email account creation repair

## Confirmed cause and change

The user reported Unable to sign in after submitting Create account in the actual built-in browser on https://localhost:3443/sign-in. The form retained the new eight-character requirement. The local HTTPS verification guard allowed /api/auth/sign-in/email but explicitly refused /api/auth/sign-up/email before the application. Its refusal JSON had no message field, so the auth client displayed the generic login fallback even during registration. The prior password checkpoint verified the application handler and browser rule separately and missed this edge-to-handler boundary.

Added the exact email signup path to the existing authentication POST allowlist. Authentication still validates name/email/password, protects origin/CSRF, hashes passwords and creates sessions normally. Guard refusals now include a client-readable message while preserving their existing error and code fields. No other mutation route is admitted; transaction registration/submission, withdrawals and launch writes remain refused. The application UI and authentication code are unchanged from the previously built password checkpoint. No rebuild was necessary for this runtime-script change.

## Verification

- All three Node HTTP guard tests pass. The forwarding case now explicitly proves signup forwarding, retained secure-cookie/header behavior, client-readable refusal messages and refusal before upstream for transaction writes, foreign origin/host, non-JSON, malformed/oversized data and unsupported methods.
- Fifteen cases in lib/auth.test.ts, app/sign-in/sign-in-form.test.tsx and app/sign-in/wallet-login.test.tsx pass. The new composed test exercises actual HTTP edge -> actual Better Auth handler -> disposable real libSQL -> cookie-authenticated session for an eight-character account creation/sign-in, and proves transaction submission never reaches that upstream. Synthetic test credentials exist only in this disposable test database.
- The first composed-test attempt was correctly refused because Node fetch did not preserve its requested Host header. The harness now uses actual Node HTTP requests with the precise Host/Origin, as the existing guard tests do. The guard's exact-origin rule was not relaxed.
- Plain TypeScript and three-file typed lint/format/diff checks pass. No new full-suite or production-build claim; the application bundle was not changed.
- Restarted only the owned guarded localhost launcher (PowerShell42632). Actual HTTPS auth health200; POST /api/auth/sign-up/email with empty JSON returns400 VALIDATION_ERROR from the application with missing name/email/password, proving the former guard403 is removed without creating an account. Actual transaction-submit probe remains403.
- The real browser form and the user's typed entries are preserved. Password values, email values, keys, cookies and browser storage were not inspected. The user must retry Create account themselves; a successful real user registration/session and mobile warmup acceptance remain pending that action. No real account was created/submitted by Codex, no password reset/account linking, no funding, signature, transaction, provider/credential change, push or deployment.

## Collaboration

Main was inspected before editing. The other chat's MEV work was committed independently as d49295d while this change was tested. Only the two local guard scripts, lib/auth.test.ts and this note belong to this checkpoint. Its earlier staged test-discovery work and MEV files were preserved.
