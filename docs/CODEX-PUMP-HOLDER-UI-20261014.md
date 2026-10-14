# Complete holder launch UI checkpoint

14 October 2026. Local implementation only, based on b5edfdd. The preceding UI notice records file ownership before edits.

## Behavior

Saved Pump plans with positive holder buys now open the complete holder review instead of silently preparing only the developer buy. The parent supplies the saved document through the metadata panel. Missing saved document, payer, metadata or supported scheduling prevents preparation.

The panel reads unsigned preflight targets, preserves ordered zero-allocation slots, collects individual SOL fee/rent limits and either quote caps for supply targets or minimum token output for exact quote budgets. Preparation independently validates the saved selection and all limits on the existing server route. A cost table shows the deployer and every holder, their token outputs, actual quote spend versus caps, and fee/rent versus limits. Stock quote precision comes from the reviewed asset; base-token precision remains separate.

Two explicit unchecked review consents gate browser-local signing. The client reconstructs the immutable packet, approves the exact context with the server, checks current draft/expiry/vault storage around asynchronous operations, unlocks encrypted mint and wallet vaults locally, and maps every required signer to the appropriate vault. Temporary unlocked sessions clear in finally. Passwords and seeds are never API fields.

Signed bytes persist before registration. Failed registration can save the same packet without signing again, including after expiry; memory-only storage failure exposes a download/recovery path. A separate unchecked broadcast approval gates submission. Submitting/submitted packets expose recovery rather than resend. History and expired-unobserved receipts preserve unresolved fees explicitly. Developer-only receipt rendering now handles that expiry evidence too.

The client validates complete financial rows, context/packet/allowance bindings, settlement evidence and finalized/expiry receipt shapes before using server responses. HTML error pages produce plain panel errors.

## Verification

- Node 24: 278 tests across 23 files passed. This includes complete holder API, execution, signing, durable review, settlement, simulation, funding, targets, message and pricing suites; developer/create simulation, signing, preparation, recovery and routes; client model, new holder panel, existing launch/metadata panels and token details.
- Component tests cover exact consent and signer mapping, storage changes, unmount during approval, registration retry, expiry, HTML responses, zero slots, stock token program variants and exact quote budgets. Synthetic keys and controlled service responses only.
- Actual-source TypeScript, ten-file typed lint and production Next build pass. The build includes the holder API route. No test-only application route was introduced.
- Existing Chrome rendered the actual panel and application CSS using an ignored, loopback-only Vite harness. It returned one controlled saved review on holder-history GET and rejected all other API calls. Desktop 1920 and phone 390 by 844 were inspected; phone document width was 375 with no horizontal page overflow. Four cost rows included a zero-buy slot. The synthetic TSLAX review uses eight quote decimals.
- Local screenshots: work/pump-holder-desktop-20261014.png, work/pump-holder-costs-20261014.png and work/pump-holder-mobile-20261014.png. These are controlled UI evidence, not provider execution proof. Wallet extension warnings were observed; no claim of a clean browser console. The harness was stopped, its tab closed and viewport override reset.

## Remaining work and release limits

The browser check does not establish a real authenticated workspace-to-provider round trip, actual vault unlocking, signing or funded execution. Component and route tests cover those boundaries with fixtures. The fixture's reconstructed metadata packet is UI evidence, not a fresh live RPC simulation of that URI.

Complete holder launches currently fit one packet only; the backend rejects more than 64 static accounts or 4096 bytes. Larger groups, scheduling and StonkFun execution remain unavailable. Switching a saved plan back to no holders can make older holder history less discoverable; unified launch-history navigation is still needed. Older reports without strict source-bank evidence cannot pass the new client parser. No funded production holder records were created by this local feature.

Migration 0081 remains local only. No remote SQL/migration, credential/provider setting, cron, push, deployment or real-wallet signature/broadcast was performed. Production remains the separately verified 11ad20b release. Full Proxima parity and funded proof remain incomplete.

Protected holder/supply/performance files and global CSS are unchanged. Main's unrelated dirty CODEX-JITO-ATOMIC-BUNDLES.md and 0068 SQL bytes must remain untouched. Runtime harness files, screenshots and generated data remain ignored and outside the commit.
