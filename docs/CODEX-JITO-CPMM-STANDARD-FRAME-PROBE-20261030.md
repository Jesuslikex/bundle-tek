# Exact-slot standard Jito frame capability

This follows `6638b0a` on the same unmerged draft branch. User boundaries remain no deployment, hosted SQL, provider or credential changes, wallet unlock, signature, submission or funded trade. Full qualification and signing remain false.

## Why this probe

The archive method supplies only touched/writable post-images. The existing complete-frame verifier still requires actual complete pre/post vectors. The current [Alchemy standard `simulateBundle` API](https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/simulate-bundle) documents per-transaction pre/post captures and bank selection. [Upstream Jito configuration](https://github.com/jito-foundation/jito-solana/blob/256fbf9b601a98551636a2a394158067014f47b3/rpc-client-api/src/bundles.rs) includes an explicit numeric-slot selector. Neither is a provider guarantee that a separately discovered bank will remain available, identify its fork or provide independent same-bank fees. Earlier native bank refusals remain historical evidence; this query uses the freshly built setup/CPMM-swap/tip vector.

## Bounded implementation

`probeJitoCpmmLiveFrames` sends exactly one read-only standard simulation request. It snapshots the scope before I/O, requires one to five canonical base64 packets with one zeroed signature, canonical unique account addresses, and a selected slot within the original 32-slot floor. It uses the existing separately bounded bundle transport without raising its read, method or byte limits. All requested rows use that exact slot, base64 captures, signature checking skipped for unsigned simulation, and blockhash replacement disabled. No state override, fallback, retry or signing method is available.

The sequence CLI opts in only with the additional final `--with-jito-frame-probe` flag after code, market and compression flags. The one side request overlaps the full archive simulation, and its result is awaited before financial checks/final code scan proceed. An observed side 429 stops the attempt before further reads; already in-flight reads may complete. The final normal slot check remains after the side request and all original checks. Its extra wall time is therefore counted. Default command behavior is unchanged.

Scope geometry, exact returned slot and account counts can only yield a diagnostic observation, never financial/frame/bank/fee qualification. Any raw result and actual wire request/reply captures stay in ignored `work/`. The helper labels every authority flag false and preserves typed integer strings. Full financial replay remains the separate unchanged verifier. Missing/null/default accounts are not converted or filled.

## Live outcome

One Node 24.22.1 attempt used original floor **463412293**, simulation **463412304**, final read **463412324**, a 31-slot span. Its ordinary archive sequence passed the existing actual pool/oracle/token/rent, external-price, both complete code scans, custody and final lifetime checks.

The parallel standard Jito request sent the exact same three unsigned packet strings, `simulationBank: {slot: 463412304}`, and eighteen requested pre/post accounts for each of three rows. Alchemy returned JSON-RPC **-32602** with the exact admitted `bank not found for the provided slot: 463412304` error. One HTTP/method unit, 123 response bytes, no 429, no second slot request and no fallback. Request and raw-body digests recompute exactly. `CODEX-JITO-CPMM-STANDARD-FRAME-PROBE-20261030.json` records sanitized evidence and input-capture digest. Archive success is not standard-Jito success.

This confirms that the remaining exact-bank availability problem also occurs for the complete CPMM vector; it is not explained by old Jupiter source verification or the earlier native fixture alone. Backend routing, retention and fork changes remain hypotheses. The response does not identify the serving node/fork or establish why the requested bank was unavailable.

## Verification and stopping condition

758 focused tests in 27 files pass on Node 24.22.1, as do TypeScript, three-file typed Oxlint and formatting. New tests cover exact request selection, false authority flags, stale/mismatched context, missing post vectors, exact bank-unavailable classification, no retry/fallback, first 429 and signed/oversized/duplicate/out-of-window scope refusal before I/O. No full repository/browser/build/funded verification is claimed.

The same external bank/post-state/fee contract remained missing through the pool replay, compressed-timing and this final capability checkpoint. Client code cannot attest an upstream bank/fork or produce omitted provider observations. A qualifying provider/validator must actually supply the already-defined immutable-bank, independent-fee and complete-account evidence under verified semantics. No such configured service is established. The user has no dedicated validator/server and declined contacting providers; those decisions remain respected. Do not substitute slots, infer missing images, relax limits, repeat the unchanged probe until it passes, or promote partial archive success to full qualification.
