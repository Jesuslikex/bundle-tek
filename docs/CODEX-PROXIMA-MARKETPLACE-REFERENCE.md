# Proxima marketplace runtime reference

12 October 2026, around 22:16 UTC. This is a read-only investigation of the existing user-approved dedicated Proxima browser. No wallet purchase, export, funding, signing or transaction submission was performed. Bundle application files and Claude's protected files were untouched while the current full suite ran.

## Observed workflow

REA target discovery selected the existing Proxima page, then a scenario clicked its observed marketplace link. The immediate navigation snapshot still contained the previous token workspace despite the new URL. A later passive inspection confirmed the loaded marketplace; the earlier snapshot must not be used to claim loaded marketplace content.

The loaded Solana catalog displayed 166 available wallets, a 50-wallet preview, count presets 25/50/100/200, funding-gap presets 30 minutes/1 hour/12 hours, a custom gap duration/unit, minimum one-day funding age and destination wallet folders. The preview lists trader, balance, price, net cost and funding source with sorting/filter controls. It displays total balances, total prices and net price separately. Values are transient catalog observations, not a promised inventory or verified economic result.

Advanced filters expose quality tiers, funding sources, activity timezone, funding-age range, balance range and transaction-count range. The tier descriptions distinguish funding-only history, light history and established activity plus token holdings. Funding-source labels include classic funding and exchanges. Region labels include US East, US West, Europe and Asia. The interface also exposes spacing against existing folders. These are product labels and filter options; their underlying attribution, selection algorithms and claimed clustering effects remain unverified.

The History tab changes the main panel to Purchase History with chain filters. This account showed an empty history and an explanation that completed orders appear there. No actual order, acquired-key delivery or prior purchase record was available to inspect. Visible chain choices do not prove supported execution on those chains.

## Passive network evidence

Navigation generated observed GET responses on `api-mig.proxima.tools`: `/marketplace/catalog/sources`, `/marketplace/catalog/count`, `/marketplace/catalog`, `/marketplace/prices`, `/marketplace/catalog/facets` and `/marketplace/purchases`. Their observed responses were HTTP 200. The catalog/count query names included chain, minimum funding age and minimum funding gap; catalog also included count. `/marketplace/quotes` returned HTTP 404 repeatedly during the observed window. This separates catalog rendering from unproven quote/purchase execution. Request/response bodies, header values, cookies and storage values were not captured. Only Proxima marketplace endpoint metadata is retained here.

## Evidence and limits

- Target discovery: `ev_f07e11b78acb982e05aa493db88fdd4c8862893f5d3dc2e597b21e4c63ae2967`.
- Link navigation: `ev_53629bc24baca24ed1953ef0b7515dd50de38e6b927a1be2428849e0f8125237`.
- Loaded passive marketplace inspection: `ev_611dfb8177d620cff6c9bf00de866bd4e9269eb970e3bf5ad9439f8db5556e95`.
- Successful advanced-filter and History scenario: `ev_81ef8f9483d14227c640324f1cb6320f7863f43a8f4c66503a4cd1bfe45ce2cb`.

An earlier advanced-filter attempt timed out because the button's loaded accessible name differed in casing from the earlier observation. History was cancelled in that failed scenario. The successful follow-up used the current observed label and completed both actions. No failure is presented as successful execution.

Current Bundle source search found no marketplace implementation under app, components or lib. Full parity therefore still requires a genuine inventory/provider contract, verified history/provenance, pricing and acquisition terms, secure delivery into the user's browser-encrypted vault, user-approved purchase/signing, immutable order receipts and current integrated UI verification. A catalog mock or generated-wallet warmup screen would not satisfy this requirement. Backend key custody, delivery, purchase authorization, coverage and execution remain unknown. Investigate those contracts before implementing or claiming an equivalent marketplace.

## Source-bound controller investigation

The browser-reported `page-LH53fNDi.js` asset was fetched as public inert source. Its SHA256 matches the current CDP script hash: `33ef7a195a3abe68d6b96c2e8604b2d1f88df87b0d30ad98edef2975e75d62f3`. Inspection showed token-workspace code, not the marketplace controller. Do not infer feature ownership merely because a script is loaded on the marketplace page. REA parsed all 471,162 bytes with zero parse failures, but its semantic graph hit a 100,000-node ceiling, retaining 27,379 unknowns. Analysis parent: `ev_3518aa2b41b29daea3262ffc5098971ab3a145aadd4e13ba093f3e5923f9dfa6`; exact asset item: `ev_39d5962dab12ff0478636a9ddb5afd1fcfe7261cbc0a5f65e3a4dd91d3d8ced4`.

The tiny loaded route asset `page-Dc9E2oAb.js` imports its rendered component from the shared main bundle. A bounded search of the existing source-bound recovered main regions located `chunk_DEFAULT_MAX_COUNT.js`, exporting `useHushximaMarketplace`. It was copied unchanged with its source map into `/opt/rea/results/proxima-marketplace-controller-20261012`. Original and copied JavaScript hashes match `e32d1e628519c5166bc242dac0ed661726353b9dfedface486d9740e02ad3ab4`. The underlying recovered main artifact is the already verified live main digest; the derivative remains inspection source, not independently proven runtime-equivalent code.

REA analysis parent `ev_55d5f1f105cfcb308b32664bf99ac73718a4d41f58c190e406427a45a827e418` parsed the controller with 2,847 visited AST nodes and zero parse failures. No semantic nodes/relations were omitted within this selected input, but 652 explicit semantic unknowns remain and dependencies/backend are outside it.

Recovered client syntax requests catalog pages of 500, a catalog count, facets, sources, prices and purchase history separately. Catalog and count declare 30-second stale times, facets/sources/prices 60 seconds and history 15 seconds. These are client cache configuration, not observed polling guarantees. Filter changes clear excluded-wallet selection; regenerate advances the preview offset. Quote creation passes the selected chain and inventory IDs to `proxima.hushxima.createQuote`, records a held quote ID under `hushxima.heldQuote`, and exposes separate fetch, refresh, settle, deliver and cancel functions. Completion clears held state and invalidates catalog and purchase-history queries. This identifies a client recovery lifecycle, without proving the service contract, payment rail, custody or successful delivery.

The exact REA backward-provenance trace for `createQuote`, `ev_9dd1f65a530ceb5283b8cc20d292ace0de15f27a9b246bf6c83529c151e9edb6`, finds one property read at controller line 365 and stops at unresolved `/hushxima/createQuote` receiver coverage. It must not be represented as a resolved backend call-flow or complete semantic understanding. No quote creation, purchase, payment, delivery or cancellation function was invoked during this investigation.

## Recovered service and checkout contract

A subsequent bounded dependency investigation added the existing recovered Hushxima service (`chunk_Shield$1.js`), account-context helper and checkout (`chunk_costModalNote.js`) alongside the controller in `/opt/rea/results/proxima-marketplace-service-20261012`. Each of the four JavaScript files and its source map was copied with original/copy SHA256 equality checked. REA parent `ev_96388a6d6ef48ad7ae48a39260bfe39d22690727ced8cbb4a0ecc439d693abb9` parsed four files with 11,859 visited AST nodes, zero parse failures and no omitted semantic nodes/relations within the selected input. It still retains 2,696 semantic unknowns and unresolved entry/vendor dependencies.

The recovered Hushxima class declares POST `/marketplace/quote` with chain, selected wallet IDs, count and `sell_tokens_after_purchase: true`. It declares GET quote/quote-wallet reads and separate POST refresh, settle, cancel, pay and deliver routes beneath `/marketplace/quote/{encodedId}`. The pay construction includes `funder_pubkey`. These declarations are source observations, not requests performed by this investigation or proof of their backend acceptance. The default sell-after-purchase term is financially material; Bundle must expose and bind such a term to explicit user approval if an equivalent provider flow is implemented.

Checkout syntax calls payment using the selected funder's public key, then changes to confirming state. While open and confirming, it declares a four-second settlement interval with fallback quote reads and cleanup on state change/unmount. After the quote is treated as settled, delivery returning pending or no wallets restores confirming state; successful returned wallets are assigned to selected folders, wallet-list queries invalidated and the completion callback called. UI text refers to receiving wallet keys, but the inspected completion code uses returned public keys and an imported count. It does not prove private-key delivery format, encryption or exclusive custody. Do not assume Bundle can securely import acquired keys from these labels alone.

The `payQuote` backward-provenance trace `ev_21ffbba2102984181176cd6394b2cde1df7ce406df1c1dc73c378b1d474512d2` still stops at an unresolved receiver at checkout line 628. Service method declarations and runtime catalog metadata corroborate endpoint naming, while complete dynamic controller-to-service identity and backend signing remain unproven. No payment, settle, deliver, sell-all or key export call was executed.

The complete current REA session was exported to `/opt/rea/results/proxima-marketplace-investigation-evidence-20261012.json`: 228,614,860 bytes and 45 retained records. The export's zero top-level unknown-record count does not override the explicit semantic unknowns and limitations above. The file includes earlier session evidence as well as this investigation; select exact evidence IDs when reading it rather than attributing every record to marketplace behavior.
