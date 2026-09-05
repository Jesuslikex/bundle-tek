# pons V2 persistent coordinator (locked by default)

No signer, relayer, broadcast, raw signed transaction, or multi-wallet bundle endpoint exists. Receipt observation accepts only a transaction hash that matches the stored envelope exactly. The coordinator simulates and returns unsigned transaction data only. Public deployment has not been enabled or changed. `PONS_BACKEND_ENABLED=true` is a server-side Cloudflare binding required to unlock these routes; it is deliberately absent from deployment configuration.

## Exact HTTP contract

All routes require existing ChatGPT platform authentication (`getChatGPTUser`). The platform must strip client-supplied `oai-authenticated-user-*` headers and inject trusted values. These headers are not a wallet ownership proof; the backend never claims that the authenticated account controls the requested EVM wallet. Local header spoofing is for isolated tests, not public authorization.

- `POST /api/pons/jobs` — `Content-Type: application/json`, `Idempotency-Key: [A-Za-z0-9_-]{8,128}`, exact intent JSON below. Returns 201 `{job}` including id, immutable intent, state, revision, leaseUntil, timestamps, result, handoff. Same owner/key+same canonical intent returns same job; mismatched intent returns 409. Different owners have separate keys and cannot read each other's jobs.
- `GET /api/pons/jobs/:id` — returns 200 `{job, events, eventWindow:"latest-100"}`. Events newest first; each retains revision, state, timestamp and simulation result. No listing by wallet or cross-owner id lookup.
- `POST /api/pons/jobs/:id/simulate` — exact JSON `{"revision":0}` (use current revision, not hardcoded zero). Claims a 120-second durable lease through owner-scoped SQL revision CAS. Returns 200 `{job}` with state `simulated` or `simulation_failed`; the latter is a completed simulation attempt, not an HTTP transport success claim. Failures persist a sanitized error code. Crashed/expired simulations can be reclaimed using the latest revision and this same route.
- `POST /api/pons/jobs/:id/handoff` — exact JSON `{"revision":2}` (current revision required). Requires a prior successful simulation. Re-reads chain and nonce, re-simulates, and compares exact chain/from/to/value/calldata/gas/gasPrice, economics pin and launch fee with the stored simulation. Any changed terms persist `TERMS_CHANGED_RESIMULATE`, clear the current unsigned result and require explicit fresh simulation. A match adds `handoffValidatedAt`. The unsigned envelope is still not signed or submitted. GET marks expiry explicitly; archival data is not an executable guarantee.

- `POST /api/pons/jobs/:id/receipt` — exact JSON `{"revision":4,"txHash":"0x<64 hexadecimal characters>"}`. Requires prior successful stored simulation. Fetches chain, transaction and receipt; validates chain/from/to/value/input/nonce exactly against that envelope, then verifies matching receipt and canonical block. Returns 200 `{job}` after audited revision CAS. The first valid observation binds the hash; another hash is rejected. States: `submitted` (matching transaction, no receipt), `confirming` (<12 confirmations), `confirmed` (>=12 canonical confirmations, NOT finality), `reverted` (canonical status reverted), `reorged` (proved noncanonical block). Monitoring may update confirmed/reverted states if canonical evidence changes, but cannot use a stale revision to resurrect a state. Once receipt observation starts, simulation/handoff are disabled for that job. A missing receipt for an already mined transaction is NOT proof of a reorg; prior canonical block hash must actually change. Network errors are never converted into pending or confirmed outcomes. A replaced transaction with another hash/nonce requires a separately validated job, not arbitrary hash injection.

Errors are JSON `{error:CODE}`: 400 malformed/unknown fields or unsupported intent; 401 auth required; 403 cross-origin mutation; 404 owner-scoped not found; 409 idempotency/revision/lease conflict or simulation prerequisite; 408 body read deadline; 413 over 16 KiB; 415 non-JSON; 423 server lock; 422 transaction/policy mismatch; 502 inconsistent receipt observations; 503 unexpected storage/runtime failure; 504 receipt deadline. Simulation deadline is persisted as a failed attempt. All responses are no-store.

## Exact ETH intent example

This salt is a test fixture, not a recommendation to reuse it for real launches. `minTokensOut=1` is intentionally permissive for a fork proof; a real wallet must select an informed rate bound. No ETH-denominated floats are accepted.

```json
{
  "chainId": 4663,
  "mode": "single-recipient-atomic",
  "wallet": "0x4EAb299482FC2a4606626B56601718F2a346C49F",
  "recipient": "0x4EAb299482FC2a4606626B56601718F2a346C49F",
  "creatorFeeRecipient": "0x4EAb299482FC2a4606626B56601718F2a346C49F",
  "name": "Test",
  "symbol": "TEST",
  "logo": "",
  "description": "",
  "socials": {
    "twitter": "",
    "telegram": "",
    "discord": "",
    "website": "",
    "farcaster": ""
  },
  "creatorTaxBps": 0,
  "buybackEnabled": false,
  "launchConfigId": "0",
  "quoteInWei": "1000000000000",
  "maxTotalValueWei": "1000000000000000000",
  "maxGasCostWei": "100000000000000000",
  "minTokensOut": "1",
  "salt": "0x0101010101010101010101010101010101010101010101010101010101010101",
  "snipeTaxExemptions": []
}
```

Only these fields are accepted. `chainId` must be 4663, `mode` must be `single-recipient-atomic`, and the pair token is always the zero address (native ETH). All EVM addresses are format/checksum validated before use and must be nonzero. Mixed-case strings with a wrong checksum are rejected, never repaired. `quoteInWei`, `minTokensOut`, `maxTotalValueWei`, and `maxGasCostWei` are positive canonical uint256 decimal strings; maxTotalValueWei caps launchFee+quote, and maxGasCostWei caps buffered estimated gas times current gas price; `launchConfigId` is a nonnegative canonical uint256 decimal string. Name max 64, symbol 16, description 2000, logo/social strings 512 each; name/symbol nonempty. Salt is exact bytes32. Exemptions are unique nonzero addresses, max 32. This list declares opening-tax exemptions, NOT hidden holder wallets, allocations, independent signers or ownership proof. The two immutable cost ceilings are rechecked on every simulation and handoff. They bound the envelope at observation time, not a promise of future gas prices. The one entire quote allocation belongs to the one specified recipient; independently signed multi-wallet modes are unsupported and rejected.

## Implementation and fork injection

- `lib/pons/intent.ts`: `validateIntent(input)` returns deeply frozen validated intent; no intent update endpoint. Canonical property order makes reordered JSON idempotent without altering identifier spelling.
- `lib/pons/chain.ts`: `FACTORY`, `ROUTER`, `CHAIN_ID`, `routerAbi`, `buildLaunch(intent, expectedEconomics, launchFee)` -> `{from,to,value:bigint,data}`.
- `lib/pons/simulation.ts`: `simulateIntent(intent, publicClient, now?)`. Inject a localhost-fork viem public client here for independent proof. Production creates a fixed read-only official RPC client; HTTP clients cannot supply RPC URLs, contract addresses, arbitrary calldata or state overrides.
- `lib/pons/store.ts`: `PonsStore(D1Database)`, `ensure`, `create`, `get`, `claim`, `finish`, `events`. New additive `pons_jobs`/`pons_events` schema is installed only when unlocked. Unique owner/idempotency key and INSERT ON CONFLICT provide atomic deduplication. Database triggers prohibit changing intent/owner/key/id/created time and require monotonic revisions; audit inserts share the same SQL write transaction. `UPDATE ... RETURNING` determines CAS success; D1 meta.changes includes audit-trigger writes and must not be used as an exact-one-row check. Lease tokens never appear in API responses. Stale workers cannot finish after lease expiry/reclaim. Claim readback is additionally checked against that claim's own token and RETURNING revision; a delayed response rejects `CLAIM_SUPERSEDED` rather than adopting a later worker's lease.

Simulation verifies actual chain ID, snapshot block/hash/timestamp (required; no older than 60 seconds and no more than 15 seconds into the future), deployed factory/router code, router `factory()` binding, `canLaunch(wallet)` and `canLaunch(router)`, launchConfigCount/getLaunchConfig enabled, maxCreatorTaxBps, launchFee, previewLaunchEconomics, wallet balance, pending nonce and gas price. All block-bound policy/contract/balance reads share the captured block number. Calldata includes the economics pin. Value is exactly fee+quote. The fee quote and pending nonce travel in both requests. `eth_estimateGas` runs first, then `eth_call` verifies the exact envelope including the buffered gas limit, all against that same payload and block. Returned token/curve/tokensOut come from decoded call output, not invented predictions. Estimated gas receives a 20% envelope buffer; balance must cover value plus buffered gas at the read gas price. Block hash is rechecked to reject a reorg during simulation. Code hashes and economics pin are recorded, not presented as an audited-code guarantee.

Successful result includes blockNumber, blockHash, blockTimestamp, maxTotalValueWei, maxGasCostWei, expectedEconomics, launchFeeWei, factoryCodeHash/routerCodeHash, balanceWei, gasEstimate, gasPriceWei, output, unsignedTransaction `{chainId,from,to,value,data,gas,gasPrice,nonce}`, simulatedAt, expiresAt and `nonceStatus:"not reserved"`. Bigint amounts are decimal strings. Expiry is 120 seconds from simulation start. Nonce is a pending snapshot, never reserved. The envelope explicitly fixes a legacy gasPrice whose buffered worst-case cost fits the immutable ceiling. Handoff rechecks and compares the fee fields. A wallet must not increase gas or fee beyond the approved cap; it must refresh balance, pending nonce, expiry and chain before signing. Economics can still change after handoff (contract pin then reverts), and the launch fee is not itself covered by an offchain promise. No offchain result guarantees inclusion or protection against all chain changes.

The router atomically creates one launch and performs one initial buy for one recipient. Its creatorFeeRecipient must be explicitly nonzero. The router adds recipient opening-tax exemption. Extra exemptions do not create buys. The official docs specify that minTokensOut is a rate bound under clamped partial fill, not an absolute all-supply-or-none guarantee. This implementation does not claim Proxima parity, independent-multi-wallet atomicity or guaranteed full allocation.

## Transport/security boundary

Only official `https://rpc.mainnet.chain.robinhood.com` is used in HTTP runtime. Allowlisted RPC methods are read-only: chain ID, blocks, code, calls, balance, pending transaction count, gas price, gas estimate, transaction-by-hash and transaction receipt. Batches, redirects, non-allowlisted methods and response bodies above 1 MiB are rejected. Request bodies have a 5-second deadline. Simulation/handoff and receipt operations have an overall 90-second abort deadline, below the 120-second simulation lease. Each fetch has a 15-second abort and no retries. Workers use redirect `manual` and reject non-2xx, not the incompatible redirect `error`. No private key or signed payload is accepted or stored.

Receipt monitoring is read-only and does not authorize or cause a transaction to be sent. It observes only the stored envelope, including nonce, and checks actual gas limit times maximum fee (maxFeePerGas or legacy gasPrice) against the stored immutable gas ceiling. Canonical confirmation evidence is RPC evidence, not a consensus finality proof. The 12-block confirmation policy is explicit and persisted; reorgs can still occur and require continued polling. No state named "finalized" is exposed. No background scheduler is assumed: clients repeat the authenticated receipt endpoint with the current revision. Transient failures leave the last durable observation intact rather than inventing a new status.

## Sources

- https://docs.ponsfamily.com/v2 — documented LaunchConfig, TokenParams/Socials, launchAndBuy signature, pins, exemptions and partial-fill semantics.
- https://docs.ponsfamily.com/llms.txt — current V2 factory and router; public launching closed, per-wallet canLaunch required.
- Factory `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e`; router `0xe33E9E479dF8802cb0866d5d05258bEc4cF62948`; chain 4663. Live router factory getter was independently read during implementation and matched this factory.

## Verification

Tests are developed in RED/GREEN vertical slices and execute production SQL against real SQLite (D1-shaped adapter); actual local Miniflare D1 tests additionally exercise installed schema/triggers, concurrent idempotency and concurrent CAS against Workers D1. Route tests exercise auth/lock/scoping, durable failures and deadlines. These persistence tests are not an independent proof of EVM execution; that is the parent's separately run localhost-fork test. Commands: `npm test`, `npm run typecheck`, `npm run build`. Test fixture helper requires Node with node:sqlite support. No server restart, commits, pushes, publishing or mainnet writes are part of this work.

Latest implementation verification also executed the production RPC transport and simulator read-only: the supplied wallet returned `INSUFFICIENT_ETH_FOR_GAS` after current-chain policy/economics reads and gas estimation. This is a real failed safety gate, not a claimed successful launch. Independent fork execution is maintained separately by the parent.
