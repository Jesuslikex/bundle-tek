# Funding-check sign-in recovery

24 October 2026, source base `32e0293`. The prior shared wallet panel turned some 401 responses into generic retry errors and exposed no sign-in link. This checkpoint fixes that dead end in the existing hook/panel without introducing another history reader.

## Behavior

Small saved reads now check abort/deadline before HTTP 401, cancel the rejected body without awaiting it, and preserve a local typed sign-in requirement. Existing small provider and500-capacity saved/provider readers retain their own typed 401 status and completed counts. Only those specific error types can set current-context sign-in state; malformed data,403, unavailable providers or generic exceptions are not relabeled as authentication failures.

The panel offers a native same-origin /sign-in link opening a separate tab with noopener/noreferrer. No prefetch or navigation callback. The existing selected wallets stay in the current tab; signing in does not restart a check. Every fresh read, context/source change or cancellation clears prior result/auth state through the existing lifecycle. Old-controller results cannot restore a sign-in marker. Existing provider spacing/cooldown remains enforced after 401 and source changes.

The existing /sign-in page was independently confirmed in app/sign-in/page.tsx. This is a route/source check, not proof of an actual completed login in a deployed release.

## Verification

Pinned Node 24.19.0:168 tests in 9 funding files pass, including 37 dedicated rendered authentication cases through real read libraries with mocked HTTP. Tests cover all four branches, hanging HTML/JSON 401 bodies, cancellation rejection, explicit retry, stale selection/source/unmount/cancel, successful evidence clearing, partial 100-of-101 discard and retained provider cooldown. Controlled composite-signal expiry proves abort wins over late 401 without real waits or wider time bounds.

An initial 31-case run against the previous component, injected by an ignored Vite loader without changing checkout source, reproduced 14 failures and 17 passes. The initial failures were sign-in availability/body handling and associated current-state tests; no import/startup failure. Six additional deadline/cancel/partial-batch cases were then added and passed against the fix. Plain TypeScript, two-file typed lint and scoped formatting pass. This is a focused suite, not a full application/build qualification.

Actual Chrome synthetic component check: no mount read; explicit saved success then hanging 401 clears evidence and cancels the body; sign-in link visible; changing the fixture does not retry; manual check succeeds and clears auth state.375 px link/error wrap.500-capacity provider 401 retains disabled start/cooldown and no partial result. Native sign-in/explorer links were not followed; no actual account, provider call, authentication session or wallet was used.

Actual claude-opus-5-5 source-only Read/Glob/Grep review: nine unchanged isolated copies, zero permission denials, no concrete blocker. Reviewer ran no tests/browser. Helper audited library status/abort handling and wrote only the new test file; Codex implemented and independently ran regression/integration/browser checks.

## Boundaries and remaining work

Only the shared funding component and its new test change. No financial writer, server route, provider endpoint/credential, read budgets,500/100/10caps,17-second spacing, red 30-minute comparison, parent layout or PR57 source change. No schema, hosted SQL, wallet unlock/sign/send, strategy/funded run or deployment. Original four AGENTS additions and seven frozen warmup drafts excluded.

Full Proxima parity remains open. Direct recovery-to-project navigation still needs the protected ownership process and reuse of guardDraft/openProject; exact saved GET readers already exist. Jito live qualification remains refused under the unchanged policy/window.
