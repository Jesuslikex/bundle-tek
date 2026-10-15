# Complete launch group UI work, 15 October 2026

Codex is connecting the existing complete-group API to owned launch screens. Planned files: a browser group-response reader and tests; pump-launch-group-review.tsx and tests; a dedicated group CSS module; the holder screen and its test for the preparation seam. No Claude-owned file changes. The full packet vector and saved per-wallet limits remain authoritative. This step exposes preparation, complete saved review, revalidation, unsigned discard and read-only recovery/history. It does not expose approval, unlocking, signing, registration or submission while the runtime policy still disables them. Saved review loading and cancellation remain available independently of the current draft. Local tests/build/commit only; no deployment, remote migration or transaction.

## Implementation

The holder launch screen now lazy-loads Complete launch groups. Its preparation seam reuses the current project/deployer/mint/release, developer quote cap and every holder slot's raw limits, including zero allocations. Competing holder preparation/signing controls stay disabled while a group request runs. The existing one-packet path and its consent checks remain intact.

The panel prepares a whole saved group, lists paged saved groups, opens exact immutable reviews, shows all packets and signer/holder coverage, exact mint/quote identities, human-readable wallet targets and caps, original expiry and simulation identity. It can revalidate sources without extending expiry, discard only never-approved unsigned groups, collect read-only packet observations and page their saved history. Saved reviews remain accessible when the current draft is unavailable. Draft/limit changes are disclosed against the saved review. Partial request failures preserve existing evidence; owner/project changes abort pending reads. No automatic retry is performed.

The browser reader reconstructs the complete immutable manifest using the production review validator and independently verifies retained full-group signatures for signed histories. Subsets, reordered bytes, changed signers, foreign projects, unexpected execution permissions and incompatible states reject. Observation reading verifies context, manifest, signature-set identity, digest, packet identities, counts, known fees and classification; it retains unresolved fee and reservation warnings. Pending/partial/unknown observations never imply atomicity, settlement or reservation release. Old approved observations can still be read after the exact group becomes signed.

No approval/sign/unlock/register/submit control or private-key/vault dependency was added. Groups above five packets remain unsupported; there is no subset fallback. No backend policy, migration or Claude-owned UI file changed. The scoped CSS module avoids shared stylesheet edits.

## Verification

- Final seven-file regression run passed 68 tests. Covers the new browser reader/panel, holder preparation seam, previous launch/history consent regressions and group API tests. The actual Request/Response to owned local SQL integration now passes real prepare/signed/observation/page responses through the browser reader. Controlled fixtures provide authentication, preflight, RPC and ephemeral synthetic signatures. No actual user, provider or wallet was exercised.
- TypeScript and seven-file typed lint passed. React review: lazy-loading for group codecs, bounded/cancellable requests, stable effect events and row keys, accessible button labels/status feedback, scoped wrapping layouts, no new consent defaults.
- Production Next.js webpack build passed through final generation and build tracing (exit 0).
- Rendered desktop/mobile and signed-in deployment checks remain unverified. The earlier automatic approval rejection of a temporary local production-server launch remains respected; this task did not retry or bypass it.

No push/deployment, hosted SQL/migration, cron, credentials/provider settings, actual signing or transaction submission. Migration 0085 is still only local from the previous observation-storage work. Main's unrelated dirty Jito note and migration 0068 remain excluded.

Next: complete guarded terminal recovery/release and economic settlement, and qualify runtime/code/authority and a one-attempt transport/tip policy before enabling user-approved group signing and execution. This checkpoint establishes the group review interface, not full Proxima parity or funded execution proof.
