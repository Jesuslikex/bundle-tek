# Provider-observed runtime integration and live Helius sample

30October2026, based on4efe581. User approved runtime integration, unsigned live
verification, commit and push; no deploy/funded activity. No credentials/settings
changed. Existing Helius mainnet URL selected through explicit research-only
dependency, exact HTTPS host restriction, existing pacer and bounded transport.
Default holder endpoint path remains unchanged, no fallback/provider rotation.

New collectJitoProviderObservedQualification composes the new collector with
the original raw-baseline replay, ownership/manifest checks, pre/post asset and
runtime brackets, lookup reads, full code scans and economic replay. Includes
actual fee context slots in original F..F+32 accounting and later floors.
No app/API/signing caller selects it. Authority and bank identity flags false.
This integration has baseline-refusal tests, not a new complete positive swap
composition test. Do not claim a fully verified swap from this checkpoint.

New standalone native runner checks existing Helius genesis, fixed public payer
and Jito tip receiver, exact raw two-packet native simulation with independent
fees, native conservation, both full System program scans and runtime replay.
Final guarded revision also reads actual custody/Clock/Rent before/after,
requires exact Clock/context equality and30second drift, admitted actual Rent
and rent coverage, unchanged custody/Rent, blockhash validity and10block margin.
All reads/slots retained, original32slot window,48HTTP/64method and45second
limits,4MiBresponse limit, stop429, no signing/send or retries within an attempt.
This is native research, not pool/mint/swap qualification or wallet ownership.

All attempts retained:

-1793404536601: startup/integration bug in lifetime helper argument ordering;
 first scan completed, refused lifetime-before after7reads. Corrected argument
 call. The CPMM packet-specific final helper cannot admit native packets, so
 native runner explicitly checks actual blockhash validity, height and margin.
-1793404567770: earlier native bracket completed19slots,19HTTP/21methods.
 Fee slots463477837 vs simulation463477838, both scans matched; no custody
 bracket yet, so this is partial evidence, not final qualification.
-Final fixed three-attempt sample after adding custody/Clock/Rent checks:
 1.1793404609896: captured simulation463478037, both fee contexts same;
   both code scans/replay passed. Refused custody-after. Exact Clock slots
   matched463478027/463478043. Payer8431160 unchanged; public tip receiver
   changed2720991 to724399lamports. Real external activity, not a guard bug.
 2.1793404645025: captured simulation463478203, fees463478204; both code
   scans/replay passed. Refused custody-after. Original receipt retained for
   diagnosis; do not infer exact cause from stage alone.
 3.1793404653833: refused independent fees at different slots463478243 and
   463478244. Existing fee-vector coherence check remains, no retry/fallback.

Final sample0/3passes,3refusals,0rate limits. All native/fullswap/signing/authority
distinctions explicit. Raw captures stay ignored under work; public JSON has
summaries/digests only, no endpoint or credential. Nothing was signed/broadcast.

Verification:76tests/fivefiles pass (runtime, transport, original prefee, new
collector, baseline guards). Plain TypeScript, fivefile typedlint, formatting
and diff checks pass. Native runner syntax/live invocation verified; no new
closed-transport test suite for the standalone runner and no fullrepo/build/UI
test claimed. Three unrelated recovery-password drafts remain untouched.

Remaining: finish custody/fee-context diagnosis and fixed repeatability without
numerical guard changes, then positive full swap composition and live source/
mint/pool/rent/price/runtime qualification. Current sample is not release-ready.
