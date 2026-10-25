# Wallet funding shortfall guidance

24 October 2026. Extends the already-mounted WarmupReadiness panel, without adding another funding system or activity generator.

Each admitted wallet row now reveals its full public address, actual chain and native currency, and offers a copy action with visible success/failure. Failure leaves the complete selectable address available for manual copying. Funding guidance is conditional on a known shortfall; unknown balances explicitly recommend no funding amount. The estimate is labelled as fees/rent only, excluding token purchases and complete trade/launch budgets. Existing operator-linkage and history disclosures remain.

Selection, chain or wallet-revision changes remount the keyed readiness context; an unmounted address panel discards late clipboard success or failure. Existing manual balance reads, response admission, budget arithmetic, cancellation, revisions, signing and provider selection are unchanged. Revealing/copying never adds a provider request or transfers funds. No parent layout or wallet-vault changes.

## Verification

Node24.19.0:27 tests across the readiness component and library pass, including9 new cases for exact public-address copying, unavailable/failing clipboard, unknown balances, pending selection/chain/revision changes, late failure into a new revision and Base/nativeETH labels. Final combined913tests/45files, plain TypeScript and scoped typed lint pass with the concurrent Jito change. Formatting and diff checks pass.

Codex independently inspected the helper's exact three-file patch. In the existing Chrome profile, a fresh disposable tab rendered the actual component, scoped CSS and bounded compilation of current global/button styles. Isolated synthetic balance responses and a simulated clipboard verified: zero reads on open; one explicit readiness read; full-address disclosure; exact copied value; visible copy failure fallback; unknown-balance guidance. Desktop rendering and a375px iframe viewport were inspected; long addresses wrap and controls remain reachable. The narrow check is a real375px frame viewport, not a mobile device or the signed-in full application. It does not certify the production page or its surrounding layout.

The harness never read credentials, called a provider or used the OS clipboard. Synthetic public test addresses were clearly marked Do not fund. The created tab was closed and both owned loopback-only harness servers stopped after process identity verification. Screenshots and accessibility observations were returned in this chat; ignored harness sources/receipts are in work/release-qa/funding-guidance-browser-20261024 and its-v2 sibling.

No deploy, hosted SQL, provider/credential/cron changes, real wallet creation/unlock/sign/send or funded trades. Claude PR57, OpenCode vault files, original four AGENTS additions and seven frozen drafts are preserved. This is actionable funding guidance, not complete launch readiness, exclusive ownership or wallet-age proof.
