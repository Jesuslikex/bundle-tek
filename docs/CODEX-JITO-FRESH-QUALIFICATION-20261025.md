# Fresh post-fix Jito qualification measurement

25 October 2026. One fixed unsigned public-reference SOL-to-USDC sample on committed `f92675c`. No application, route, pin, pacing setting or signing change. Full qualification remains refused.

## What changed in the evidence

The live local baseline replay took **23.272 ms**, confirming that the previous pacing fix works outside the historical fixture. The complete first full serial code scan finished at maximum captured context **461300507**, original floor **461300479**, a **28-slot** span. The controller then correctly refused program policy. It did not perform exact bundle simulation, the postflight bracket or the second full code scan.

There were **32 read-only HTTP requests**, no 429, no retry, no route/provider replacement, no signature and no broadcast. The unsigned request was 1,000,000 lamports SOL-to-USDC with a separate unsigned 1,000-lamport tip packet, using the existing public reference. No owned wallet was generated, unlocked or used. This is a diagnostic, not an approved trade or acquired supply.

This route differs from earlier samples. Consequently F+28 versus an earlier F+33 is not a controlled whole-pipeline performance comparison. Only the local replay delay has direct measured and controlled-clock regression evidence. Four slots of margin at the first scan do not prove sufficient margin for exact-bank simulation and a second complete scan.

## Current exact policy refusals

| Program | Current observation | Existing policy |
| --- | --- | --- |
| Jupiter router | `0394bfa4311fac40dd3d32e431ab2f541227e6c32923715455cfac58e4004d30`, deployment459479624 | Different pinned hash `099da3a2...` |
| Token-2022 | `15a2e615a42e20f31714bbaaee43002ae6f1cda2e8d7118243117ab3c1342e2d`, deployment460497271,1382016codebytes | Different pinned hash `0999dbf7...` |
| AlphaQ | `ALPHAQmeA7bjrVuccPsYPiCvsi428SNwte66Srvs4pHA` | No entry |
| Memo | `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` | No entry |
| RealQ | `REALQqNEomY6cQGZJUGwywTBD2UmDT32rZcNnfxQ5N2` | No entry |

The new Token-2022 difference means a router-only pin review is insufficient for this route. Tess was absent here; this does not qualify Tess or imply it cannot appear later. An unlisted Memo instruction is not allowed simply because its name is familiar. No observed program was added to the allowlist, and no source/build/semantic approval is inferred from code identity.

All nine observed program vectors, five differences and hashes of the exact retained request/response parents are in `CODEX-JITO-FRESH-PROGRAM-POLICY-20261025.json`. A separate offline run consumed all **16 runtime requests** through the original strict JSON reader, verified the raw hashes, reply IDs, exact methods/parameters/order and source-input hashes, reran the full runtime collector and reproduced the identical policy-refusal vector with zero network calls. These are provider-reported bytes captured across multiple contexts, not an atomic snapshot, verified validator binary or reproduced source build. Raw responses and application snapshots remain private in ignored local QA storage.

## Performance and verification limits

The measured first runtime branch took4060.717ms on this larger route. Captured source/input hashes match current committed application sources. A separate historical JSON-reader profile measured roughly7–11ms median per0.95–1.38MiB response, so no speculative parser optimization was made. Timing includes local processing and observed response availability; it is not a packet-level trace or trusted slot-cadence measurement.

The current runtime and capture suites pass: **19 tests across two files**. The application is unchanged from the preceding verified888-test/40-file checkpoint plus19native harness tests; those broader totals were not rerun or represented as new coverage. Both complete serial scan requirements, original32-slot floor/span, default code pins, custody/Clock/Rent/minimum-output checks and all false signing/execution flags remain unchanged. No production build, signed-in browser, final scan, repeatability or funded proof is claimed.

## Coordination and next gate

Claude acknowledged the existing disjoint split and received the fresh Token-2022 finding on PR59. Its route filtering, scan and proposed pin-review work remain its own; PR57/59/60 and0147 are untouched. The report is not authorization to bypass its permission blocker or adopt an observed hash automatically. OpenCode's existing usage-limited session has no accepted new claim; the shared handoff is updated without restarting it. Preserve the original four AGENTS additions, seven frozen drafts and protected navigation patch.

Next requires reviewed program policy/provenance and a supported route, followed by a new bounded measurement of the entire path. The remaining first-scan margin is small, so the complete path may still require measured latency work after policy review. No deployment, hosted SQL, provider/credential/cron change, real wallet signing/send, strategy run or funded trade occurred.
