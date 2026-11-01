# Google consent release evidence, 1 November 2026

Claude was sole deploy owner for this release. Julian authorized it in the project thread ("deploy", 19:15 UTC) for PR #75 only.

## Source

- Deployed commit: `e10f0be3965990ef376ce6c4c7705983adc3f27b` on `main`, the merge of PR #75.
- Parents: `1d30b4b` (previous production source) and `012a448` (reviewed PR head on `codex/google-consent-20261101`).
- `git diff --quiet 012a448 e10f0be` exited 0: the deployed tree is identical to the reviewed PR head.
- `1d30b4b..e10f0be` changes exactly five files: `AGENTS.md`, `app/about/page.tsx`, `app/privacy/page.tsx`, `app/privacy/privacy.module.css`, `docs/CODEX-GOOGLE-CONSENT-20261101.md`.
- No migration beyond `0162`, no new environment variable reads, no auth, schema, provider or signing change. `proxy.ts` only matches `/api/*`, so both new pages are public.

## Release

- Built from a separate clean clone, not `Desktop\Bundle`. Before deploying, the clone was reset to `origin/main`, `git status` was clean and no `.env*` files were present.
- `vercel deploy --prod` from that clone, with nothing run in between, created `dpl_53ojPfwjgVu71uKGpjjajWaULDS9` at 19:17:12 UTC.
- Deployment URL: https://bundle-qp5qhklnz-jesuslikexs-projects.vercel.app
- Aliases: https://bundle-tek.vercel.app and https://bundle-tek-jesuslikexs-projects.vercel.app. Target production, status Ready.
- This was a CLI upload, so Vercel stores no git commit metadata for it. The link between the SHA and the deployment rests on the clone checks above.

## Checks

- Signed out: `/`, `/about`, `/privacy`, `/sign-in` and `/marketplace` returned HTTP 200, and `/api/marketplace/reservations` returned 401.
- `/sign-in` rendered a "Continue with Google" button. Claude did not click it.
- Codex separately verified the live Google flow: only the openid, email and profile scopes were requested, it used the production callback, and Julian approved the consent. No wallet or funds were touched.

## Not changed

No environment variables, hosted SQL, migrations or 2FA were touched, and no wallet, signing or funded actions occurred. PR #74, migration 0163 and 2FA remain held.

## Notes

- The last added line in `AGENTS.md` starts with a stray literal `` `n `` left by a PowerShell newline escape. It is cosmetic.
- `/privacy` publishes the operator contact address chosen in PR #75.
