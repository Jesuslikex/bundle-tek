# Account password and sign-in repair

The user explicitly requested a shorter account password minimum after the real account-creation form refused their nine-character password with a twelve-character browser validation message. This is an account-login change. Browser wallet encryption already has an eight-character minimum and is not edited.

## Changes

- New email accounts require at least eight characters. A shared constant in lib/account-password-policy.ts supplies both the Better Auth server rule and registration form.
- Registration explicitly displays the eight-character requirement with an accessible description on the password field.
- Existing-account sign-in no longer applies a registration minimum in the browser. The server still verifies the actual saved password; this does not change, reset or recover an existing password.
- Existing origin/CSRF checks, authentication/session handling and wallet/email account separation are preserved. No credential, provider, database schema, deployment or transaction setting is changed.

## Validation

- Fourteen focused cases across lib/auth.test.ts, app/sign-in/sign-in-form.test.tsx and app/sign-in/wallet-login.test.tsx pass. Disposable real libSQL and actual Better Auth handlers verify seven-character signup rejection without creating a user, eight-character signup and subsequent cookie-authenticated sign-in, and wrong-password rejection. Mounted UI checks verify eight-character signup help, password-manager autocomplete, and removal of the registration minimum when switching back to sign-in.
- Plain TypeScript, five-file typed lint, scoped formatting and diff checks pass.
- The coordinated production webpack build exited0: compile33.8seconds and TypeScript18.2seconds. Log: work/release-qa/account-password-build-20261018.log. It includes the frozen display-only MEV changes owned by the other chat, which are not staged here.
- Restarted only the owned guarded HTTPS launcher (PowerShell43412). Auth health returns200 and transaction-submit probe returns403 before upstream. No deployment occurred.
- In the actual Codex browser2/tab2, reloaded /sign-in: existing sign-in has no minlength attribute; switching to Create an account gives minlength8 and the visible accessible eight-character help. The real form was checked at375x850 with innerWidth375, document clientWidth360 and scrollWidth360, so no horizontal overflow. Screenshot: work/release-qa/account-password-phone-20261018.png. Viewport reset succeeded and was verified at normal innerWidth610/clientWidth595/scrollWidth595. The empty account-creation form is retained for user entry.
- No real user account is created or submitted by Codex, and no password value is inspected or entered. The user must enter and submit any new password themselves. Existing incorrect-credential errors are not bypassed; the shorter creation rule is not proof of a previously registered email account or access to the separate wallet account.

## Collaboration

The other Bundle chat owns the dirty MEV display notice and its three review panels/tests. It explicitly froze application source for one combined build. Those files are excluded from this checkpoint; the guarded local HTTPS server remains owned by this chat. Existing wallet-to-warmup mobile acceptance still requires access to the user's account in a controllable browser and is not proven by these authentication fixtures.
