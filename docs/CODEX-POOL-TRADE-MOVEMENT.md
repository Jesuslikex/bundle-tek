# Pool trade wallet inspection

The token chart's retained Solana pool tape now offers **Inspect wallet movement**. Selecting a row reads its saved public transaction and independently checks the reported sender's mint movement. The provider's Buy/Sell label stays separate from decoded chain evidence.

## Scope and behavior

- `app/api/imported-projects/trade-movement/route.ts` accepts only project ID, revision, pool, saved observation timestamp and retained trade ID. The authenticated owner's current active project and saved tape supply the wallet and signature. Arbitrary wallet/signature requests and stale, foreign or archived context are rejected.
- A 15-second owner provider gate and 20-second server timeout bound reads. The route rechecks the project and exact tape after provider work. No movement record, wallet, signing intent or trade is created. Only the existing read gate is updated.
- `lib/pool-trade-movement-server.ts` uses the existing confirmed Solana transaction decoder and movement classifier. It checks transaction identity, mint precision, signer status, exact integer token balances, instruction/transfer evidence, provider direction agreement and block agreement.
- `lib/pool-trade-movement.ts` validates the response against the selected row on both sides of the API boundary. Missing metadata, failed transactions, zero net change and unsupported or ambiguous instructions cannot become a verified buy/sell.
- `components/pool-trade-movement.tsx` shows the chain result, provenance, classification reasoning, exact transaction explorer link and a manual refresh. Selection focuses the inspection heading. Closing or changing context aborts pending reads. Refresh does not extend the timestamp of earlier evidence.
- `components/imported-pool-trades.tsx` mounts one inspection for the selected retained row. Inspection buttons are disabled during tape reads, while the market feed runs, for archived projects and for old project revisions. Tape replacement invalidates the selection.
- `lib/pool-trade-movement-error.ts` translates only exact application-authored errors to fixed safe explanations. Unknown errors, provider URLs and credential-bearing response text are not echoed.

This is confirmed transaction-wide wallet evidence, not proof of wallet ownership, profit, finality or attribution of every transfer leg to the selected pool. It has no signing or submission controls. Direct route coverage remains the supported Jupiter, PumpSwap and Raydium AMM v4 layouts described in `CODEX-DIRECT-MOVEMENT-CLASSIFICATION.md`.

## Verification, 12 October 2026

Nine focused tests across four files passed. They cover owner/current-tape API scope, archive and mid-read drift, read gating, exact response binding, provider disagreements, failed/incomplete/non-signer evidence, precision/identity forgery, and safe error output. TypeScript, scoped lint and all five production build stages passed. The existing large client chunk warning remains.

Actual local API/browser checks used BONK's previously retained `raydium / SOL · GtKKKs3y` tape, observed at 16:56:57 local time. Five distinct public transaction samples were inspected across this work:

- Three provider-labelled buys returned successful confirmed transactions, but the reported senders had no unique nonzero BONK change. One explicitly showed zero net BONK change. They remained unknown.
- A provider-labelled sell at slot 456099157 could not be provided as usable transaction data by the configured RPC. The safe UI error now identifies the provider availability boundary. The specific provider rejection cause is not established.
- A second provider-labelled sell at slot 456098989 succeeded and showed the sender signed, with a BONK change of **-537740.40939**. Instruction evidence did not establish a supported sell, so it remained unknown. The expanded reasoning was not inspected before browser access ended.

These reads establish that the actual local API and rendered inspection path work and preserve uncertain results. They do **not** establish a positive live buy/sell classification or complete protocol coverage. Browser security policy subsequently blocked reconnection to localhost, preventing final desktop/mobile screenshot verification. No workaround was attempted. Visual acceptance remains outstanding.

Claude's holder/watch-wallet files and test-reliability changes were not edited. No credential read, signing prompt, funded transaction, submission, schema migration or deployment occurred. Full Proxima parity remains incomplete.
