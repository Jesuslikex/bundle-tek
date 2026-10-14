# Unsigned multi-packet Pump launch assembly

14 October 2026, based on ae8f02d. This is an assembly foundation for complete larger selections, not a user-facing executable launch group.

## Change

The existing holder assembler now shares its validated instruction units with a new buildPumpLaunchPacketGroup utility. All saved holder intents are validated before construction. Creation and the optional developer buy stay together in the first indivisible unit. Each active holder's ATA setup and exact-output or exact-quote buy remain in one indivisible unit. Ordered greedy packing closes a packet when the next unit exceeds an admitted bound; it never removes a wallet or splits a wallet's setup from its buy.

Each packet uses the original deployer as network-fee payer, the same blockhash/lifetime and explicit v1 compute/data/priority configuration. The mint signs only the creation packet. Active buyers sign their own packet; zero-buy wallets do not sign. The pinned SDK limits are enforced before trial compilation: twelve signers, sixty-four instructions and sixty-four account addresses. Serialized packets must also fit 4096 bytes. Unknown compiler failures still abort the whole build. An indivisible operation that cannot fit rejects the entire group rather than returning a partial result.

The result contains exact ordered unsigned packets, signer lists, public derived buyer accounts and original holder-index membership. Every slot, including zero buys, is retained in a hashed manifest with exact denomination/caps/minima, packet index, developer terms, packet hashes and the known public creation/configuration evidence. Known account fields are explicitly projected into the manifest; arbitrary account properties are not copied. Changes to zero-slot identity or configuration slot evidence alter the group digest even if packet bytes are unchanged.

The existing one-packet path still refuses oversized selections and never switches execution semantics. It now explains the pinned twelve-signer boundary clearly. When a group fits one packet, its bytes and hash are identical to the existing assembler.

## Evidence and verification

- Final twelve-file targeted cohort: 151 tests passed under Node 24, including group/single messages, targets, funding, simulation, settlement, durable review, signing, execution, client model, holder panel and real holder route tests.
- Nine new group cases exercise SOL, SPL stock and Token-2022 stock; all 200 slots; exact order and coverage; decoded null signatures/header/lifetime; signer/account/instruction/serialized-byte bounds; separate mint role; exact quote spend/minimum bytes; developer-free groups; unchanged one-packet bytes; cancellation; cloned inputs; zero-slot and public configuration evidence hashing.
- Actual-source TypeScript, four-file typed lint and final production Next build pass. No UI edits or new application route.
- The first large-group test exposed the pinned SDK's twelve-signer guard. That constraint is now explicitly handled before trial compilation. An added Token-2022 test initially called its fixture helper with the wrong argument. During its correction, PowerShell template interpolation accidentally emptied the new uncommitted test file; restored all nine cases from retained patches, corrected the fixture call and ran the final complete cohort/type/lint/build. Application files were not emptied.
- Live REA discovery on the approved http://127.0.0.1:9223 endpoint, restricted to https://app.proxima.tools, returned provider_unavailable/endpoint_unreachable. No refreshed Proxima runtime claim. No browser launch/config repair or credentials/cookie access was attempted.
- Current protocol references: https://solana.com/docs/core/transactions/versioned-transactions confirms v1's 4096-byte size. The pinned @solana/kit-v1 8.5.0 nested transaction-messages src/compile/v1/message.ts enforces twelve signers and sixty-four instructions. https://docs.jito.wtf/lowlatencytxnsend/ documents at most five ordered transactions per bundle and a required tip; it does not establish this deployment's v1 transport/simulation support.

## Required continuation

The group deliberately returns signingAllowed=false, executionAllowed=false, completeLaunch=false and atomicity=not-established. Its jitoTransactionCountFit flag describes only the five-packet count constraint, not transport readiness. No tip is present; adding one changes the packet group and requires recompilation/review. Selections exceeding five packets are not represented as one atomic Jito bundle, and no sequential broadcast fallback exists.

Next build group-aware funding and sequential bank simulation. The deployer pays the sum of packet fees, with repeated signer charges, while buyer ATA/rent/quote costs stay assigned to their actual instruction payers. Curve and shared fee/migration accounts must carry state across packet boundaries. Independent simulateTransaction calls are not a sequential bundle proof. Verify unsigned bundle-simulation capability and v1 transport before any execution path. Then retain the exact whole-group review, reservations, approval/signature manifests, one-attempt group submission and complete/partial/unknown receipt recovery, and connect UI consent for the actual chosen atomicity policy. More than five transactions needs an explicitly reviewed execution design, not silent relabeling.

No provider call, funded wallet, real signing/broadcast, credential/provider setting, cron, push, deployment, SQL migration or remote SQL changed. Production remains 11ad20b; 0081 is local only. Claude's protected UI files and main's dirty Jito note/0068 migration remain untouched. Full Proxima parity remains unfinished.
