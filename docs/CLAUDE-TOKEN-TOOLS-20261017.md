# Token tools: Send, Burn, Lock (17 Oct 2026)

Proxima's Live Workspace token tools (docs.proxima.tools/live-settings/send-tokens, burn-supply, lock-supply-via-streamflow), rebuilt under Bundle's rule that keys stay in the browser and the user approves each transaction.

## What was built

- **Send** (`lib/token-send-plan.ts`, `POST /api/wallet-workspace/token-send`, `components/token-tools-panel.tsx`)
  - Amounts are a % of total supply with up to 4 decimals. Simple mode takes one recipient. Advanced mode takes Bulk Add lines in the form `recipient,%` or `sender,recipient,%`, separated by commas, colons or tabs.
  - The server reads the mint supply and every selected wallet's associated token account in one finalized `getMultipleAccounts` call. It only accepts wallets from the user's own roster, and no more than 25 of them.
  - The planner gives rows that name a sender to that sender first. Every other row is split across the largest remaining balances. Legs with the same sender and recipient are merged. If the selected wallets can't cover the send, it refuses with an error and never sends part of it. Recipients can't also be selected sources.
  - Each leg opens the existing mainnet withdrawal panel, prefilled. The user then prepares, simulates, signs and submits that leg separately, exactly like a manual withdrawal. Planning sends nothing.
- **Burn** (`lib/token-supply-action*.ts`, `/api/wallet-workspace/supply-actions`)
  - BurnChecked on the wallet's associated token account. Standard SPL and Token-2022 mints that carry only the existing withdrawal extension allowlist are supported.
  - The server reads supply and balance, computes the share from the observed supply, and simulates the exact unsigned packet. It requires the token debit and the supply drop to both equal the amount. It records the simulated SOL cost.
  - Just before sending, a recheck requires: the same supply, a token debit and SOL cost no higher than approved, SOL that still covers the cost plus the rent reserve, and a valid blockhash.
- **Lock (Streamflow)**
  - A Token Lock built with `buildLockParams` semantics. The full amount unlocks at the end, back to the same wallet. Nothing is cancelable, transferable, pausable or top-up-able. Duration can be 1 hour to 10 years.
  - It uses the SDK's default `create` instruction. The Streamflow metadata account is a throwaway keypair that the browser generates at Prepare time and keeps in tab memory. It is the second signer and is wiped on unmount.
  - The lock instruction is hand-encoded. `lib/token-supply-action.test.ts` pins it byte-for-byte, accounts and data, against `@streamflow/stream@13.4.0` `createStreamInstruction` output. The SDK is not a dependency because it pulls in web3.js v1 and Anchor.
  - Streamflow's token fee shows up as a token debit above the amount, and its SOL fee as SOL cost. Both are taken from the simulation and shown before signing.
  - Transfer-fee Token-2022 mints are refused for locks.
  - Not used: the SDK's `create_v2` nonce path. In 13.4.0 that path encodes the nonce as 0 in the instruction data even while it derives the PDA from the real nonce.

## Lifecycle and storage

- Migration `0094_token_supply_actions` adds a new table, `token_supply_actions`, with its own events table. The lifecycle matches `native_withdrawals`: `awaiting_signature → signing → signed → submitted → finalized|failed`, or `cancelled` before a signature exists.
  - Documents and signatures are immutable and history can't be deleted.
  - Signatures go into `solana_execution_signatures` with scope `supply`.
  - Wallet exclusion runs both ways:
    - A burn or lock can't start while the wallet holds any `solana_execution_reservations` row (withdrawals, swaps, warmups) or is an active Pump launch payer.
    - While a burn or lock is open, new withdrawal, swap and warmup reservations, and Pump launch reviews for that payer, are refused by triggers.
  - The journal entry is idx 92 on this branch. After PR #2 (0092) and PR #3 (0093) merge, it must be renumbered to idx 94 in the journal. The SQL filename already uses 0094.
- Every Prepare needs the "cannot be undone" acknowledgement. Signing needs a separate approval checkbox plus the vault password. Submission needs another approval checkbox and is sent once with `maxRetries: 0`. Recovery reads the finalized transaction and checks the token change, SOL change and fee against the approval.

## Not done

- **LP**: Proxima's LP tool covers Uniswap on Arc, Ethereum and Robinhood only. Pump.fun graduation burns the LP, so a Bundle Solana launch has no LP position to manage.
- **Creator fee claims**: being built in a separate thread.
- **Not verified on mainnet**: this container can't reach Solana RPC. Clicking Prepare in a local or preview build runs the real mainnet simulation without signing, so it's a safe first live check. No funded transaction was sent.
- **Proxima differences**:
  - Burn and lock work from any owned wallet, not only the dev wallet.
  - Locks unlock to the same wallet.
  - Sends are one transaction per leg, not batched.
