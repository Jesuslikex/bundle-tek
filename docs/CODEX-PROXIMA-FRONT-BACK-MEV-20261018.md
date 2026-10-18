# Proxima Front / Back MEV funding

18 October 2026. User explicitly selected a Proxima launch funding page and clarified that Front/Back MEV wallets require funding. This observation corrects the scope of the earlier transaction-delivery audit. It is not permission to fund, distribute, launch, sign or submit anything.

## Fresh live evidence

REA reconnected to the existing approved dedicated Chrome at loopback9223 by restarting its previously approved Windows/WSL stdio relay. Chrome itself and its profile were already running. Discovery confirmed the exact user-selected funding page; initial REA page inspection and screenshot were passive. A subsequent controlled scenario opened only the observed View launch setup button. Another scenario restored the original funding page. No financial controls were clicked, fields edited, cookies copied, keys read or network bodies captured.

- Live page inspection: ev_8929845b5a802425fb9af7d5c3521d5f7914bf665ed766c227c175c68959dc5a.
- Live1920x945 funding screenshot: ev_cba1047c33fda2e17345412d3a46d7510c1475d3186f7c0814cc9ba8e223826e, PNG SHA256 d3573d7ef22e64c2d3b1350bbb38fbe6d0d4c6e93fb4352cbc27829cc4611923.
- Read-only Launch Setup dialog: ev_f2f0aba1283cbf2ec6c005594bb168b581fbdd7e1fa618e853743204357d6f1b.
- Original funding-page restoration: ev_03d25e79f910e5ad333c2d8cdf2e46acd86d6be424642dd899f2eb735c552cce.

The current SOL-quoted Block-0 configuration explicitly has one Front MEV wallet, two Back MEV wallets and five holders. The three MEV rows have separate nonzero native funding requirements. The page shows wallet distribution progress, separate Distribute and Launch steps and a Rescue action. Setup also shows a Front-to-Back delay. This is a launch wallet-role and funding workflow, distinct from the transport/protection notices recently added to Bundle.

Private capture retains this draft's amounts, addresses, totals and screenshot. They are excluded from this Git note because they are account-specific and are not universal fees or funding advice. The header, funder requirement, distributed total and setup total differ; their economic reconciliation remains unknown. Disabled actions with zero funding do not independently prove the exact server gating predicate, transaction sequence or execution guarantee.

Complete private evidence: C:/Users/Julian/Desktop/REA/results/proxima-front-back-mev-20261018-final-evidence.json,2666615bytes,seven records. Setup screenshot: proxima-front-back-mev-20261018-setup.png,223845bytes,SHA256 f1aeb81ad76c0c7ed26dc91d5c9a07ac102ae8e59eb1486dd0783adc5130ef68. Export completeness does not remove attach-window or page-capture coverage limits. Current-page source identity and server internals were not recovered.

## Retained client hints, separate from live execution

Bounded literal inspection of the retained entry-input/index-C1cJCLGU.js identifies explicit front_mev/back_mev arrays, Front MEV Count and Back MEV Count controls. Its text describes Front MEV as first buyers before buybacks, Back MEV as an optional buyback layer before holders, and a possible Front → Back → Temp Holder → Holders token flow. These are historical client descriptions, not semantic proof of backend execution. Their natural-looking activity claims are vendor copy, not behavior or economic guarantees adopted by Bundle.

## Bundle gap

A bounded search of current lib/components/app TypeScript/TSX finds no explicit front_mev/back_mev, frontMev/backMev or Front MEV/Back MEV role implementation. Existing launchFundingRecipients selects ordinary Recipient and optional Deployer assignments; pump-holder-funding constructs deployer/holder balance and allowance evidence. Jito bundles, RPC delivery disclosures, initial buys and holder funding do not establish this separate wallet-layer protocol.

Full parity therefore still needs a separately specified and verified role-aware launch preparation/funding/distribution/recovery workflow, with explicit economic purpose and ownership disclosure. Required checks include exact role assignments and budgets, explained fees/rent/working capital, packet semantics and conservation, fresh custody/lifetime admission, separate user approvals, one-attempt submission and finalized recovery. Do not create an apparent holder count from intermediary wallets or describe coordinated activity as independent demand. No implementation or live execution of those layers was added by this investigation.

Documentation-only checkpoint. Evidence export and PNG digest verified locally; no application/test source changed and no test rerun was needed. The other Bundle chat's warmup files and browser ownership were preserved. No push, deployment, hosted SQL, provider/credential/cron change or funded action.
