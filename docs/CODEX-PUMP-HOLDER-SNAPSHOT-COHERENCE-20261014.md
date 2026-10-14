# Holder fee-recipient snapshots and review refresh

14 October 2026. Local continuation from `632bf53`. Production remains `11ad20b`; migration 0081 remains local only.

## Change

The complete holder flow now distinguishes shared buyback-recipient balances from the state and money controlled by this launch. `pump-holder-source.ts` derives the exception exclusively from the reconstructed packet's buyback accounts. For a native recipient it validates an existing empty System account and omits only its SOL balance from the identity hash. For an existing stock quote ATA it validates its mint, program, owner, initialized state, delegates, close authority and supported extension layout, and omits only its token amount. Account existence, token-account rent/SOL and every other byte remain bound. All other source accounts retain their full raw hash.

Funding checks use these identities across both observations and simulation collection. The simulation report preserves full raw pre/post hashes as well as the checked identity hashes. Durable refresh permits balance drift only at the packet-derived shared fee addresses. Our wallets still use raw hashes, including their SOL and stock balances; the entire settlement, actual fee amounts, per-wallet allowances, rents, volume gains and deployment metadata must match the original review.

A separate coherence gate pairs the complete pre-state and unsigned simulation at the same **reported confirmed context slot**. Immediately before each attempt the collector reloads all packet accounts and checks their source identities against funding. If the simulation returns a newer slot, its entire post-state is discarded and the collector tries again, at most three times. It never combines a fee delta across different slots. Own-wallet or account-identity changes stop immediately. The original 30-second deadline, 32-read budget, 32-slot total drift bound, unsigned packet and original blockhash rules remain in force. No retry signs, changes packet bytes or broadcasts.

The matched pair feeds the existing independent settlement verifier without weakening its fee, curve, custody, quote, rent or total-SOL conservation checks. Later stable reads may observe shared balance drift but must retain the validated identity. The report records the paired source slot and attempt count.

## Evidence and limits

[Solana simulateTransaction](https://solana.com/docs/rpc/http/simulatetransaction) documents unsigned simulation at the requested commitment and the minimum context slot option. The inspected [Agave v3.1.8 RPC implementation](https://github.com/anza-xyz/agave/blob/v3.1.8/rpc/src/rpc.rs) selects a bank using commitment/minimum-slot configuration and returns that bank's context slot. Matching the reported slots is our stricter collection policy. It depends on a correctly operating RPC service; it is not a cryptographic bank proof. Confirmed state can still reorganize. The separate original-blockhash refresh and explicitly approved submission remain required.

Busy/slow providers that cannot return a matching pair within three attempts fail closed with a retry-preparation message. Live-provider latency and rollover behavior have not been measured. Simulation balance metadata is not assumed available or sufficient to replace full account identity collection. A stock fee ATA appearing/disappearing or receiving changed SOL/rent still requires a new review. Older stored reviews without normalized identity hashes retain strict comparisons and may need cancellation/re-preparation.

This checkpoint originally applied to the **complete holder flow**. The subsequent developer-only collector/refresh continuation now shares this policy; see `CODEX-PUMP-DEVELOPER-SNAPSHOT-COHERENCE-20261014.md` for its tests and remaining recovery/provider limits. The holder UI, browser checks, funded proof, larger multi-packet groups, StonkFun execution and broader Proxima parity remain outstanding. No production readiness or funded success is claimed.

## Verification

The thirteen-file launch/holder regression cohort passed 174 tests on Node 24, with no failures or skips. After adding two more funding cases, the expanded funding file separately passed all 14 tests on the same application source. These are targeted checks, not the repository-wide suite.

Coverage includes external native/SPL/Token-2022 recipient credits, raw-versus-identity evidence, one successful bank rollover, three-rollover exhaustion, cancellation between attempts, recipient custody/rent/existence changes, our wallet debit/source changes and inconsistent same-slot deltas. The real local libSQL/controlled-RPC integration refreshes a saved review after a recipient credit, then reaches explicit approval, synthetic signatures, one mocked send and exact finalized receipt recovery. No real provider send or wallet operation occurred.

Actual-source TypeScript, nine-file typed lint and the Next.js production build pass. The route manifest retains `/api/launch/pump/holders`. No rendered browser checks were performed because this checkpoint changes backend collection/review only.

No migration or hosted SQL, UI/Claude-owned edit, credential/provider change, cron, push or deployment occurred. Main's two unrelated dirty files remain preserved.
