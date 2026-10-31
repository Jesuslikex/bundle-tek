# Helius unsigned native repeatability

31October2026. User authorized diagnosis/fixes, unsigned reads, commit/push;
no deploy/funded trades. Base ef99880. No provider settings or credentials changed.

## Actual diagnosis

Both retained custody refusals came from external shared Jito receiver activity:
tip2720991->724399 with payer8431160unchanged; tip746414->778683 with
payer8421160unchanged. Owners/data/Rent were stable; actual Clock matched its
context. The payer changed BETWEEN runs, so it is a public reference with no
ownership/quietness claim. Every individual run continues to require exact
payer custody across its own bracket.

The native diagnostic incorrectly treated the shared external tip destination
as controlled wallet custody. Requiring the receiver's real-world balance to
remain static is not needed to prove the exact simulated tip debit and credit.
Corrected only the native runner role model; group signing, controlled-wallet
custody predicates and strict production paths were not changed.

New inspectJitoNativeTipCustody checks exact payer and Rent snapshots, uses
the existing reviewed tip allowlist/PDA/owner/discriminator/layout decoder and
actual rent minimum at BOTH observations, and requires all receiver metadata
except lamports unchanged. External balance delta is explicitly retained.
The native runner independently requires each simulated receiver credit equals
1000/1001lamports and payer debit equals that exact tip plus its verified fee.
Raw frame continuity/conservation/executable/readonly checks still run unchanged.
Lifetime reads now floor at the final custody observation. No balance override,
fee tolerance, skipped Clock or silent failed-guard continuation was introduced.

The third original refusal had fee contexts463478243/463478244. The approved
provider-observed design admits separately fresh contexts, but implementation
still inherited common-slot admission across fee observations. New separate
readJitoProviderObservedFees retains EACH exact message hash/amount/context,
same cap/floor/32span/ID/cardinality/strict parser checks, and explicitly returns
feeBankCoherent false with NO simulationBankSlot assertion. Strict fee reader
still refuses differing slots and preserves its original output contract.
The provider-observed collector still demands exact simulated/quoted fee equality.

## Every new outcome

1793415973402: exploratory alternative fixed public tip reference. Fresh mixed
fee slots463531027/463531026 passed the new profile and both scans; old native
custody predicate still refused. Original reference restored; no improvement
or quietness inferred from swapping receivers.

Final fixed three attempts on restored original payer/receiver, same guards:

| Receipt timestamp | Original F | Simulation | Fee contexts | Final slot | Span | Result |
| --- | --- | --- | --- | --- | --- | --- |
|1793416020066|463531233|463531241|463531241,463531241|463531252|19|pass|
|1793416047424|463531355|463531366|463531365,463531366|463531375|20|pass|
|1793416063343|463531431|463531442|463531442,463531442|463531451|20|pass|

3/3native passes; each21HTTP/23methods. No429/retry/fallback,original32slot
bound unchanged. Both full System scans match; actual Clock equality,30second
wall bound, payer custody, actual Rent and receiver rent checks, exact fee/tip
accounting, blockhash validity and10block margin all pass. External receiver
balance deltas were-32993,-11331,-10123lamports, explicitly observed rather
than substituted into simulation. No funded transaction or signature created.

Original raw captures remain in ignored work/jito-provider-observed-*.json.
Companion public JSON contains summaries and hashes only. All request/reply
hashes and zero-signature packet bytes were independently checked for the four
new receipts. Provider/bank/signing/execution/fullSwapQualified flags stay false.

## Verification and limits

127tests pass/one retained-replay case skipped across8files, on Node24.22.1.
Plain whole-project TypeScript and7file typedlint pass; scoped format/diff checks
pass. Added tests keep strict mismatch refusal, per-message observed contexts,
no shared-bank claim, receiver credits/sweeps, payer/Rent/identity/layout/rent
failures. Typecheck caught the newly separate fee union in the generic runtime;
explicit union added, no cast of observed fees into strict proof.

This proves a bounded native sample under explicit provider trust. It is NOT
swap-route, pool/mint economics, real-wallet ownership, production signability
or general reliability proof. Full positive swap composition/live verification
and owned signing/recovery remain subsequent work. No application route or
signing gate enabled. Strict same-bank profile preserved. Other-agent recovery
drafts untouched. No deployment, hosted SQL, provider purchase or funded action.
