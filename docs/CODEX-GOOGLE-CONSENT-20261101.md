# Google consent release handoff

1 November 2026. Codex owns this bounded change; existing Claude Opus release thread is the sole deploy owner. Base origin/main: 1d30b4b. Primary Desktop/Bundle dirty files preserved; separate codex/google-consent-20261101 worktree.

## Configuration completed

- Google Cloud project bundle-tek, client Bundle Tek Production, Web application.
- Exact authorized callback: https://bundle-tek.vercel.app/api/auth/callback/google.
- GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET configured for Vercel Production and verified by metadata only. Secret never printed or committed; transfer clipboard cleared.
- MARKETPLACE_KEY_SECRET was previously configured in Production. Do not replace it: existing delivery ciphertext depends on it.
- Google remains external Testing, zero users. Publishing disabled pending branding. Existing support/contact address juliancool48653@googlemail.com retained. Production homepage saved in Google; after deploy set homepage to /about and privacy URL to /privacy, then reassess publishing requirements. No terms URL invented, no logo uploaded, no additional scopes requested.

## Source change

Public /about describes the app and links /privacy and /sign-in. Public /privacy explains Google identity, auth records/tokens/session data, saved projects and public blockchain data, browser vaults versus server-encrypted marketplace keys, providers, retention limitations and operator contact. No claim that encrypted server keys are inaccessible to the operator, or that immutable evidence can be erased. No protected parent, auth behavior, account linking, schema, financial guard or signing changes.

## Verification

- Node 24: whole-project TypeScript exit 0.
- Existing auth and sign-in suites: 2 files, 11 tests passed, exit 0.
- Scoped lint/format and git diff check passed.
- Actual connected Chrome: /about and /privacy rendered locally without authentication, privacy link navigation works. Desktop screenshot retained in ignored work/privacy-desktop.png. No mobile or end-to-end production OAuth claim yet.
- Next dev emitted an upstream security-upgrade notice before continuing on its ordinary second invocation. Dependency upgrades are outside this patch; release owner should assess separately.

## Release order

1. Merge the bounded public-page change through PR; deploy committed source only through existing Claude release thread.
2. No remote SQL, 2FA feature flag, wallet action or funded test. If newer main introduces schema dependencies, explicitly review scope before deploying it; do not automatically migrate.
3. Report deployment ID and exact source commit; verify production /about, /privacy, /sign-in and private API refusal.
4. Codex completes Google branding URLs after public pages are accessible, then inspects the publish dialog. Any new agreement or material access expansion requires its action-time confirmation.
5. Verify Google authorization request/callback binding and basic identity scopes. Full sign-in is only verified after a user-approved Google identity returns to a real Bundle session. Do not claim success from the button alone.

Reference: https://developers.google.com/identity/protocols/oauth2/production-readiness/policy-compliance
