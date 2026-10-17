# Combined main and marketplace verification

17 October 2026. Local integration branch: `codex/bundle-integration-qa`.

## Source and ownership

The user approved integrating the latest main features with the wallet marketplace and checking the main flows. A separate managed worktree preserves the active wallet-warmup edits in `C:/Users/Julian/Desktop/Bundle`. Those edits and untracked fixtures are excluded from this candidate.

Merge checkpoint `17c292d86f09d31b49ecdb904846e228f9b2742f` combines marketplace `dc5da24` with fetched `origin/main` `066d47fd7bf3bccb3e4f6744709ef712115f0caa`. The merge was conflict-free. It brings in Clanker on Base, pons.family, narrative discovery, wallet generation navigation, liquidity creation/Robinhood support and the related funding-map throttling and approval checks. This records source integration, not independently proven live execution for those features.

## Integration changes

- `app/page.tsx`: adds a Wallet marketplace / PREVIEW navigation button. It uses the existing save-busy lock and unsaved-draft discard/cancel guard before opening `/marketplace`.
- `components/use-imported-projects.ts`, `components/wallet-workspace.tsx` and both GET paths in `components/project-sharing.tsx`: use the new `lib/workspace-response.ts` reader for initial/reload reads. HTTP 401 gets an explicit sign-in message, except the shared-with-you list retains its existing hidden/signed-out behavior; other HTTP failures and non-object/malformed successful bodies get a plain service message. Existing collection validation and cancellation remain in the consumers. Sharing POST actions, permissions, authentication and backend acceptance rules are unchanged.
- The reader fix follows an actual local Chrome failure: absent local authentication caused HTTP 500 responses with empty bodies, and the sidebar, wallet screen and shared-project list displayed raw JSON parser errors. It does not repair or configure the absent authentication service.

## Validation

- Node 24.19.0. The isolated dependency install used the locked package tree with install scripts disabled; npm ran under the machine's Node 26 and reported the expected project engine warning. All application validation commands explicitly use the bundled Node 24 executable.
- Merged baseline: 13 feature files / 53 tests, standalone TypeScript, scoped typed Oxlint and production build passed.
- Core wallet/launch cohort: 16 files / 138 tests passed on the merged source. This run covers vault handling, launch plan/wallet/timing/method rules, group review/signing/recovery, launch history, broadcast consent/recovery, Organic holder buys, scheduling, Nuke batch and finalized token-workspace handoff. It started before the final client error-message edits; it is not a final whole-repository suite.
- Final feature/error-response cohort: 16 files / 68 tests passed. This includes all 53 feature cases, 11 response-reader regressions for empty/HTML HTTP errors, sign-in failures, malformed successful bodies and valid objects, and four sharing component cases. The two new mounted component cases exercise actual failed GET reads and assert that no invite POST is made. Report: `work/release-qa/final-integrated-tests.json`.
- All seven changed application/test files pass scoped typed Oxlint, Oxfmt and diff whitespace checks. React review found no new hooks, fetch waterfalls, listener/storage changes or signing authority; navigation retains the existing guard and the readers retain their callers' cancellation checks.
- Final production webpack build exits 0, including its TypeScript, static generation and trace/packaging stages. Log: `work/release-qa/final-verified-build.log`. No credentials or local environment file were supplied. All 1,592 source files match `work/release-qa/final-source.json` after the build and browser check; SHA-256 digest `f2d314d729abf2234767f3836992017ccc03b363e185fc4cdade55f2f581980c`.

## Chrome verification

The existing Chrome session used a new tab against the actual Node 24 production server on loopback port 3187, with a 1920 x 855 viewport. This was the built application, without synthetic response injection.

- My wallets renders, and Generate wallets opens the encrypted-vault setup dialog. The dialog was closed without entering a passphrase, generating keys or restoring data.
- The wallet screen and imported-project sidebar display plain service-unavailable messages when the absent local authentication configuration produces empty HTTP 500 responses. After the final rebuild, the shared-project list also displays its plain service message. Server authentication errors remain expected, not a claim of successful authenticated loading.
- Create launch and Configure token open the actual chain and token draft screens. A temporary unsaved name, `Integration QA Draft`, was entered without saving. Marketplace navigation opens the existing unsaved-draft dialog; Keep editing preserves that exact name. A second navigation with Discard changes opens `/marketplace`. Only this temporary unsaved QA draft was discarded.
- The catalog clearly labels checkout unavailable and initially has no invented rows. Refresh inventory reaches the actual API and shows its distinct AUTH_UNAVAILABLE message. Back to Bundle workspace returns to the dashboard. No supplier request or successful authenticated catalog is established by that check.
- Ignored local evidence: `work/release-qa/wallet-workspace.png`, `draft-guard.png`, `marketplace.png`, `marketplace-ax.txt`, `final-dashboard.png` and `final-dashboard-ax.txt`. Mobile rendering, authenticated persistence, real supplier data, funded launch/trade flows and production behavior were not verified in this run.

## Limits

This is a local candidate, not an update to the original checkout's main or marketplace branch and not a deployment. No full-suite pass for this combined source is claimed. No production credentials were copied into the isolated worktree, no provider/supplier was configured, and no remote SQL, signing, live transaction or push was performed. Marketplace remains a catalog preview without checkout. Stock repeatability and Counter execution remain separate unfinished work.
