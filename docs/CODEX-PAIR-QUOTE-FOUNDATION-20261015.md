# Pair-currency quote foundation and real stock compatibility gap

15 October 2026. Full Proxima reconstruction remains incomplete. This is a quote-only backend checkpoint, not stock trading, launch execution or a publication.

## What changed

`POST /api/imported-projects/pair-quotes` authenticates the owner and binds the current imported project revision/document, exact base/quote mint addresses, chain, mint programs, decimals, symbols, side and atomic input amount. Buy spends quote units; Sell spends base units. Amount parsing uses integer arithmetic with positive/u64 limits. Both mint identities/policies and mainnet identity are read and rechecked around a quote-only Jupiter request, followed by an exact project reread. Responses carry short observation lifetimes and strict context decoding. SHA256 fingerprints detect context mismatch; they do not establish issuer identity or transaction authority.

The endpoint has bounded UTF-8 JSON input, a body deadline, cancellation, an overall provider deadline and the existing per-owner 15-second imported-read gate. That gate intentionally covers identity RPC reads too: an incompatible mint consumes it, preventing repeated unsupported-policy requests from becoming unthrottled RPC calls. Unsupported/invalid decoded mint policy is reported separately from unavailable/malformed RPC account metadata or transport. Provider text is not exposed. No wallet address/taker is sent to Jupiter and unsolicited transaction material is discarded.

Every response fixes `signingAllowed`, `executionAllowed` and `balancesChecked` to false. There is no wallet balance check, preparation, approval, signature, transaction submission, receipt or trade-history write. Only the existing read gate is written. Native quote/preparation wrappers retain their WSOL default; the new quote-only helper requires an explicit quote mint. No new migration or UI is included.

## Fresh Proxima evidence

REA reattached to the already approved dedicated Chrome through the existing loopback/stdio relay. Normal browser automation navigated the existing authenticated Proxima tab and opened observed controls; REA passively inspected their rendered aftermath. No account/session copying, token creation, stock selection, signing or submission occurred.

At `https://app.proxima.tools/launch/create/launchpad`, the StonkFun launch currency picker offered Custom SOL, an xStock tab, and the search result `TSLAX Tesla TSLAX`. The final filtered inspection ran 2026-10-15T15:27:49.838Z to 15:27:51.164Z. Evidence id: `ev_d24b08810128a77f66c1db9ccc3f84859380af8bf6d1cfa82cbfffd63f1e7bc8`. This proves picker presentation, not a working route, transaction construction, issuer trust or Proxima backend behavior. Prior network activity was not captured.

The complete private seven-record REA export stays outside Bundle at `C:\Users\Julian\Desktop\REA\results\proxima-stock-quote-20261015-evidence.json`, SHA256 `634BB31CAEFEB271732BAC26DD9023625D35F26828EA7C672F2C58DF578516AF`, 1,560,476 bytes. Private account names/statistics and full accessibility records are not copied into this repository. The public catalog remains a historical 9 October capture, explicitly `issuerVerified:false`.

## Real stock-token check changes the readiness assessment

A separate, read-only public Solana mainnet RPC observation of catalog TSLAX mint `XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB` returned Token-2022, eight decimals, 678 bytes at slot 457295355. Its extension profile includes MetadataPointer, PermanentDelegate, DefaultAccountState, ScaledUiAmountConfig, PausableConfig, ConfidentialTransferMint, TransferHook and TokenMetadata. The public token account bytes and observation provenance are retained in `test/tslax-mainnet-mint-20261015.json`. This RPC evidence is distinct from REA and does not prove issuer authenticity or execution readiness.

Solana's [xStocks case study](https://solana.com/id/news/case-study-xstocks) describes stock-specific token extensions. Its [Scaled UI Amount documentation](https://solana.com/docs/tokens/extensions/scaled-ui-amount) explains that issuer-updatable multipliers affect displayed amounts without changing raw balances and may change at a scheduled timestamp. Raw units divided only by mint decimals cannot be assumed to represent displayed shares.

The existing metadata-only swap policy deliberately rejects this actual TSLAX profile. Extension presence alone does not show that every optional authority/hook or compliance feature is currently active. New initial/recheck tests use the public snapshot and prove rejection without emitting a usable quote or granting authority. Synthetic bare-mint fixtures at the catalog address test only currency direction/precision math. They are not evidence that real TSLAX quoting or trading works. The endpoint can handle compatible unscaled mint pairs, subject to provider route availability, but real xStock support remains unfinished.

## Remaining work

Implement and verify quote-specific scaled-amount conversion, effective timestamps and stock policy evidence before exposing real stock quotes. Then add currency-aware preparation, balances/fees, reviewed settlement, explicit user signing/submission, durable recovery and receipt/accounting. Existing SOL receipt/FIFO reporting must not interpret stock units as lamports or include them silently in SOL performance.

The token quote form/layout belongs to Claude; this checkpoint changes none of those files. UI wiring needs a concrete reviewed ownership handoff. Full market/holder coverage, economic reconciliation, rendered qualification and funded launch/trade/Jito proof remain separate open work. The approved launch-to-chart wiring is already committed as `7d4536a` and must not be reapplied.

## Verification

Claude's authenticated, tool-free CLI reviewed the implementation and subsequent corrections; Codex runs the tests. Review prompted explicit stale/unsupported-policy classification and separation of missing/malformed RPC account envelopes from decoded policy failures. Its final follow-up confirmed no new concrete bug, while suggesting two checks: unsupported token-program owners intentionally remain generic unavailable identity responses, and the program-substitution fixture is a bare 82-byte mint so it reaches the tested program mismatch. No signing whitelist or policy acceptance was broadened.

Final Node 24 validation passed all 17 selected files together: 442 tests, zero failures. Actual-source TypeScript, scoped type-aware lint, staged whitespace checks and the production webpack build passed. All ten changed implementation/test/fixture files match the final regression freeze. Main's two unrelated dirty files retain their original hashes. Logs are retained locally under ignored `work/pair-quote-regression.log`, `work/pair-quote-{types,lint,build}.log`, `work/pair-quote-source-freeze.json` and `work/claude-pair-*.json`.

The cohort covers exact Buy/Sell currency units and limits, strict client context decoding and substitution, owned/stale/archived projects, real SQL read gates, project/policy/network races, late expiry, cancellation and bounded API input. Existing native quote, warmup signing/recovery, imported signing/receipts, Token-2022 evidence, route and Counter settlement regressions also pass. This is a targeted cohort, not a full-application-suite pass. Quote API tests use actual Request/Response and local SQL with controlled auth/provider dependencies. No rendered application, real Jupiter pair availability or funded trading verification is claimed.

No push/deployment, hosted SQL/migration, provider/credential/cron change, real-wallet unlock, signature or submission occurred. The only live calls were approved passive Proxima inspection/navigation and public read-only mainnet identity observation.
