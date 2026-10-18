# Easier wallet-to-warmup flow

User requested simpler setup and remaining dead-end repairs, with the existing wallet kept unfunded, no transactions/deployment, and local commits. The selected Page was read and contained no project instructions or attachments. Existing generated wallet and HTTPS session are preserved. No new wallet or password is created by this change.

## Changes

- Warmup opens directly from each active wallet row. The header action also uses the sole visible wallet when nothing is selected, removing an unnecessary selection step. Existing archive, loading and selection-count guards remain.
- Warmup is organized into wallet check, draft setup, and review/save. An explicit USDC preset avoids copying a mint address. Custom tokens remain available. The initial form shows the buy amount; cycle count, interval, reserve and custom timing are under Budget and timing options. Full amounts and timing remain visible in the review summary before any save.
- New drafts can choose a fresh start30minutes after the explicit Review click. Saved schedules are not silently changed. Review with fresh start loads a saved configuration for editing, invalidates its previous review, returns focus to setup and still requires separate Review and Save. Expired reviewed starts are refused locally before a save request with a recovery explanation. Server timing validation is unchanged.
- Native validation reveals its collapsed options section; an invalid/empty token selection reveals custom entry. This avoids an inaccessible hidden invalid field.
- Transaction preparation, signing/recovery and historical tools are collapsed under Transactions and recovery. No transaction is automatically prepared, signed or sent by opening, reviewing or saving a draft. The advanced controls retain their existing authorization rules.
- Initial loading, reloading and saving have a30-second deadline and explicit cancellation. Late cancelled responses cannot replace state or trigger an extra refresh. A new draft retains one ID across explicit save retries. Reload can reconcile a save that completed after cancellation, avoiding a silent duplicate new draft.

## Validation before the production browser check

-36tests in4component files passed, covering preset/fresh-review save, expired saved-plan recovery, hidden invalid input recovery, plan request timeout, late response suppression, stable retry identity and cancelled-save reconciliation, plus existing explicit signing/recovery and vault-onboarding fixtures.
-52additional tests in3distinct files passed across read-panel/model and real local-D1 plans-route coverage. These are disjoint files,88targeted cases total. Three local HTTP guard tests pass, including rejection before upstream.
- Plain TypeScript and scoped typed lint pass. Scoped formatting and diff checks are included in the final checkpoint. No full-suite or funded-execution claim.
- Isolated synthetic Chrome fixture4296 uses actual production components/styles with intercepted local responses and mocked vault/signing adapters. Verified preset->Review->Save, fresh-start recovery without automatic saving, advanced controls collapsed, and375px layout without horizontal overflow (document360px/client360px after scrollbar). Viewport reset afterward. Screenshot: work/release-qa/guided-warmup-phone-20261018.png. No provider, real key or valid signature is available in this fixture.

## Collaboration and limits

The other Bundle chat owns DCA HMS changes at88fdc2b and froze its sources for one combined production build. Its files are not edited/staged in this checkpoint. Auth, crypto, backend APIs, provider settings, deployment, wallet funding and SQL configuration remain unchanged. The existing localhost HTTPS edge still blocks transaction registration/submission. Real signed-in browser results follow below.


## Final production and signed-in check

The coordinated production webpack build exited0, including TypeScript (work/release-qa/guided-warmup-build-20261018.log). Scoped typed lint passes. Restarted the existing guarded HTTPS app as a hidden background process13512/Node34212, listeners127.0.0.1:3443/3188. Trusted HTTPS auth health returns200 and the actual transaction-submit probe returns403 before upstream. No provider/credential or security setting changed.

In the real existing signed-in Chrome tab1751427517: header Wallet warmup selected the sole wallet and opened setup without manually selecting a checkbox. USDC preset, collapsed custom/budget options and three-step setup rendered correctly. Review with fresh start recovered the old test draft; explicit Review then Save updated the existing Local unfunded wallet check fromr1tor2. The saved count remained1/100, with No swaps scheduled. Fresh real preflight identified USDC6decimals,0SOL balance and0.013SOL shortfall at slot458246540. The passed-start warning disappeared for the refreshed draft. Transaction and recovery controls remained collapsed; none were invoked. No wallet/password was created/unlocked, no transaction prepared/signed/sent and no deployment occurred.

Saved evidence: work/release-qa/guided-warmup-real-hold-20261018.png/.txt. After preserving this proof, closing warmup, deselecting the wallet and using its new row Warmup button also reopened and selected it correctly.

An additional signed-in375px viewport check stalled the browser-control connection before its result could be read. Rebinding and viewport-reset cleanup attempts also timed out. No real signed-in mobile pass or final viewport restoration is claimed. The earlier isolated375px check passed and its viewport reset succeeded. The final desktop/live result above was captured before the extra check. The app/server remain healthy; this interruption is not evidence of a diagnosed application defect. User can reopen the localhost tab in the same Chrome profile if a test viewport remains. Saved wallet/draft data persists independently of the tab. No code changes were made in response to an unproven cause.

## Browser recovery continuation

The signed-in phone-width blocker recorded below is now resolved. See CODEX-MOBILE-WALLET-WARMUP-20261018.md for the actual320/375/430px flow, local empty-tag guard repair, saved r2 persistence and final0SOL Hold evidence. The historical Chrome connection failure remains separate from the successful built-in-browser check.

After the user reloaded Chrome, browser inventory, session naming/tab listing and direct screenshot of the existing Bundle tab still timed out. No new application defect was established and no application code was changed. The guarded local HTTPS auth health returns200; the transaction-submit probe returns403. These probes use no authentication cookie, wallet key or transaction.

The user then explicitly requested the Codex browser connection. Opened the actual trusted HTTPS application in the built-in browser (browser2, tab2). Browser accessibility and screenshot capture work there: the real Dashboard rendered and its Sign in link opened /sign-in. This is a separate signed-out session; neither Chrome authentication nor its encrypted wallet vault was copied or inspected. The sign-in tab is retained for the user to sign in, with the wallet locked and no transaction approvals. The real signed-in mobile continuation remains pending that sign-in. Screenshot: work/release-qa/codex-browser-signin-20261018.png. Existing desktop and synthetic mobile evidence above remain distinct from this pending real mobile check.

On continuation the real sign-in UI displayed Invalid email or password after a user attempt. Expanding Continue with wallet reports No compatible wallet detected in the built-in browser. The previously verified account was wallet9PTw…7o7P. Source inspection of lib/solana-login.ts confirms that wallet accounts receive an internal placeholder email and are separate from email accounts. A Gmail address matching the user's suggested fragment was not verified: the shell has no configured database client environment, and protected configuration was not loaded for this lookup. No credentials, password values, wallet keys, browser storage or cookies were read. No account was created or linked. Real signed-in phone verification remains blocked on access to the existing account in a controllable browser; no new mobile pass is claimed. This continuation changes documentation only and does not repeat prior build/test claims as fresh checks.
