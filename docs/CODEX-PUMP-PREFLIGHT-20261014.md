# Pump launch preflight and simulation

14 October 2026. Local implementation and read-only public mainnet protocol QA. No funded launch, signature, broadcast, push, hosted version, deployment or hosted SQL. No UI or protected Claude file changed; no migration added or rewritten.

## API and ownership

`POST /api/launch/pump/preflight` requires the authenticated owner, same-origin JSON and exactly the saved project ID/version, released metadata ID, selected payer/revision, new mint public key and explicit fee/rent allowance in lamports. It accepts no packet, RPC URL, owner ID, metadata override or signing flag. Bodies are streamed with a 2 KB bound. Unknown/invalid fields reject before RPC.

`lib/owned-pump-preflight.ts` joins the owner's project, metadata release, active Solana wallet and existing ownership proof. The saved deployer address/revision and root/folder membership must match. Read-only/watch-only records do not qualify. Project, wallet, proof and folder state are rechecked after simulation and before returning. The create component is independently rebuilt through `buildSavedPumpCreateComponent` against the immutable released image and public metadata; its wire hash must match the simulated packet.

The 15-second preflight rate gate is namespaced by owner and project in the existing gate table. It does not consume normal wallet/project read gates. HTTP 429 includes Retry-After. Apart from that gate, the route makes no database writes. It creates neither a signing intent nor a preparation reservation.

## RPC collector and simulated state

`lib/pump-launch-simulation.ts` uses the configured server indexer/mainnet RPC, with HTTPS validation, bounded lossless response parsing and a 25-second cancellation bound that also rejects an unresponsive provider. It verifies mainnet genesis, obtains a blockhash, reads Global/QuoteControl and the exact quote mint, builds the unsigned create packet and requests its network fee. The ordinary System payer needs its full reviewed allowance. New mint/curve/custody accounts must be unused. Executable program accounts/loaders and upgradeable program-data headers are checked. Configuration/account reads enforce monotonic minimum context slots within a 32-slot envelope.

The original packet is simulated with `sigVerify=false` and `replaceRecentBlockhash=false`. Program failure, missing post accounts, altered/replaced fee/blockhash or excessive compute reject. It validates payer authority/debit, conservation of lamports after the network fee, unchanged readonly/executable accounts, the new Token-2022 mint's supply/decimals/metadata URI/name/symbol, the pinned BondingCurve quote/creator/reserves/options, fresh curve custody supply and zero quote custody balance. Canonical custody extensions and rent exemptions are checked. Existing account/config/program-header state is reread; observed drift rejects. Final blockhash validity, remaining height margin and network are checked again.

The report retains native movements, rent/fee totals, actual metadata/mint authority observations and before/simulated account hashes. Authority review is explicitly still required. Program-data inspection covers deployment metadata, not a full deployed-code hash; same-slot code changes are not ruled out. The report's 60-second freshness expiry does not guarantee blockhash lifetime, which must be rechecked before signing. No output can enable signing: executionAllowed, signingAllowed and completeLaunch remain false, and initial buys are explicitly absent.

Official RPC references checked: https://solana.com/docs/rpc/http/simulatetransaction and https://solana.com/docs/rpc/http/getmultipleaccounts . BondingCurve extends the same pinned Pump IDL subset from 7f6b604, without changing the existing Global/create layouts.

## Fresh mainnet evidence

Public read-only RPC requests to `api.mainnet-beta.solana.com` succeeded. Raw Global/QuoteControl bytes passed the application decoder. A same-slot read of both configurations and the exact three selected quote mint accounts passed the actual quote-admission/mint-extension inspector at slot **456665566**, observed **2026-10-14 02:02:36 UTC**. Global create_v2 was enabled. QuoteControl had 208 entries in the earlier read at slot 456665306; all three selected mints were present in both captures.

| Captured label | Exact quote mint | Program | Decimals | Observed admission |
| --- | --- | --- | --- | --- |
| TSLAX | XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB | Token-2022 | 8 | QuoteControl |
| NVDAX | Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh | Token-2022 | 8 | QuoteControl |
| SPYX | XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W | Token-2022 | 8 | QuoteControl |

This advances admission/extension evidence beyond the old static catalog. It does not establish issuer identity, legal entitlement, liquidity, funding-swap support, a successful create simulation or a funded launch. On-chain labels/metadata URLs are not independent issuer authentication. The issuer product page https://assets.backed.fi/products/tesla-xstock was read, but its extracted smart-contract section did not establish the mint identity. No identity was promoted on that basis. Existing saved Pump catalog already contains the three exact mints; discovery order was not changed here.

Retained sanitized evidence: `work/release-qa/pump-mainnet-quote-admission-evidence-20261014.json`. Public raw/decoded captures and the two passing application-decoder QA scripts are in `work/release-qa/pump-protocol-mainnet-*20261014.json`, `pump-stock-admission-mainnet-*20261014.json`, `pump-live-protocol.test.ts` and `pump-live-stock-admission.test.ts`. Generated runtime captures stay ignored; this note retains their scope and observations. These public protocol reads used no credential or wallet account. They did not simulate, sign or submit a transaction.

## Verification

Final regression passed **75 tests across nine files**, including 11 collector tests and seven real-route/local-D1 tests. API tests use the real ownership/release/builder/collector code with an injected synthetic RPC. They cover auth/CSRF/body validation, watch-only/stale/deployer/folder rejection, namespace-isolated rate limiting, proof removal/project edits during simulation and sanitized provider failures. Collector tests cover native/token quotes, executable/deployment drift, exact packet flags, metadata/curve/custody mutations, fee/rent conservation, rent/compute limits, minimum slot, lifetime, cancellation and provider errors.

Actual-source TypeScript, eight-file typed lint and production build exited zero. Report: `work/release-qa/pump-preflight-20261014.json`. Source snapshot: `work/release-qa/source-pump-preflight-20261014.json`, 1,122 files, digest `a11ddb21153dca77f31c43486f1ec115ec9170cacfa1271407d551bc7900f211`. This is a targeted pass, not the full application suite. No rendered UI check applies to this backend-only change. Public mainnet read QA is separate from synthetic simulation QA.

## Remaining launch work

Browser-controlled new mint key generation and encrypted persistence; preflight review UI; durable preparation/approval and wallet/new-mint reservations; atomic developer/holder buy composition, including quote-asset funding; complete instruction/authority/fee policy; explicit dual signing/submission and receipt recovery; approved funded proof; independent issuer verification; StonkFun's separate program/platform adapter. Existing hosting/account and partial migration blockers remain unresolved. Nothing has become live through this local commit.
