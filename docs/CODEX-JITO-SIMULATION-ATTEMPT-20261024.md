# Jito bounded read-only collection, 24 October 2026

Base a056939. New internal lib/jito-simulation-attempt.ts composes the existing immutable fee batch and raw response adapter into at most two sequential trusted-transport calls. It remains unmounted; a captured result grants no signing, execution, economic, source, provider, runtime, ALT or signature authority.

## Behavior

Original canonical packet snapshot, fee limits, selected signature mode, explicit bank encoding and original floor remain bound throughout. Simulation only starts after every actual fee agrees on one bank within the unchanged 32-slot span. It uses only the private fee-derived packet vector. Exact response bank, original frame checks and byte-for-byte request consistency remain mandatory. The transport receives frozen request objects; this consistency check does not authenticate an endpoint or prove actual network bytes.

A single 30-second owner deadline spans both stages. There is no retry, fallback, provider selection, renewed floor or later-bank substitution. Rate limits and other HTTP errors stop immediately; safe refusal reasons distinguish bad plans, transport failure, fee refusal, simulation refusal and the exact known bank-unavailable error. Arbitrary provider error messages are not copied into the reason. Attached raw bodies, packet strings and captures remain mutable PRIVATE evidence and must never be returned as a public API DTO.

Returned response ownership is registered inside the pending transport continuation, before abort checking and promise adoption. Terminal cleanup handles pre-reader cancellation, while late responses arriving after terminal cleanup are cancelled directly. Native Response getters reject forged transport results. Invalid outer policy throws before transport; invalid fee plan returns plan-refused without a read.

## Measured bank diagnosis

One fixed paired diagnosis used the unchanged Alchemy holder endpoint, original zero-value unsigned packets and no blockhash replacement. Six HTTP requests/seven RPC methods, zero signatures/broadcasts/429. Both fee replies reported **460684965**, 5000 lamports. Exact-slot simulation refused that bank. Fee completion to simulation start was **4.346 ms**, and simulation headers arrived after **285.356 ms**. A deliberately separate confirmed-bank discovery then returned two successful frames at **460684969**. Discovery is labelled NOT admitted and is never substituted into the review or collector.

The [pinned Jito handler](https://github.com/jito-foundation/jito-solana/blob/a3f2fe92c1166c7ec9f21a3655b37877fe1279a3/rpc/src/rpc/bundles.rs#L90) looks an explicit slot up in live bank forks and refuses when absent. This distinguishes the observed bank-availability failure from wire decoding, but does not identify lag, pruning, fork differences or request routing. The [pinned bank enum](https://github.com/jito-foundation/jito-solana/blob/a3f2fe92c1166c7ec9f21a3655b37877fe1279a3/rpc-client-api/src/bundles.rs#L95) also distinguishes exact-slot and commitment profiles. Neither this source nor one discovery result proves endpoint qualification or repeatability.

Complete exact/discovery request and response bytes and monotonic timings remain in ignored work/release-qa/jito-retained-bank-availability-capture-20261024. Both actual exact-bank refusal captures were replayed offline through the final collector with fetch forbidden. Every original sent body, raw hash, bank and original floor matched; both returned bank-unavailable after exactly two logical reads. No new RPC calls were made for those replays.

## Verification and review

**500 tests pass across eleven files**, zero failures/skips, including 27 collector cases and the existing 473-case cohort. Pinned Node24, envDir:false. Plain project TypeScript, two-file typed lint and formatting pass. No full repository suite, build, browser, deployed integration or funded proof is claimed.

Real authenticated Opus 5.5 performed two unchanged source-only reviews with Read/Glob/Grep and zero denials or test execution. The first and a helper independently found the promise-adoption cleanup gap. It was fixed before the second review, which found no remaining blocker. Final implementation matches its copied source exactly. Codex subsequently tightened test coverage with plain-function abort depths0 through3 and fixed a test-only getter return type with identical emitted JavaScript. Final tests were run independently by Codex.

An isolated mutation reproduces the old bug: moving ownership registration back after Promise.race leaves cancellation count zero at depth2. The fixed implementation cancels exactly once at all four depths. The first mutation build failed because its stdin loader was not explicitly TypeScript; that setup failure is retained, was corrected without changing production source, and is not counted as a pass. The subsequent eight-case isolated comparison passes with no network calls.

## Coordination and remaining gates

Claude PR57 at 5f6870194aa7c44a7266ca1c23ba246625f27e80 covers non-Pump Sniper Guard/live views/cleanup in disjoint paths. Codex has not reviewed or merged it. See CODEX-CLAUDE-ACTIVE-SPLIT-20261024.md. Only Codex's own AGENTS claim update is staged; the original four dirty lines and seven frozen warmup drafts are preserved.

This checkpoint does not complete Jito qualification. Complete same-bank accepted raw capture, real swap/ALT/program admission, authenticated provider provenance, owned immutable evidence/authorization and exact signed final replay/recovery integration remain before mounting it in the existing send-once flow. No application/hosted SQL, schema, provider/credential/cron, wallet unlock/sign/send, funded trade or deploy change.
