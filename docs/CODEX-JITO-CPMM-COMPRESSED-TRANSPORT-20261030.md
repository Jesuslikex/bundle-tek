# CPMM bounded compressed-code checkpoint

Draft branch: `codex/jito-v2-reservations-20261028`. No merge, deployment, provider setting, hosted SQL, wallet signature or funded action. Signing remains off. This continues the measured timing work in `abeb176`, serial-only research packing in `71c2e67` and production-runtime guard in `aec12aa`.

## Actual transport and admission

`createJitoQualificationTransport` now accepts an optional `runtimeAccountEncoding: 'base64+zstd'`, only for its runtime stage. Default transports keep base64. Only the explicit sequence CLI `--with-code-bracket --with-market-comparison --with-code-compression` opts in. Bundle/asset stages and malformed compression scopes refuse before I/O; no fallback or retry is added. The mode is captured once at construction.

The transport first snapshots the actual parameters, rewrites the requested encoding in that owned snapshot, and serializes the real wire request. Existing request and response hashes/captures therefore refer to what was actually sent and received, including compressed bytes. Account metadata and contexts are preserved. The reply's context floor is checked against the serialized request snapshot, closing a caller-mutation gap for both default and compressed modes. Tests demonstrate that lowering the original caller's floor after dispatch cannot admit a stale response.

`decodeJitoCpmmCompressedAccounts` requires the exact account count, canonical encoded bytes, Zstd frame magic, declared account space, exact requested slice length (including short/empty slices), fully consumed compressed input and the original aggregate decoded bound. Its output uses the same base64 representation consumed by the unchanged account/header/identity verifiers. Missing accounts remain null. It never supplies a missing account or readonly post-image. Wire observations are not modified.

Every code slice remains at most 720 KiB and every request at most 1 MiB of requested/decoded bytes. The new decoder caps its internal Zstd window at 2 MiB and output to the exact declared/requested slice. The initial one-MiB-window probe correctly refused Alchemy's frame; offline diagnosis showed that it needs a two-MiB codec window while yielding exactly 524,288 requested bytes. This new bounded codec allocation does not increase existing slice/read/slot limits. Oversized output, truncated/extra input, bad encoding/space and aggregate overflow refuse. [Node 24 Zstd API](https://nodejs.org/download/release/latest-v24.x/docs/api/zlib.html) documents the codec parameters. A four-call live prefix probe independently matched the prefix derived after reconstructing and matching the full controlled-build artifact, without claiming a full-artifact scan from that prefix alone.

## Fixed read-only sample

All three planned unsigned samples were retained. Node 24.22.1, existing Alchemy holder endpoint, unchanged pacing, same fixed pool/reference, no provider rotation, no state override, no blockhash replacement and no broadcast. Stop-on-429 remained in place; none occurred.

| Sample | Original floor | Simulation | Final slot | Span | Outcome |
| --- | --- | --- | --- | --- | --- |
| 1 | 463409321 | 463409332 | 463409352 | 31 | Partial financial/runtime diagnostic passed |
| 2 | 463409489 | 463409501 | 463409521 | 32 | Partial financial/runtime diagnostic passed |
| 3 | 463409559 | 463409571 | 463409587 | 28 | Partial financial/runtime diagnostic passed |

Each checked actual writable pool/oracle/token transitions, current-source exact-output minimum, mint/vault/pool/oracle/setup/tip/native Rent coverage, two complete four-program artifact scans, post-code live custody/mint policy and final captured lifetime with the unchanged ten-block margin. The last slot read stayed after lifetime and custody completion. Code slices remain serial. The exact Clock rule, original floor, 32-slot bound, fees, source checks and signing gates were not loosened.

All 54 code request/body hash pairs recompute exactly. Independently reconstructing both CPMM scans in every sample reproduced six full code hashes `b6dbea8cefc2e7d490775ce6115e34a2ba480c0853c359e0bb4043b9381ef09a`. No code byte, header recheck or final scan was skipped/reused. Capture integrity and source-byte matching are not bank authentication.

`CODEX-JITO-CPMM-COMPRESSED-CAMPAIGN-20261030.json` contains all three summaries, input capture digests, both complete identity vectors, financial/market/lifetime results, stage timings and both standalone compression-probe outcomes. Raw responses remain under ignored `work/`. Code-response JSON bodies totaled 590,568 to 590,569 bytes rather than about 2.7 MB. These are parsed response-body sizes, not measured TLS bytes; HTTP gzip was already active. Samples do not isolate provider jitter or establish performance for every route.

## Verification and remaining blockers

Final verification passes on Node 24.22.1: **749 tests across 26 files**, `tsc --noEmit`, six-file type-aware Oxlint and six-file Oxfmt check. Tests cover exact binary/metadata preservation, default/group schedules, serial packing and floors, unknown-size fallback, invalid profile, corrupted/truncated code, stale contexts, rate-limit stop, malformed/noncanonical compressed input, trailing bytes, decompression/output bounds, empty/null accounts, exact request binding and financial/source/JSON regression paths. No full repository suite, browser, production build or funded proof is claimed.

Full qualification remains false. The archive method returns only touched/writable post-images, as its [current documentation](https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/simulate-transactions-at-slot) states. Complete readonly post-state, trusted same-bank identity, independently bound fee-bank evidence, the contextless block-height upper bound and reference ownership/quietness remain unresolved. No inferred or overridden images may fill these gaps. The shared signing allowlist and generic tip funding path are unchanged; app signing remains disconnected from this research profile. Next investigate those evidence contracts rather than interpreting three timing passes as permission to sign or submit.
