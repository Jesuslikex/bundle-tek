# Merged Desktop build and browser verification

17 October 2026. Actual checkout: `C:/Users/Julian/Desktop/Bundle`, branch `codex/warmup-flow-clarity`, source checkpoint `fa9f014` with merged application source `553cbde`. The worktree and index were clean before validation. No application, test, configuration or warmup source was changed for this task.

## Production build

Bundled Node 24.19.0 ran `node_modules/next/dist/bin/next build --webpack` in the actual Desktop checkout. Terminal exit 0: webpack compiled, TypeScript passed, all six static pages generated, tracing and function packaging completed. Both `/marketplace` and its catalog API are in the output. Log: `work/release-qa/desktop-browser-build-20261017.log`.

Next reported an ignored unrelated parent-directory lockfile. This did not fail the build and no tracing configuration was changed. Next loaded the checkout's existing local environment normally; no environment file, value or credential was read, printed, edited or copied by the agent.

Another local Next build started while verification was running and replaced the shared `.next` output. The first production-server start therefore refused because BUILD_ID was temporarily absent. The other build was left alone. After it finished, the production server started successfully on `http://127.0.0.1:3187`. No process belonging to another task was stopped. The application source hash remained unchanged throughout.

## Actual production-build browser checks

Used a new tab in the existing Chrome profile. Verified dashboard rendering, My wallets, the Generate wallets entry point, Wallet marketplace / PREVIEW navigation, catalog rendering, and its explicit refresh/error response. The built wallet screen contains the warmup entry, disabled because authenticated wallet data is unavailable. No real wallet was created, connected, unlocked, selected for trading, signed or funded.

Authenticated local HTTP behavior is blocked by the existing production auth guard. The server reports `Authentication requires a secure origin.` Wallet/imported/shared-project screens show service messages; the marketplace returns its distinct AUTH_UNAVAILABLE message. This is a local-origin limitation, not proof of authenticated production loading or a production authentication defect. No auth guard was weakened and no HTTPS warning was bypassed. The signed-in production warmup flow was not qualified.

Actual-build evidence: `work/release-qa/merged-built-wallets.png` and `merged-built-wallets-ax.txt`, `merged-built-marketplace.png` and `merged-built-marketplace-ax.txt`. Final server log: `work/release-qa/desktop-browser-server-final-20261017.log`.

## Warmup browser checks with the merged production components

Reused the existing isolated Vite harness at `http://127.0.0.1:4186` in a separate new Chrome tab. Its server and aliases were inspected first. It imports the actual merged warmup components, current production styles and tracked `test/warmup-ui-fixture.ts`. Its separate env directory does not load the checkout's environment; all fetches are intercepted, unmatched requests return a fixture refusal, the browser vault and signer are stubbed, and real external-wallet connection/signing is disabled. The only packet and signature outputs are invalid fixture markers. The prominent synthetic/no-provider/no-vault/no-broadcast notice remained visible. These are component/browser workflow checks, not the authenticated Next API or real provider execution.

- Buy: prepare and display simulation evidence, request eligibility, observe signing disabled until explicit review and fixture passphrase, invoke only the stub signer, observe Submit independently disabled until its initially unchecked send approval, invoke the intercepted fixture submit, then verify the fixture finalized buy receipt.
- Linked sell: use the new buy-to-sell handoff, explicitly select Use matched buy amount, observe the 1,000,000 atomic-unit remaining-lot cap, check unfrozen synthetic inventory, prepare Sell and repeat the separate review/sign/submit/receipt steps. Each sell consent starts unchecked, independent of the buy consent.
- Final cycle progress showed 1/1 recorded wallet cycles sold, zero remaining lot units and zero active approvals. The displayed fixture accounting was a loss of 0.00011 SOL, not a profitability or readiness claim.
- Recovery: choose the blocked-approval scenario, open its exact wallet recovery from cycle progress, observe the saved unsigned approval, cancel it through the fixture, then observe Cancelled and the active approval count fall from one to zero. No replacement transaction was created.
- HTML-error scenario: preparation showed `Warmup preparation unavailable. Try preparing again.` without parser text or signing controls.
- Planner: check bounded synthetic wallet history, configure one cycle and a future start, review the budget, observe Save become enabled, then save through the intercepted fixture. The screen explicitly reported `Warmup plan saved. No swaps scheduled.`

Evidence: `work/release-qa/merged-warmup-complete.png` and `merged-warmup-complete-ax.txt`, `merged-warmup-recovery.png`, `merged-warmup-planner.png` and `merged-warmup-planner-ax.txt`. Existing fixture service was reused and left running; no production data or provider was involved. Browser screenshots use the existing desktop viewport. Mobile rendering was not repeated in this task.

## Final integrity and limits

All 1,596 source files matched `work/release-qa/desktop-browser-source-20261017.json` immediately after the build and browser checks: digest `7c83f1fc4cd8a069edd732fe4669c106284d3ed99838b312e861e5fcb1b254ea`, changed files empty. A concurrent handoff then added documentation-only commit `c2ce99c` and normalized 26 working-copy files from LF to CRLF. Final verification independently compared every changed file with the original `fa9f014` Git blob: all 26 differences are line endings only, with zero unexplained content changes. The original and current hashes both correspond to the same canonical source bytes. Report: `work/release-qa/desktop-browser-eol-verification-20261017.json`. Warmup source content and the original warmup notes are unchanged; no concurrent file was overwritten. Only this verification note is staged by this task. No test suite was rerun because there was no code change; the preceding 93-test merged-checkout result retains its own scope in CODEX-DESKTOP-MERGE-20261017.md.

Authenticated persistence, actual provider simulation/routing, funded receipt recovery and real transaction safety remain unverified by this browser run. No push, deployment, SQL, scheduler, provider/credential setting change, real wallet unlock/signature or transaction occurred.
