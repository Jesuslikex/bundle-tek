# Jito exact-bank read-only checkpoint, 24 October 2026

This improves an unsigned diagnostic. It does not complete imported-swap economic/runtime qualification or enable signing. No deployment, hosted SQL, provider/credential/cron change, real wallet unlock/sign/send or funded trade.

## What changed

The existing Alchemy holder endpoint now selects a bounded coherent read profile before starting its diagnostic. Other providers retain the existing sequential profile. Refusal never selects another profile or endpoint.

1. An unsigned `simulateBundle` at confirmed commitment supplies an **unadmitted bank hint D**. It cannot supply fee, economic, signing or execution authority.
2. One actual JSON-RPC batch requests each original packet's fee and a separate exact-slot simulation at D. Every actual fee context and the simulation must equal D. Mixed fee slots, missing/reordered/duplicate replies and invalid frames refuse. The original minimum slot F and F+32 ceiling remain unchanged; D does not renew the window.
3. Capture retains the complete raw parent, exact member byte ranges and hashes. The fee array assembled from member bytes is explicitly a **derived projection, not a network response body**. No numeric values are reserialized. The exact simulation request must match its actual parent member.

Original packet bytes, blockhash replacement/signature mode, fee ceilings, ALT snapshots and final rechecks, genesis checks and owned/current/unsigned source checks remain. Worst-case four-wallet/ALT composition stays within **12 HTTP reads / 17 RPC method units**, below the unchanged 12/18 limits. Existing ordinary pacing reserves each method; no qualification-specific pacing setting is changed. HTTP429 and parsed RPC429 stop further reads, including null/unexpected IDs or a top-level error object in an otherwise refused batch. This stop signal grants no evidence admission. Cancellation owns late responses and closes their bodies. Invalid/oversized JSON cannot expose a parsed error code; it is refused as invalid evidence, without a semantic429 claim.

No signing, submit, registration, recovery or financial database rules change. Every public authority flag remains false. No protected Claude UI file changes.

## Measured results, including refusals

Retained private evidence lives under ignored `work/release-qa/`. No keys or provider URLs are published. `CODEX-JITO-EXACT-BANK-20261024.json` contains portable hashes and sanitized measurements.

- Initial alignment harness setup refused after one genesis read because the harness passed an invalid parser option. Preserved, corrected in harness only.
- Sequential discovery -> fee -> exact simulation still failed: discovery and actual fees both used **460707102**, but that bank was not available to the next exact simulation. Lowering the floor or switching banks was not used as a remedy.
- The first mixed-batch native probe admitted complete frames with both fees and simulation at **460708471**, inside original F=460708470. One observation, not repeatability.
- The reusable campaign's first startup failed **before any RPC** because its source manifest treated esbuild's known virtual entry as a disk file. The failed receipt is preserved. The fix hashes that entry explicitly and refuses unknown virtual inputs; a real offline compile/import test covers it.
- Exactly three planned native attempts then ran, with no replacement or automatic retry. All **17 HTTP reads / 23 RPC methods** returned HTTP200; no429 occurred. The same public payer stayed pinned. Both packets were unsigned zero-value System transfers; no signatures were created or transactions broadcast.

| Attempt | Original F | Discovery D | Actual fee slots     | Exact simulation slot | Outcome                                       |
| ------- | ---------- | ----------- | -------------------- | --------------------- | --------------------------------------------- |
| 1       | 460711870  | 460711872   | 460711872, 460711873 | 460711872             | Refused: fees differ; simulation not admitted |
| 2       | 460711873  | 460711874   | 460711874, 460711874 | 460711874             | Native frames admitted, final genesis matched |
| 3       | 460711876  | 460711877   | 460711877, 460711877 | 460711877             | Native frames admitted, final genesis matched |

**2/3 native attempts passed. This is not reliable full qualification.** The first refusal demonstrates that even one provider batch does not guarantee a coherent bank. The unchanged equality check correctly rejects it. There is no additional campaign until a new bounded investigation is justified.

The measured campaign exercised the collector directly, without the application's pacing, ownership or ALT path. Later harness hardening adds ordinary production pacing once per method and snapshots the exact source bytes supplied to esbuild, refusing concurrent source changes. Those refinements have offline tests, not a new live sample. The original campaign's compiled artifact hash remains retained; its post-build source hashes are historical diagnostics, not a frozen-source claim. Current-source offline replay reproduces the actual native responses unchanged.

The safe public native request/response samples are retained in `test/fixtures/jito-coherent-native-20261024.json`. Offline replay checks exact original request strings and raw response hashes against the current collector, reproducing both successes and the refusal without network access. These are actual public native samples, not real swap or funded evidence.

## What still prevents full read-only swap qualification

- Saved preparation summaries in `lib/imported-swap-preparation-history.ts` omit the complete original `ImportedSwapSimulation`: raw settlement accounts, account bindings, decoded route, lookup observations and Token-2022 proof cannot truthfully be recovered by casting summaries.
- `verifyJitoBundleEconomicObservation` requires independent raw mint/Rent observations bracketing the exact bank, within the same original window. They are not collected by this diagnostic. Adding independent calls to the worst-case path would exceed its unchanged read budget; collection needs an explicit bounded design.
- Existing economic replay uses historical scalar simulation fees. Fresh same-bank fee observations need an explicit provenance-bound input; overwriting historical observations would misrepresent them.
- Raw frame replay derives requested privileges, not a fully qualified runtime privilege downgrade/reserved-key model. Unsigned samples cannot prove real signatures, final settlement or execution readiness.

Do not label this source as provider-qualified, economically qualified, fully Proxima-equivalent or ready for funded execution. The exact-bank availability blocker has a measured improvement, not a universal availability guarantee.

## Verification and coordination

Final unchanged isolated overlay: **795 tests / 35 files**, **19 native harness tests**, plain TypeScript, scoped typed lint and formatting pass. All three retained actual native samples replay against the current collector offline. This is focused Jito verification, not the full repository suite or a production build.

Verification uses an isolated archive of committed main plus only this owned Jito overlay, with no `.env` copied. Unrelated warmup/Auto Sell edits and the seven unfinished warmup drafts stay outside the checkpoint. Exact test totals and source hashes are recorded in the companion evidence. Actual Opus5.5 source review found the unmatched-ID429 stop bug; it was independently confirmed, fixed and tested. A second actual Opus5.5 review confirmed that blocker closed and found no remaining blocker in its focused scope. Both reviews were read-only, copies unchanged and zero permission denials; the reviewer ran no tests. Later campaign source-snapshot/pacing refinements received independent tests, not a further Opus review. No browser-rendered, production, funded or full-suite result is implied by these focused tests.

Claude should continue disjoint work through PRs from current origin/main, using the existing claims. This Jito slice remains Codex-owned. Existing PR57 review concerns and acknowledgement status are not superseded by this diagnostic checkpoint.
