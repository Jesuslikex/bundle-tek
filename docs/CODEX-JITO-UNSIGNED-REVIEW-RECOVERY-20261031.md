# Unsigned Raydium review and recovery, 31 October 2026

This checkpoint completes a bounded, file-based **unsigned research inspection**
flow around the qualified Raydium collector. It does not qualify a user's owned
wallet or saved Jupiter bundle, authenticate an imported report, or enable
signing or execution. It remains on the existing Jito draft branch.

## Coordination

Remote `main` was checked at `61209c27a1b5f02b48039b8808eef9ee9d6dc50c`.
Claude's merged PR61 changes only warmup routing UI/CSS/tests. There is no Jito
overlap. Those files were not edited or merged into this draft. The canonical
Desktop checkout's older warmup drafts/AGENTS dirt and this worktree's three
untracked recovery-password drafts remain untouched. No new agent was started.

## Completed flow

1. The existing CPMM collector runs its unchanged financial, source, Clock,
   lifetime, custody and 32-slot checks and both full code scans. Only its
   successful final branch creates a compact unsigned review projection.
2. The local qualifier writes `work/jito-cpmm-unsigned-review-<stamp>.json`
   separately from its private raw receipt. Refused collection emits no review.
   The campaign fingerprints include the new review module.
3. In the Codex-owned Jito panel, the signed-in user first loads owned session
   history, then explicitly opens the compact review file. No provider, wallet
   or mutation request occurs on mount, file open, approval or download.
4. The panel displays the public reference payer, pool/mints, raw input,
   expected/encoded minimum output, fees/cap/tip, created/retained rent,
   recorded price difference, slot span, original blockhash/height and four
   ordered packet fingerprints. The anchor is explicitly simulation-only.
5. A separate, initially unchecked approval permits saving this inspection
   only. Approval is consumed before asynchronous export. The saved file binds
   the complete review checksum to account scope, project and session.
6. Reopening verifies exact shapes, bounded UTF-8/JSON, duplicate-key refusal,
   checksums and matching context. It restores historical display data only,
   with a fresh unchecked approval. Changed account/context, failed import,
   timeout, unmount and a newly selected file cannot carry consent forward.

The file contains **no packets, signatures, private keys, provider endpoints or
server authorization**. A canonical checksum detects changes; anyone can
recompute one. It is not authentication, confidentiality, proof of an actual
human approval, or proof that the provider ran the reported checks. All source,
bank, provider, wallet-ownership, signing and execution authority flags remain
false. Expired historical inspections stay readable and never become current
trade authorizations.

## Signing and existing recovery

`JITO_RUNTIME_SIGNING_ENABLED` is an immutable source constant `false`, with no
environment toggle. A valid, authenticated v2 `begin-signing` request receives
409 before database reservation/provider work. The parent disables new signer
controls. The existing unconditional submission block stays intact.

Read-only sequential checks remain usable independently of that gate. Existing
unknown-attempt inspection, evidence retention/registration, encrypted journal,
terminal/file recovery and chain receipt recovery retain their original
safeguards. No uncertainty is converted into permission to retry or cancel.

Five historical synthetic test harnesses explicitly override the new-signing
constant so their prompt/race/recovery assertions remain reachable. The real
default is separately tested through the actual parent and HTTP boundary.
The route-flow fixture asserts HTTP submit409, then uses only its existing
intercepted internal legacy service to exercise historical in-flight recovery.
It does not enable the application sender. No test was dropped to pass the gate.

## Historical sample, not a fresh live qualification

`test/fixtures/jito-cpmm-unsigned-review-20261031.json` is a compact, sanitized
projection of the first retained 27-slot result from the earlier fixed3/3 sample.
It is available to Claude without local credentials. Its exact checksum is
`0b9105d23bde520fe3d5a04394b67b14e0a1044b8767b1410b8c5ac4cb0d68ab`.

The ignored original receipt hash is
`8355b251a66ad22d70dac72dcbef67770ba803165cdb64f6df27ffbb6b22861b`.
Offline projection independently checked all four actual packet hashes,
ordered frame/candidate byte equality and zero signatures, then completed a
save/reopen round trip with consent absent from the recovered return value.
This did not contact a provider or repeat the live campaign. It does not
establish current balances, prices, blockhash validity or ownership.

## Verification

- Node24: final Jito regression run,100 files,1878 passed,1 existing skip.
- Whole-project TypeScript passes.20 changed code/test files pass typed lint
  and formatting. Final retained-fixture and stricter test-body guard follow-up
  is separately rerun after the broad run; application source is unchanged.
- The new panel bundles successfully for browsers (65,268 minified bytes in
  the standalone check). This is compilation, not a rendered layout test.
- Offline historical replay now matches complete unused request contents,
  allowing concurrent height/fee arrivals. It preserves raw request/response
  hashes and allows only the already-known finalized-height option and explicit
  log request where the original response actually contains logs. All production
  replay/capture/financial predicates are unchanged.
- The additional local Turso reservation-engine case passes. Its local D1
  counterpart cannot start workerd: `CreateDirectory: #5 Zugriff verweigert;
  path = miniflare-CacheObject`. The error repeated with an isolated temporary
  directory. No guard, assertion, engine or permission was changed to hide it.
- Connected browser inventory had Edge and no Chrome. No alternate browser
  session was substituted. Real signed-in browser, IndexedDB/Web Locks, download
  persistence and production QA remain unverified in this checkpoint.

## Still held

Before a real user can sign, the research runtime must be integrated with the
user's exact owned preparation and current account/wallet/session state.
An imported historical projection can never supply that proof. Fresh exact
signed-vector qualification, trusted provider/bank boundaries and the existing
legacy migration/rollout holds remain separate blockers. No migration was
changed or applied, and no release readiness is claimed.

No deployment, hosted SQL, provider/credential/cron change, real-wallet unlock,
signing, submission, strategy execution or funded trade occurred. Pushing this
draft is source sharing, not a merge or release.
