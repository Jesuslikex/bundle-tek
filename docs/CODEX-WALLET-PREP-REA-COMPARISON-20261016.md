# Current wallet-prep comparison and UI repair

16 October 2026. This extends `CODEX-REA-PASSIVE-REFRESH-20261016.md`: wallet configuration is now directly observed through REA, rather than inferred from the launch selector or the older CUA/static record. This does not establish execution, custody, performance accounting or full product parity.

## Live Proxima evidence

The existing approved Chrome target `844417DB26A93ABC5581FC64DFA24D2D` remained reachable through the approved loopback/stdio relay. The configured WSL REA launcher reports **6.4.0**. The separate Windows CLI directory still contains 3.2.1 and was not used to run this capture; its older scenario documentation was not treated as the connected server's schema.

REA connected to the existing target and inspected `/wallets?chain=sol`. Generate Activity was disabled with no wallet selected. Selecting the first visible row's checkbox enabled it; clicking the control opened a settings dialog. The form exposed Fixed/Range amounts, Loop Count, minute/second Delay, Alternative Routing, selected-wallet count, Required and Estimated summaries, Close and a disabled Start. No values were entered and Start was never pressed. The dialog explicitly includes fake-volume/platform-usage wording; that is a reference observation, not an execution feature added to Bundle or a claim of genuine market activity.

The final scenario cleared transient selection through a wallet-page reload, verified Generate Activity disabled again, then restored the original `/launch/create/launchpad` page. No wallet/folder was created, archived or deleted, no keys were revealed/exported/unlocked, and no trade or runner was started. Choosing a checkbox for inspection was not transaction approval. Normal page queries/subscriptions/telemetry may occur; this was controlled UI inspection, not a claim of zero application/network activity.

| Evidence | ID | Scope |
| --- | --- | --- |
| Wallet view and disabled control | `ev_650c7de77e0ca974f51802908c8f913e2676c5641486cd9c9760d5d71777d507` | Settled page accessibility |
| Visible wallet screenshot | `ev_66b9cb25b6526ce64a48ee3b48371c178edd6d303d8161f4066aa3e410492727` | 01:18:17.950 UTC, 1920 x 945 |
| Early DOM sample | `ev_5e501af5c772a84ff0b705cdfd3250b546e25dfe2a2eb25574f1fd860f14a441` | Sampled before SPA data settled; absence of controls is not a feature finding |
| Settled DOM / checkbox identity | `ev_9a89911dbeabdb584203d26a7c2b7929849f7cfc83d4377bb4bffe49f0d7d328` | First visible row's actual checkbox selector |
| Selected wallet / opened activity dialog | `ev_06330ac3e331730fe0a062909bc9e4e393fb754ea454bc43bcbf65406d49cc3c` | Completed selection and dialog actions; Start not clicked |
| Selection cleared / original page restored | `ev_9a91611dbece235c8a02aa97d76cb19ac7c055ba32749fd8944d6a410c040954` | Completed restoration, disabled control verified |

All six complete returned Evidence records are retained privately in `C:\Users\Julian\Desktop\REA\results\proxima-wallet-prep-20261016-current-evidence.json`, SHA256 `f5232d58940d78ee115e7e02959c7c139a418044a819b62d41c6076bcb0d26e6`. Screenshot artifact SHA256: `703987ae0488319cdd6e9ea6928950d6f15a367c5c5e0154159733d1ba748efd`, 165,035 PNG bytes. Raw DOM, images and accessibility contain account-specific information and are not committed.

An early accessibility snapshot caught animated numeric text mid-transition; the later settled snapshot agrees with the screenshot's displayed formatting. This is not evidence of an accounting/units defect. Wallet volume/P&L figures were not reconciled with chain receipts. The activity scenario reports incomplete event coverage; request/response bodies, header values, storage and secrets were not captured. No backend signing, routing, funding or timing semantics were verified.

## Bundle at this checkpoint

Current source was inspected, not assumed from historical reports:

| Workflow area | Bundle source | Remaining comparison gap |
| --- | --- | --- |
| Wallet selection / saved plans | `components/wallet-workspace.tsx`, `components/wallet-warmup.tsx`, `components/wallet-warmup-plans.tsx` mount the warmup planner and saved-plan workflow | Integrated rendered/hosted comparison not run here |
| Amount sizing | `lib/wallet-warmup.ts` v1 input stores one fixed amount; exact integer budgets multiply it by cycles and add an explicit reserve | No per-cycle range sizing; a real implementation would need persisted exact per-action amounts and reviewed budget/approval bindings, not just a toggle |
| Loops | One to twenty cycles per wallet; distinct token addresses rotate by cycle | Proxima's backend loop limits/settlement remain unknown |
| Timing | Integer interval of 15 to 10,080 minutes, disclosed wallet staggering and half-interval sell target | No seconds field; Proxima's displayed delay is not proof of precise execution |
| Funding estimate | Exact planned spend and separately entered reserve; sell proceeds not reused and provider fees not invented | Proxima's Required/Estimated arithmetic, fees and reserve semantics were not exercised |
| Execution and recovery | Saved-plan component mounts separate preflight, quote, cycle workflow, buy/sell receipt and approval-history components | This inspection is not funded/live proof. One Start button is not substituted for transaction-specific approval |

Transparent user-reviewed operations remain Bundle's model. No fake-volume or fabricated history/P&L feature was introduced. Full wallet preparation, audited per-wallet performance, operational/funded parity and the larger Proxima objective remain incomplete or unverified.

## Concrete UI repair: `37407c0`

Source review found saved warmup initial load, reload and mutation handling called response.json before checking non-JSON error pages. Seven mounted React cases on the old source produced **six failures and one pass**, including raw parser text and null-response property errors. The component now uses the existing readPanelJson helper and null/type guards. HTML/malformed/null payloads and empty/non-string error fields produce readable fallback messages; nonempty JSON revision-conflict explanations remain intact.

The new test file has **nine mounted-component cases**. The final four-file selection passes **16 tests** (2.62s): saved-plan UI, warmup summary, warmup performance and planner model. Tests cover initial errors, retained saved-plan count across failed reload, recovery on a successful reload, unchanged exact POST payload and revision, no automatic resend, post-save refresh failure without a false success notice, and preserved JSON conflict explanation. Standalone TypeScript, two-file typed lint and whitespace checks pass.

UI commit `37407c0` changes only `components/wallet-warmup-plans.tsx`, its new test and the pre-edit scope notice `CODEX-WALLET-PREP-UI-NOTE-20261016.md`. No child transaction/consent behavior, mutation body, server/schema, layout, CSS or Claude-owned file changed. No complete repository test run, new production build or live Bundle browser acceptance was claimed for this small transport/error repair. A successful write followed by failed refresh still needs manual saved-plan reconciliation; this change does not add idempotent client retry/recovery semantics.

The stock order-first review proposal is still awaiting the user's decision. No proposal code or duplicate-account-read optimization was implemented. Stock signing remains off. No provider/credential/cron change, remote SQL, push, deployment or actual user transaction occurred. Main's two intentional dirty files remain preserved.
