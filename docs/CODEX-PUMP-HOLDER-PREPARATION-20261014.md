# Owned holder packet preparation

Connected the holder packet assembler to owned saved projects and independently collected creation context. The new server-internal preparation validates the deployer/released metadata and every selected holder's active revision, role, ownership proof and folder before provider reads. It uses the saved target distribution with observed Pump supply/reserves and exact quote identity/precision. Client terms cannot override token targets or reorder wallets.

Each active supply-target holder requires an explicit quote cap and fee/rent allowance; each quote-budget holder requires an explicit minimum output and fee/rent allowance. Quote spending comes from the saved budget, not the percentage field. A developer quote cap is required only when a developer buy is saved. Inactive slots require zero allowance and no invented buy limits. The result contains separate project/deployer, holder-selection and canonical allowance fingerprints, alongside the exact unsigned packet and ordered targets.

Project/deployer and holder bindings are checked again around construction. Metadata releases retain their database immutability guards. The holder loader now exposes a wallet-only binding for checks before RPC, while its existing observed-target manifest remains available. No API or UI has been changed to grant holder approval.

## Verification

Four focused files passed, 51 tests, Node 24: owned preparation with real local libSQL plus controlled creation collection for SOL, stock supply targets, stock quote budgets and Token-2022 stock quotes; inactive slots; ordered limits; target-override and wrong-denomination rejection; watch-only/revoked holders; and existing holder-message, creation/developer-buy API regressions. Actual-source TypeScript, scoped lint and production build passed on final source.

The preparation fixture uses the existing validated trade configuration, because the older create-only fixture has empty buyback recipients that correctly fail trade construction. A single create-only simulation occurs in these preparation tests. No actual holder transaction is simulated or signed.

## Unfinished execution proof

The result explicitly distinguishes `creationSimulation` from `allWalletSimulation=null` and `fundingValidated=false`. A passing creation-only simulation is not proof for the larger packet. Independent all-wallet funding and sequential curve/fee/rent/quote settlement simulation, reservations, durable approvals, multi-wallet signing, submission/recovery, UI and larger-group handling remain necessary. Execution/signing/complete-launch flags remain false.

No remote SQL, provider/credential change, cron, signing, broadcast, push or deployment occurred. Claude's protected files and main's unrelated dirty work are preserved. Last verified production checkpoint remains source `11ad20b`.
