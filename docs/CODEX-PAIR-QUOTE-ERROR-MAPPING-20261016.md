# Pair quote-bound API error mapping

Follow-up to Claude's user-relayed approval of `3ef640e` (17 files / 371 tests on Claude's side). The minimum-output guard and code-packing implementation remain approved, and the stage measurements are already committed as `3f99d2c` in `CODEX-PAIR-RUNTIME-STAGE-HANDOFF-20261016.md`.

## Confirmed gap and fix

The early quote-bound check already returned a fresh-quote HTTP 409. A `PairOrderQuoteBoundsError` from the repeated check inside `reviewPairOrderInstructions` instead reached the candidate service's generic error conversion. The status remained 409, but the fresh-quote explanation was lost.

The candidate service now maps the recognized typed quote-bound error at its outer boundary. Both early and nested instruction-review errors use the same conversion. The duplicate early-only catch was removed. Other errors retain their existing sanitized handling; arbitrary provider messages are not forwarded.

Both `/api/imported-projects/pair-order-candidates` and `/api/imported-projects/pair-order-runtime` now return HTTP **409**, `Cache-Control: no-store`, and this same JSON body for a worsened minimum:

```json
{
  "error": "The unsigned order offers less than the original minimum output. Request a fresh quote; the original minimum was preserved."
}
```

The bound itself is unchanged. No amount, quote, consent, fee allowance, reservation, instruction policy or signing permission is modified.

## Verification

Four new actual Request/Response route cases cover two routes and two points of failure. Each reduces the provider order's minimum by exactly one raw unit. Early cases fail before fee/code/simulation reads. Late cases mutate the synthetic order after fee collection so the repeated instruction-review guard must handle the refusal; the runtime case proves its first code observation was reached. All cases preserve the original minimum, return exactly the fresh-quote body, make no simulation call and create no project events. Authentication, RPC and owned in-memory SQL are controlled by the existing fixtures; no live wallet/provider is used.

A local test-loader replay using the committed `3f99d2c` mapper, without editing the working-tree source, reproduced both late-case generic-message failures. The two early cases passed. With the corrected mapper, all **five selected files and 149 tests passed** together in **11.78 seconds**:

- `app/api/imported-projects/pair-order-candidates/route.test.ts`
- `app/api/imported-projects/pair-order-runtime/route.test.ts`
- `lib/pair-order-quote-bounds.test.ts`
- `lib/imported-pair-order-candidate.test.ts`
- `lib/imported-pair-runtime.test.ts`

Standalone TypeScript, typed lint on the three changed TypeScript files, whitespace checks and 1,284 frozen source/config hashes passed. This is focused API/service verification, not a new production build or complete repository run. The earlier 801-test serial checkpoint and its unresolved parallel candle 503 remain as previously documented; that unrelated test was not changed or retested here.

## Runtime constraints and handoff

No runtime optimization or new live profile was introduced here. The existing measured run used 37 policy slots, with the first code scan contributing 16; the final complete code scan was not reached, remains required and must use fresh evidence. The 32-slot limit, final recheck and default one-read-at-a-time group code collection are unchanged. Stock signing stays off. This small error-mapping change does not qualify the live path.

Claude-owned UI and main's two unrelated dirty files are preserved. No wallet unlock, real signing/submission, provider or credential change, cron, hosted SQL, push or deployment occurred. Local QA logs/helpers remain ignored under `work/pair-error-*` in the Codex checkout.
