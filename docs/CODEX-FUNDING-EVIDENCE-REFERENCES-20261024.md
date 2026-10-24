# Inspectable funding evidence

24 October 2026. Source base6aceb96. Read-only audit confirmed that current saved-receipt and provider-history DTOs already retain signatures, but the warning badges and launch observations did not expose them. This checkpoint reuses those loaded records; it does not recreate funding/history APIs.

## Change

New collapsed FundingObservationReference shows full recipient/revision, original signature, source, slot and original block timestamp/UTC time. Existing provider funders are included, otherwise explicitly unavailable. Canonical32-byte addresses and64-byte signatures, safe slot/time/revision and supported source are required before any external link. It includes a selectable plain reference, explicit write-only clipboard action with fallback, and a guarded Solscan mainnet link with no referrer. No automatic navigation, HTTP, clipboard read, storage or wallet action.

Each full evidence identity keys its own copy feedback; out-of-order completion, replaced evidence, invalid props or unmount cannot publish a stale success/refusal. The platform clipboard write itself cannot be cancelled: old copied text remains a self-identifying historical reference, not refreshed evidence. Capture time, provider transaction index and amount are not added to the copied projection; parent provenance remains the source for capture timing.

Mounts are limited to known funding observations in shared wallet badges and launch-wallet observations. Unknown data creates no reference or explorer link. The original red30-minute comparisons, provider/saved source selection, strict DTO admission, paced batches, context invalidation, cancellation and all financial/consent paths remain unchanged. A TypeScript printer comparison confirms both parent files match HEAD after removing only the new import/mount and whitespace-only JSX trivia.

## Evidence

Pinned Node24.19.0:131tests across8actual matched files pass, covering new display/copy/identity cases plus shared wallet,500-wallet batches, launch observations, warmup integration and existing funding comparison/admission clients. Plain TypeScript, six-file typed lint and scoped formatting checked. The launch integration test asserts original signature/link/source data, unknown rows without links, no extra fetch on disclosure and unchanged launch terms.

Actual Chrome synthetic harness: original24m34s warning remains; full saved/provider references and source funders visible; clipboard refusal leaves a selectable reference; source replacement clears old feedback; unknown has no invented reference/link;375px expanded reference wraps. The counter stays zero network requests during disclosure/copy. Clipboard is mocked and explorer was not followed. This is rendered fixture evidence, not a signed-in application/provider or funded qualification. The local harness initially had a string-escaping syntax error, corrected only in ignored QA tooling.

Actual claude-opus-5-5 Read/Glob/Grep review completed against nine unchanged isolated copies, zero permission denials, no blocker. Reviewer ran no tests/browser. Parent CSS and launch network provenance were independently inspected: both source decoders require mainnet. Final dark-theme/wrapping/focus styling and two real-unmount promise tests were independently verified after that review. The review overlooked the already-added launch mount test; the actual test is authoritative.

## Remaining work and boundaries

Funding times and similar timestamps do not prove wallet age, independent ownership, complete history or current balances. No fabricated activity/history or concealment. Full Proxima parity and live Jito qualification remain open. Separate audits identified shared funding401sign-in UX and recovery-to-project navigation as future work, not completed here. Existing owned GET?id readers already exist; do not add duplicate wrappers. Direct navigation must reuse guardDraft/openProject under the protected parent ownership rules. Archived/missing/older-than100 projects need deliberate historical handling.

No schema/migration, hosted SQL, credential/provider/cron, protected parent, Claude PR57 source file, real wallet unlock/sign/send, strategy/funded run or deployment. Original four AGENTS additions and seven frozen warmup drafts excluded.
