# Volume Bot USD targets: local implementation and evidence

18 October 2026. Isolated branch `codex/volume-usd-targets` starts at 88fdc2b. The other Bundle chat owns the wallet/warmup flow and Chrome recovery. No wallet/warmup files, secrets, provider settings, cron or remote databases changed.

## Result

SOL remains the default. The optional USD target requires an explicit server capture from Bundle's existing Dexscreener market adapter for the native Solana mint. The highest reported positive-liquidity base pool supplies the captured SOL/USD price. BigInt decimal arithmetic rounds the converted SOL target upward by at most one lamport, within the existing Volume Bot limits. This is a fixed SOL turnover target at one observed price, not guaranteed USD turnover or profit and not an independent or manipulation-proof oracle.

The UI shows the requested USD amount, fixed SOL target, price, source, observation time and expiry. Saving requires a separate initially unchecked acknowledgement. Target/currency changes clear the quote and estimate; pending capture/estimate responses cannot reinstate a changed draft. Expiry disables saving and server checks refuse it. Existing per-batch transaction reviews, initially unchecked approvals, wallet custody, minimum output, browser signing and one-attempt submission/recovery code are unchanged.

New append-only 0102 retains owner/project/revision-bound conversion evidence. Application and database clocks require freshness at session creation. The service rechecks after wallet reads, including current project ownership/revision/archive state; the insert trigger repeats it atomically. The exact converted target and quote JSON must match the immutable hashed plan, and a quote can create at most one session. Saved sessions retain their captured conversion; expiry is a creation deadline, not a requirement to reprice an already-fixed session. Realized turnover stays in SOL.

REA source: retained Volume Bot form ev_3d997a0321ca79e69eee8a07456821874712f44273610b8e9e1de21e806e2e26 in Desktop/REA/results/proxima-strategies-20261018-final-evidence.json. It showed a USD target. Vendor conversion/backend/settlement semantics remain unknown; no vendor Estimate/Run was invoked. This implementation does not claim identical backend behavior.

## Verification

- Node 24.19.0: 57 tests across six Volume model, batch, service, actual-route and React panel files pass together. Covers exact rounding and limits; malformed/stale/future/altered evidence; ownership and changed project during wallet reads; SQL missing/null/foreign/changed/expired evidence; immutable records/plan and one-use quote; strict authenticated same-origin/rate-gated API; explicit capture, unchecked consent, edit/expiry and pending-result invalidation; original SOL and synthetic batch signing/submission regressions.
- Actual-source TypeScript and ten-file type-aware lint pass. Git diff whitespace check passes.
- Checksum runner applies all 103 migrations to a new disposable local libSQL/Turso file. The real whole-file Wrangler migration/ledger check is recorded below after completion. No existing migration SQL was rewritten and no remote SQL ran.
- One real read-only call through the existing market adapter returned 20 SOL-base pools at 2026-10-18T01:19:35.573Z. The selected $103.71/SOL price converts $100 to 964227172lamports; executionAllowed and signingAllowed both false. No credentials, wallet RPC or financial action were involved. Private-free result: ignored work/volume-usd-qa/live-price.json. One observation proves adapter/conversion compatibility, not price accuracy or availability guarantees.
- Existing Chrome desktop rendered the synthetic form, capture, estimate and unchecked acknowledgement with Save disabled. Screenshot: ignored work/volume-usd-qa/desktop.png. No live authenticated Volume Bot request was made. Phone viewport command succeeded but subsequent CDP DOM evaluation timed out; viewport reset returned success. No mobile rendered pass is claimed. The other chat owns browser recovery.

Build and final Wrangler outcomes are appended when terminal. This is local implementation, not a full-suite, funded, deployed or production-provider qualification.

Final terminal results: isolated production build exit 0, 26.0s compile and 10.8s TypeScript, with application source unchanged during that final run. Log: ignored work/volume-usd-qa/final-build.log. Final real Wrangler 4.127.1 whole-file migration apply and ledger verification exit 0: 103 expected, 103 applied. Disposable report: C:/Users/Julian/AppData/Local/Temp/bundle-wrangler-migrations-VfsccH/report.json. This final run includes the project-state guard in 0102; the earlier lKWSc9 run predates that final guard and is not the final-source result.

## Local integration

Feature commit87f3a08 was merged with the other chat's warmup commitb048be0 into main2ce5795. The same57 tests and plain TypeScript pass on merged main. The isolated checkout was then fast-forwarded to exactly2ce5795 and built again without copied environment files: terminal exit0,27.1s compile and11.6s TypeScript. This verifies both changes together without rebuilding or restarting the other chat's guarded main HTTPS server. Log: isolated work/volume-usd-qa/merged-main-build.log. Main's wallet/warmup content was preserved; no shared browser recovery was attempted. The feature is committed locally, not live; migration0102 remains unapplied remotely. Existing hosted provider/credential/cron/signing settings were not changed.
