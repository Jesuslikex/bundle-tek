# Launch layer terms foundation

18 October 2026. Codex-owned pure model and tests only. Reference contract and limitations: CODEX-PROXIMA-MEV-FUNDING-FIELD-MAP-20261018.md. Full Front/Back funding, execution, recovery and Proxima parity remain unfinished.

## Implemented

lib/launch-layer-terms.ts captures an explicit buyback-protocol planning envelope. It separates one funder, optional new-launch developer, Front buyers, optional Back buyers, optional temporary transfer wallets and final holders. Intermediaries do not increase the saved holder count. Arrays preserve review order; addresses are canonical and unique across all roles, and cannot be the launch or quote mint.

It binds the normalized saved launch JSON and exact saved timestamp, declared owner, new/imported target mint, exact catalog quote identity/units, wallet revisions, explicit root/folder references, integer time units and per-wallet ceilings. Revalidation rebuilds from current supplied context and rejects changed fields or digest. Context changes during asynchronous hashing also refuse. The returned objects are detached from mutable input.

Native SOL purchase ceilings are included in the native budget. Token-quote purchases remain in quote atoms, separate from SOL network fees, account rent and retained reserves. Arithmetic uses bigint with canonical unsigned64-bit input bounds and per-wallet/aggregate overflow refusal. These are declared maximum budgets, not simulated required funding, current shortfalls, realized costs, live mint attestations or independently funded capital requirements. Cycled capital is not proven by summing the ceilings.

The current planning scope is Solana PumpFun/StonkFun sequenced plans. StonkFun permits at most12Front wallets and no Back/temporary layer. Imported targets require a scheduled saved plan and cannot claim a developer role. The explicit buyback variant does not accept an airdrop protocol; temporary stages require a Back layer. Funding delay is whole seconds (local bound86400); Front→Back and Back→Temporary delays are whole milliseconds (bound10000). Each role array has a local storage/resource bound200; that is not a claim of vendor limits or executable packet capacity. Existing saved launch timing remains part of the bound plan JSON.

All fundingAllowed, signingAllowed and executionAllowed flags are literal false and are revalidated. No program, transaction or signer is admitted by the terms, and no UI invites users to fund unsupported stages.

## Trust boundary and remaining integration

The model receives context from its caller. It does not authenticate users, read owned storage, verify wallet key possession, observe accounts, validate stock scaling or reserve balances. A future authenticated service must load the correct owner's current saved plan and roster; a caller-supplied workspace is not ownership proof. The SHA256 is an unkeyed content fingerprint, not a signature, authorization token or database immutability mechanism.

No existing LaunchPlanInput field, serializer, API, migration, frontend, funding executor or stock gate was changed. A bounded import search confirms that only this new test file currently imports the model. This prevents older funding and launch handlers from silently executing a layered plan through ordinary deployer/holder behavior. Owned durable storage, API/UI review, instruction/code admission, independent budget derivation from simulation, staged funding/buyback/transfer execution and finalized recovery are still required. Preserve separate unchecked approvals and the existing stock qualification gate throughout that work.

## Verification

- Pinned Node24 Vitest:71 passing tests in eight distinct files: new layer terms, launch wallet references, funding handoff, launch plan, timing, methods, buys and quote catalog. New cases include native/token separation above Number's exact range, route limits, imported/new distinctions, current wallet/folder references, mutation during hashing, role ordering, tampered totals/quote units/protocol/digest/authority, malformed atomic amounts, oversized public addresses and overflow.
- Plain tsc --noEmit passed. Final two-file typed lint and formatting passed. Diff checks passed before the narrow commit.
- No browser, API/database persistence, production build, live provider or funded qualification is claimed for this standalone model. No UI changed and it has no application caller, so no shared build/server restart was needed.

No secrets, generated runtime artifacts or vendor code were added to Git. Other Bundle-chat Volume/warmup work was excluded. No push, deployment, hosted SQL, provider/credential/cron change, wallet unlock, signing or transaction.
