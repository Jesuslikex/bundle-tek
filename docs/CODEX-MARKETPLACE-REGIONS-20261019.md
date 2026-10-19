# Reported marketplace regions

Live ordinary Chrome inspection of Proxima on19October confirmed region buttons under Advanced Filters, including US East, Europe and Asia. This was UI evidence, not supplier/API, geography or purchase-fulfillment proof. No Proxima purchase, regeneration or funding action was invoked.

## Implemented

The existing provider inventory may optionally include `listing.region`. Bundle accepts one exact `region` or up to20 exact `regions` in the authenticated catalog query, applying them before quantity, funding spacing and integer totals. Missing regions never match a selected region. Provider labels are not inferred from addresses, funding sources or network data.

The response includes optional sorted, unique `regions` choices from the whole loaded inventory, not just its filtered subset. Each displayed row must agree with those choices and the requested region filter. Empty or conflicting choice metadata is refused. Region labels reject surrounding whitespace, control/formatting/line-separator characters and reserved missing-value wording such as "Not reported". Ordinary readable international labels remain supported. This is not a guarantee against every visually confusable Unicode character.

Desktop rows and phone cards display the reported region, or "Not reported" for an absent label. Advanced controls support typed or multiple reported choices, reset and retained selections. The UI says choices come from the last loaded snapshot and do not verify wallet location. A legacy snapshot with no labels explicitly says so. Invalid local region input gets a specific error before a request; bad response metadata hides the preview with the existing safe error.

## Compatibility and limits

The v1 format names remain. Region-free legacy inventories and default result JSON keep their existing shape, with no new metadata field. Region-bearing data is an optional extension understood by this frontend/server; older strict clients or server ingesters may refuse it safely. Release matching code together, enable supplier region fields only for a compatible server, and omit them before rolling back to a pre-extension ingester. Mixed-version acceptance of rich-region data is not promised.

Invalid provider region data rejects the complete snapshot rather than silently dropping a row and overstating coverage. Funding-source validation,60-second freshness, funding age/gap constraints, duplicate identities,200-wallet limit, query/body budgets, cancellation, exact lamport arithmetic and the single GET-only provider transport remain unchanged. Checkout remains literal false. No supplier, payment, delivery or recoverable purchase integration is supplied by this work.

## Verification

Four files/65 tests pass: catalog34, provider7, API8 and UI16. Tests cover legacy omission, exact/case-sensitive and combined filtering, missing values, malformed/reserved/formatting labels, readable international labels, duplicate/conflicting/oversized filters, mismatched response choices/rows, one-GET transport, unchanged disabled checkout and credentials staying server-side. Typed lint and formatting pass. The isolated production build including TypeScript passes on base `22049a2` plus six owned overlays, with unchanged source hashes. The earlier full-suite baseline is separate from this delta.

Actual restricted Claude review returned only `claude-opus-5-5`, with no tools or fallback. Opus found no blocking defect and identified ambiguous labels, compatibility wording and misleading local validation copy. Codex adopted those corrections and independently ran the final tests, build and browser checks. Opus did not run tests or browse Proxima.

The current real components/model were browser-tested against synthetic transport data, without an account, actual supplier, provider request or financial action. At1440/375/320, document widths were1425/360/305; two matching rows became two phone cards, preserving a one-lamport price difference. Reset performed no request. A legacy snapshot showed three "Not reported" rows and no region choices. A malformed local label performed no GET. Inconsistent metadata removed the table and displayed a safe error, without automatic retry. The standalone fixture initially lacked Next.js build-time environment constants; correcting its bundler fixed that harness failure without an application workaround. JPEG captures and sanitized reports are under `docs/qa/20261019/marketplace-regions/`; filename widths denote viewport width, not scroll-bar-excluded image width.

No protected Claude layout, account-session, actual provider transport, API handler, credential/provider setting, database or migration was changed. No deployment, real wallet unlock/sign/send or funded trade. Full marketplace fulfillment and overall Proxima parity remain incomplete.
