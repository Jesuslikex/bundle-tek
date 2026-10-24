# Jito timing and program-provenance checkpoint

24 October 2026. Source and offline evidence only. Full live qualification remains refused/unproven; no signing gate, provider setting or deployment changed.

## New diagnostic measurements

The qualification transport records process-monotonic request queue, completion of ordinary per-method pacing, send invocation, observed response availability, completed raw capture and request-finally timestamps. Each record is relative to its transport origin; origins share the current process monotonic clock, not a trusted wall clock or another machine/process. The response timestamp is when the fetch promise is observed, not a packet-level network measurement. Captured timings are detached on read; late cancelled responses cannot populate successful response/capture timestamps. Parsed refusals and HTTP/RPC429 retain terminal timing without retry.

The collector records manifest validation, baseline replay, network checks, original lookup resolution, packet-scope construction, both parallel pre/postflight branches, coherent simulation, final genesis and asset/runtime/economic replay. Events remain ordered by observed monotonic time, not by assumed stage order; overlapping durations must not be summed. Terminal timing is detached and closed. The summary's maximum captured context is explicitly unadmitted diagnostic evidence. Early manifest/baseline failures retain the previous throw behavior rather than inventing a successful receipt.

All original admission predicates remain present unchanged: 26 transport and 23 collector conditions under the scoped AST comparison. Existing call order, original F..F+32, fee/frame equality, network, account/Rent/ALT, custody, minimum-output, runtime policy and every false authority flag remain. Both complete program scans stay serial1/default100. The existing bundle 12 HTTP/18 method cap is unchanged. No added RPC, fallback, simulation, policy pin or request retry. This instrumentation does not establish a faster path or a fresh live latency result.

## Why program policy still refuses

Offline extraction from the retained historical public responses reconstructed complete code-only artifacts, excluding 45-byte ProgramData headers. Request/reply identities, account positions, base64, declared sizes, contiguous slice coverage, original contexts and matching before/after links/headers were checked. Full hashes match the prior refused scan:

- Jupiter: 2,892,224 bytes, SHA256 0394bfa4311fac40dd3d32e431ab2f541227e6c32923715455cfac58e4004d30. Existing policy still expects 099da3a26d336aa7174960f057546f192fc1ccda8e3e9d1b4aa5c69fa8a79a5f.
- Tess: 576,932 bytes, SHA256 82fd37995fcece47a253b1a00c1dd7e4c3fff706b2e42384110e2cbabf4201b3. No existing policy entry.

The ELF files remain in ignored local work/release-qa/jito-program-artifacts-20261024/. Portable public metadata and original chunk hashes are in CODEX-JITO-PROGRAM-ARTIFACTS-20261024.json. These are historical provider observations assembled over multiple contexts, not an atomic snapshot, fresh deployment attestation, reproduced build or semantic audit. Matching headers cannot exclude same-slot rewriting between chunks.

REA open_binary with Ghidra refused both retained ELFs as unsupported ELF architecture. Neither target was opened or executed; no provider repair, engine installation, fallback or policy update followed. The numeric ELF machine fields are 263 for Jupiter and 247 for Tess. They are header facts only; no instruction/control-flow/security claim is inferred. Current pins originate in an earlier owner-reviewed observed scan, not an independently reproduced source build.

The official [Jupiter order contract](https://developers.jup.ag/docs/api-reference/swap/order) supports excludeDexes; positive dexes restriction belongs to build. No route request changed. Excluding Tess alone would still leave the changed mandatory Jupiter router under this path. The official [Jupiter CPI repository](https://github.com/jup-ag/jupiter-cpi) describes IDL-generated clients, which do not prove deployed-router implementation equivalence. The bounded research established no matching reproduced source/build proof for either artifact; this is an unresolved provenance question, not proof that no such evidence exists.

## Verification and remaining gates

Final combined 955 tests/43 files plus 19 offline native harness tests pass on Node 24.19.0. Plain TypeScript and scoped typed lint/format pass. The companion JSON records exact scope/source hashes and actual Opus5.5 source-only review status. The combined cohort also includes the disjoint marketplace capacity-diagnosis slice. Composition tests explicitly double fake runtime program code; separate runtime tests cover real scanned identity behavior. No full-repository suite, production build, new provider sample or funded proof is implied.

The historical attempt reached F+32 during the first scan, before exact simulation and final scan. Its HTTP log has no per-request wall timing; an overall 8.770-second duration cannot attribute the ten-slot baseline-to-qualification lookup gap. Later overlap changes have no fresh live qualification sample. New instrumentation prepares that measurement without reinterpreting the old capture or loosening any condition.

Next: establish acceptable current program provenance/security review, then use one newly authorized bounded read-only campaign with every refusal retained. Only measured evidence can justify a performance change. Original four AGENTS additions, seven frozen warmup drafts, Claude PR57 and the pending protected navigation patch remain untouched. No deploy, hosted SQL, provider/credential/cron change, real wallet unlock/sign/send or funded action.

Actual source-only Opus5.5 review completed with unchanged copied files and zero permission denials. It found no blocker. Codex checked the missing fractional-number serializer context and added fractional-clock/delayed-body tests, exact capacity-body assertions and precise refusal-phase timing. Those final follow-ups were independently tested on unchanged source, not attributed to another Opus review. SQL, program pins, serial scanner and protected parent are unchanged; five existing financial/cancel handlers are printer-identical.

Instrumentation does not yet cover original baseline acquisition or outer campaign work before collector entry. It records baseline replay and qualification transport timing. A future campaign still needs acquisition/outer-stage marks to attribute that part of the historical gap; no missing timing is invented.
