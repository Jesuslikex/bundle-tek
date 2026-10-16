# Standard validator RPC comparison

The user requested the same fixed twelve-call Clock probe against a standard validator RPC rather than the indexer endpoint. The new explicit --validator-rpc option uses Solana's public mainnet RPC at api.mainnet-beta.solana.com. It does not modify Bundle's configured endpoints or credentials, and does not claim access to a single pinned validator backend. The default probe mode still uses the existing indexer configuration.

Both modes make six alternating confirmed/finalized rounds, request Clock twice per getMultipleAccounts call, enforce per-commitment monotonic minContextSlot anchors, and check mainnet genesis before and after. There are exactly twelve Clock calls, two initial slot anchors and two genesis calls. The public mode uses configured ordinary pacing rather than the Helius-specific qualification profile. Read-only allowlisting, twenty-request cap, forty-second deadline, stop-on-429, bounded raw response capture and no retries remain unchanged.

The new sample completed on 16 October 2026 at 16:45 UTC: twelve calls, all context/Clock slots equal, duplicate forty-byte Clock hashes equal in every call, sixteen HTTP 200, zero 429s/signatures/broadcasts. All source hashes match. Exact raw observations are in CODEX-PAIR-VALIDATOR-CLOCK-EVIDENCE-20261016.json.

| Commitment | Calls | Context/Clock mismatch calls | Duplicate Clock disagreements |
| --- | --- | --- | --- |
| Confirmed | 6 | 0 | 0 |
| Finalized | 6 | 0 | 0 |

The earlier indexer-mode probe retained one confirmed mismatch out of six confirmed calls (context 457703503 vs Clock 457703504), with zero mismatches in its six finalized calls. Those samples occurred at different times; they do not establish a permanent reliability difference or identify the server implementation cause. No production provider switch, Clock +1 acceptance, context relabelling or 32-slot change has been made. Exact equality and the existing 30000-ms time bound remain in force while the user decides the proposed rule.

This is a Clock-only diagnostic, not a new SOL/USDC trade qualification, funded test, signing approval or deployment. The approved fresh-reference tolerance is a separate change, committed as 028bb86; its review display is 799ec5b. Combined verification: 28 related files / 553 Vitest tests, twenty-one Node tests, TypeScript, scoped lint/format and source/artifact checks pass. Claude-owned layout and main's unrelated dirty files remain untouched. No push, deploy, hosted SQL, account/provider setup, credentials, cron or wallet action.
