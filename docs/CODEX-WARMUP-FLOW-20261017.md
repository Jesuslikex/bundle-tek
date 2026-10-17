# Warmup flow clarity and recovery

Post-commit UI handoff: 5f8f50e, "Clarify warmup approvals and connect recovery and sell steps". That commit contains only the ten owned warmup component edits, the new step component/CSS, mounted workflow tests, synthetic fixture and this note. Final verification: 13 source-only files / 111 tests, typed lint/format and Node 24 production build pass. No Claude-owned files, remote action, funded trade or deploy.

17 October 2026. Source baseline dc5da24, on codex/warmup-flow-clarity. Scope: Codex-owned warmup components only. Claude's app/page.tsx, wallet workspace/vault presentation, holder/supply/performance panels, global CSS and configuration remain untouched. Existing API, lib, schema and transaction-validation files are unchanged.

Initial source inspection found recovery guidance without a recovery action in cycle progress, a finalized-buy message referring to a nonexistent lot selector below the Buy form, disabled approval actions without explanations, and direct JSON parsing in several warmup panels. An isolated browser harness uses production components with synthetic HTTP responses and stubbed vault/sign functions. It cannot produce a valid signature or reach a provider.

## Changes

- Five explicit stages: prepare/simulate, eligibility review, approve/sign, submit once, verify receipt. Progress follows the actual component state. Failed simulations do not expose signing eligibility. Signed expired or uncertain packets keep receipt recovery available.
- A cycle blocked by an approval now opens its saved approval recovery directly and moves focus there. Successful recovery/cancellation refreshes the open cycle table. Cross-plan blocking approvals are explicitly explained; the API still scopes recovery to the selected owned plan.
- A finalized warmup buy now offers an actual action into the same cycle/wallet's sell view. Matching buy selection, remaining units, historical opt-in, fresh inventory and receipt rules are unchanged. The existing unlinked inventory/sell path remains available, with an explanation that it does not complete the linked cycle lot.
- Signing and submission remain separate. Warmup adds an initially unchecked send acknowledgement, enforced both on the submit control and its handler, cleared after use and on page/signer invalidation. Registration failures and unknown outcomes do not cause another signature or automatic submission. The shared imported-swap path receives no new warmup-only indicator or send requirement.
- Friendly approval states, missing approval/passphrase/wallet explanations, explicit expiry/archived/revision recovery guidance, and a reason beside the disabled plan Save control. Reopening/editing still requires a new plan review; saving schedules nothing.
- HTML and null response handling no longer exposes parser text in the wallet-history check, cycle progress, preparation, sell, matching buy receipts, signing, and approval recovery panels. Existing context/identity checks remain.

## Verification

- Node 24.19.0, source-only regression selection: 13 files / 111 tests passed together, with work/** excluded. Includes 11 new mounted workflow tests, saved-plan/summary UI, actual signing/external-signer/approval-history/receipt/settlement/inventory libraries and signing/cycle-progress API regressions.
- TypeScript in the final build, scoped typed oxlint/format/diff checks and the Node 24 production build pass. This is not a full-suite run.
- Browser in the existing Chrome profile, isolated Vite harness on 127.0.0.1:4186. Before changes, reproduced missing recovery action and raw HTML parser text. After changes, clicked recovery, auto-loaded the approval, cancelled the fixture's unsigned approval and observed active approvals drop from one to zero.
- Browser plan entry: checked synthetic bounded wallet history, configured a cycle, reviewed the plan, verified Save changed from disabled to enabled, and saved. The screen explicitly reported that no swaps were scheduled.
- Browser transaction path: prepared Buy, requested eligibility, explicitly approved, invoked a stub signer returning an invalid marker, verified Submit stayed disabled until its separate checkbox, submitted only to the fixture handler, verified the synthetic buy receipt, followed the new sell action, selected the matched buy, prepared Sell and repeated the separate approvals/receipt path. The table reached 1/1 recorded cycles sold, with zero active approvals. No real key, valid packet or cryptographic signature was produced.
- Checked normal desktop and 375 x 812 layout. Phone page scroll width was 360 with a 375 viewport; the stage list stacks and no page-wide horizontal overflow was observed. Temporary viewport override restored. Screenshots: work/warmup-flow-qa/desktop.png and mobile.png, ignored local artifacts. The fixture carries an explicit synthetic/no-provider/no-signing/broadcast banner.
- Mounted tests additionally cover signed-packet expiry, consent clearing on page invalidation, uncertain send without retry/re-sign, exact-packet mismatch refusal, failed simulation, archived/mismatched selections, HTML errors and unchanged imported-swap presentation.

Browser harness files are ignored under work/warmup-flow-qa and load the tracked test/warmup-ui-fixture.ts plus production components. The harness has a separate env directory, stubs all fetches and both vault/sign modules, disables external-wallet connection/signing, and cannot reach a provider or real vault. Its signatures and packets are invalid fixture markers. No actual wallet generation, unlock, funding, signature or broadcast occurred.

## Limits and handoff

This verifies the UI with declared fixtures and existing offline/API tests. It does not qualify authenticated production, real provider routing/simulation, funded execution, full historical coverage, scheduling or unattended warmup. Claude's shell and wallet selection page were not edited or browser-qualified. Source begins at dc5da24; integrating the newer upstream Claude releases remains separate. No migration, remote SQL, provider/credential change, cron, push or deploy occurred.
