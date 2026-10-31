# Unsigned Raydium CPMM and Helius checkpoint

31October2026. Source base019b1e2, draft branch
codex/jito-v2-reservations-20261028. No production application caller, signing,
send, hosted SQL, provider/credential/cron change, deployment or funded action.

## Result

The complete unsigned research bundle passed once at32slots under ordinary
configured pacing, then once at25slots with the existing dedicated Helius
qualification profile. **Repeatable qualification is NOT passed.** The fixed
ordinary-pacing sample refused at36/35/33slots. The faster fixed sample passed
attempt1 at25slots, hit a provider429 on attempt2 and stopped. Attempt3 was NOT
run. No retry, provider rotation or financial override followed that429.

The25slot run checks an actual zero-signature four-transaction bundle:
bank-evidence anchor, USDC ATA creation, exact-input WSOL->USDC swap, final tip.
It checks all supplied pre/post images, every fee against independent message
quotes, exact tip debit/credit, ATA rent, actual mint policies, the full pool,
vault/config/PDA and observation-oracle source replay, source-exact minimum,
independent market comparison, both complete program scans, payer/source-token
custody, exact Clock equality and30second wall bound, actual Rent, original
blockhash validity/10block margin and original F..F+32. Total30HTTP/34methods.
No recipient balance, fee, output, slot or rent value is substituted to get a pass.

This is the separately approved **provider-trusted unsigned** profile, not
immutable bank/fork attestation, owned-wallet proof, funded execution or a
production signing admission. ProviderQualified, fullSwapQualified,
bankIdentityVerified, feeBankIdentityVerified, signingAllowed and executionAllowed
remain false. completeSwapEvidenceChecked distinguishes a successful bounded
financial/runtime replay from those stronger claims.

## Current binary independently reproduced

The old research gate correctly refused the deployment at463522946, full hash
c383e1c5b1f578f3d1bf42f12360fca67225b9adda0f3b6c293ad0d6b966818d.
System, classic Token and ATA still matched their references. The public
verification service reported the new normalized hash as unverified.

Built official Raydium branch feat/initialize-v2, exact revision
40cbd81ee1014eee27c123d8846558c402f6c5fb, in the same digest-pinned controlled
image used for the earlier match. Clean source, locked dependencies; successful
complete command exit0. Built749848bytes, full hash
2d9e1c76fd3f760542b19067f3eafaef5febb66bcbfe86bb09f5c7c7b16591de.
Padding to the on-chain793824bytes is **byte-for-byte equal**, not merely a
similar size or reported program ID. Normalized hash
7e691824f591590ed44f5716ffc5e1040914e3aaa9ee4effdc47f50951a4f83e.
See CODEX-RAYDIUM-INITIALIZE-V2-MATCH-20261031.json.

The branch changes initialization, client/test code and entrypoints. Git comparison
shows no changes to swap input/output, curve or state files against the previously
matched f4b9b263 revision. The verifier's old source-profile tag for those unchanged
arithmetic rules is retained. New explicit v2 runtime/source references pin every
original identity field to the newly reproduced artifact; historical research and
shared signing policies still reject it. Build matching is not a security audit.
An enable-log build of master was tested first and did NOT match; it was not pinned.
The first initialize_v2 build produced matching output but failed ancillary
Criterion download; a repeat completed exit0 and reproduced the same hash.

## Integration corrections

- Added a simulation-only zero-value System anchor whose static keys include
  readonly Clock and Rent. These are real returned bank images, never a live
  RPC snapshot relabeled with the simulation slot. Exact canonical packet,
  zero signatures, zero tip effect, payer fee debit, readonly equality, Clock
  and Rent all checked. Prefix fee and maximum budget included in total costs.
- Kept original null-only ATA replay unchanged. A separate research entry handles
  the exact zero-lamport, empty, nonexecutable System image returned for an absent
  account. It refuses funded, occupied, wrong-owner or executable images. The
  runner independently requires RPC absence, derived ATA identity and exact
  creation debit/Rent/content. No economic tolerance was added.
- Retained original no-lookup packet representation while binding actual fee
  quotes. The fee reader's canonical empty lookup arrays and setup replay's
  required null representation describe the same explicitly lookup-free packet.
- Removed the duplicate layout-only lifetime fetch. The layout-only1unit arithmetic
  minimum is never simulated; actual encoded minimum equals the complete fresh
  source quote. Parallel independent opening reads, quote/lifetime issue and
  post-scan custody/lifetime reads, with all results required and final floor
  equal to the later observation. Code scans remain serial, full and mandatory.
- Opt-in existing bounded zstd codec for code reads only, same byte/slice/account
  bounds and decoded hashes, no fallback. Group signing defaults stay unchanged.

## Pacing, source receipts and limitations

Default native mode and default CPMM mode retain configured wallet pacing.
The faster Helius profile now needs an explicit extra CLI flag:

```powershell
node --env-file=C:/Users/Julian/Desktop/Bundle/.env.local scripts/qualify-jito-provider-observed.mjs --live-readonly --raydium-cpmm --helius-qualification-pacing
```

Do not treat the flag as provider capacity qualification. It opts into the
existing nine-method research queue and adds an actual wire rolling cap: a
five-member batch counts five together, not five earlier timer reservations.
No global setting or pacing guard changed. The faster profile encountered429
despite the retained successful run's observed wire count staying within9/second;
account capacity or concurrent external traffic was not proven. No retry followed.
After the campaign, only recorder/explicit-flag and test/document refinements
were made; no provider request was made after the rate-limit stop.

The final recorder now retains HTTP429 request hash/timestamps/status, cancels
its own outstanding reads and refuses subsequent requests. Its new subprocess
test uses mocked fetch only. The earlier real429 receipt has3bodies for4requests;
its missing final response is explicitly NOT represented as captured evidence.

All17real diagnostic outcomes are retained in the companion public JSON, including
the initial zero-transfer builder failure, two old-identity refusals, two exact
Clock refusals, the lookup/null and missing-image integration refusals, lifetime
and33slot refusals, a real5000lamport payer custody change, the36/35/33sample,
and both successes. No outcomes were discarded to manufacture repeatability.
All available raw request/reply hashes and zero signatures were independently
checked. Raw bodies stay in ignored work files; public notes contain no endpoints,
keys, signed packets or wallet secrets. Frozen source hashes retained per campaign.

## Verification / next work

420tests/18files pass, plus2CLI subprocess tests in a separate final run:
422distinct tests/19files. Includes exact bank evidence and mutated images,
cross-profile source isolation, missing-image rejection, source/fee/pool/Rent/
price/lifetime regression tests, unchanged ordinary pacing tests, guarded actual
batch counts and cancellation. Whole-project TypeScript,14file typedlint,
format/diff checks pass. No full application/build/browser claim.

Next work is reliable provider capacity and more latency margin, then another
fixed sample with every outcome retained. Clock/custody refusals remain genuine
failures, not reasons to weaken checks. No conclusion about marketplace, live
funded Jito, signing admission or production readiness follows from this checkpoint.
