# Front / Back launch funding field map

18 October 2026. Follow-up to CODEX-PROXIMA-FRONT-BACK-MEV-20261018.md. This records additional artifact analysis and primary documentation, not an implemented executor or permission to move funds. The full Proxima parity goal remains open.

## Evidence integrity

REA analyzed five exact original function slices from the retained index-C1cJCLGU.js client. Original SHA256:4284b828a9309df4b43e02bc4ecfb6a3feaf5b5d1563e89fc4f3288b253e5b58. Private provenance and inputs are in Desktop/REA/results/proxima-mev-funding-focused-20261018. No vendor source is copied into Bundle.

| Original callable | UTF-16 start..exclusive end | Slice SHA256 |
| --- | --- | --- |
| buildLaunchPlanFromSettings | 4463604..4467698 | ebc101854ac515a1fd8c2bc9ae91356b12f7b574e524facefdc77871ee5b7611 |
| formatRequiredDisplay | 4589068..4589569 | 16cdccafd8657b44d506e50f08dc3c9c9dddc9c8f734d900081b0fce2066e9bf |
| LaunchSetupWalletTable | 4591290..4593582 | 2f1562d945f5ca7c906a3dfc385cc3a914768626ed75173ee8ddb227557aea80 |
| toSetupWalletRow | 4601831..4602008 | e29e3115f7e1184de686ea962bc6717da1432e562cc5e3e02b3156ddd14fb1f9 |
| buildWalletRows | 4602008..4602388 | 9ac091a493c1aade94f84dc690d1395343dcd91d564b9d2e12a64fee9167599f |

Summary ev_52681c9272d2b682eafe1ab4eb18f3f8ac5c3b33a386fee0c159313f93dff887, retained parent ev_2e0fc4be7cf6d6b1d412d783491b6fff31bac5cd34f67f42b9eac9517ba360f3, artifact digest18c47f7e027075cd10723c5b50feacb2bf2b3cb088f8eb711d088a643f4997eb. Five files/7450bytes/1834AST nodes, no parse failures,1320semantic nodes/1217relations, no truncation. Semantic status remains unknown with373unknowns, including unresolved external helpers and aliases. It is static evidence of field operations, not runtime control-flow or backend proof. Module identities were paged and selected by exact returned node IDs. Complete private final-evidence-bundle.json has12records/4933661bytes, including earlier retained observations.

A local integrity check independently reread the original, compared every exact UTF-16 slice and SHA256, checked the expected parent record and parse/truncation metadata, and confirmed Front/Back property writes and required-native reads in the retained semantic graph. No app execution or provider request was made by that check.

## Recovered client contract

- Role arrays are distinct: dev/funder/front_mev/back_mev/temp_holder/holder. The setup renderer preserves each role and per-wallet buy_supply, buy_native and required_native fields; its table totals the latter separately from buys.
- In the selected builder's mev branch, Solana can construct Front and Back arrays and conditionally temporary holders. Other networks take different branches. Other launch modes clear these arrays. This does not prove every launchpad admits every branch.
- front_to_back_delay_ms and back_to_temp_delay_ms are milliseconds, while funding_delay is converted to whole seconds. They must not share an unlabeled numeric field in Bundle.
- The builder selects buyback versus airdrop under an external capability predicate. Those are distinct protocols; no alias/helper implementation or airdrop executor was recovered in this slice.
- Imported plans force scheduled_mode in this client. The linked live setup also explicitly displayed Imported Yes and Scheduled Mode Yes, so it cannot prove a new-mint deployment sequence.
- Separate bounded AST inspection of the retained API class found getRequiredFunding and getExpectedFunding methods, plus rescueFunding and swapToQuote. Their route names are static request hints, not invoked endpoints or evidence of a server calculation. In particular, no recovered function derives the observed required_native values from first principles.

## Primary documentation cross-check

Proxima's [launch-mode documentation](https://docs.proxima.tools/create-launch/launch-settings/launch-modes/) distinguishes initial Front execution, optional subsequent Back buybacks, optional temporary transfers and final holder allocation. These are vendor-described stages, not verified on-chain outcomes.

Its [Block-0 configuration](https://docs.proxima.tools/create-launch/launch-settings/block-0-configuration/) says StonkFun supports Front MEV only, up to12wallets, without Back or temporary layers. General Solana presets therefore cannot simply be applied to the stock-pair route. Availability also depends on the launchpad/variant/quote.

The [funding workflow](https://docs.proxima.tools/create-launch/funding/) describes native distribution and optional subsequent custom-quote conversion, retaining native gas. It distinguishes new deployment, scheduled buys and imported-token Snipe. No private key or enabled financial action was used in our inspection.

## Implementation consequence for Bundle

The next implementation must cover the whole supported role flow; adding three editable amounts to generic funding would leave an unsupported execution and recovery path. These are requirements, not delivered functionality:

1. Pin the launchpad, chain, quote, new/imported mode and supported layer protocol in immutable owned launch terms. Keep intermediary wallets separate from holder counts. Role membership must bind current wallet and folder revisions and remain unique across roles.
2. Derive exact native and quote obligations from fully decoded unsigned actions and route/mint evidence. Separate purchase principal, worst-case quote spending, network fees, rent and retained reserves. A displayed vendor funding target is not a transferable constant. Use integer units and explain every per-role and aggregate total.
3. Build and independently simulate the initial launch/buy group and every subsequent buyback or transfer stage with required program/code, custody, minimum output and lifetime checks. Never substitute a transfer for an economically different market buyback.
4. Persist stage ownership, exact bytes and hash, fresh review, separate unchecked approval, browser signing, one durable send attempt and finalized recovery. Funding must not become available for a role protocol whose downstream execution/recovery is still unsupported.
5. Present funded/required/shortfall progress per native and quote asset, with meaningful retry/recovery actions and no automatic signing, depositing or redistribution. Preserve uncertain outcomes and partial holdings rather than restarting a layer.
6. Verify at model, actual local API/database, rendered desktop/mobile and read-only provider boundaries. Funded validation and publication remain separately authorized. Maintain stock signing-off and all existing qualification gates.

The reviewed Jito launch-group, holder funding and explicit signing machinery are foundations to reuse where their assumptions match. They do not already implement this protocol. No interface was added that invites a user to fund unsupported Front/Back stages. Current work is an evidence and implementation-contract checkpoint; the other chat's warmup source/build was held stable.
