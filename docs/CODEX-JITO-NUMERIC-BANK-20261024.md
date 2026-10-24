# Exact-bank Jito request correction, 24 October 2026

Historical checkpoint, superseded by `CODEX-JITO-BANK-PROFILE-DIAGNOSIS-20261024.md`. Numeric-only encoding was based on one SDK and was not universal. Current source requires explicit bank wire selection; the actual Alchemy endpoint accepted the slot-object form in the later fixed diagnosis. Original probe outcomes below remain unchanged.

Base: `71cfd4f`. Scope: the existing unmounted sequential request builder and tests, plus this handoff. No mounted production call, signing safeguard, schema, settings or protected UI change.

## Correction

`buildJitoBundleSimulationRequest` now encodes `simulationBank` as the exact numeric slot. Previously it encoded an object containing that slot. The [official Jito SDK](https://github.com/jito-labs/jito-ts/blob/master/src/sdk/rpc/connection.ts) defines its bank selector as commitment, numeric slot or tip, and forwards that selector unchanged. The prior object-bank refusal therefore did not establish that the endpoint refused a valid exact-slot request.

This correction does not relax bank selection. Movable commitment/tip selectors, exponent/fraction strings, leading-zero strings, unsafe slots and object selectors refuse. Wire tests cover zero and the maximum safe integer. The returned observation still must equal the independently selected bank, with the same 32-slot floor/span and original blockhash/signature mode. No automatic profile or provider fallback exists. Authority and qualification remain false.

## Actual bounded unsigned observations

Two new retained probe outcomes used the existing Alchemy holder endpoint, with no setting or credential changes and no raw URL/key retained in the report. They performed **nine total read-only RPC calls**, including **one simulateBundle**. No signatures were created, zero-lamport native transfers were only simulated, and no send method was permitted.

1. The first three-read attempt stopped before simulation because its public Jito tip references were not suitable ordinary funded payer references. This is a setup refusal, not provider qualification evidence.
2. A separately recorded attempt used the existing qualifier's known public transaction reference, validated it through raw accounts, built two distinct unsigned zero-value System transfers and read each exact message fee. Both fees were **5000 lamports at slot 460658980**. A numeric `simulationBank: 460658980` request received HTTP 200 / RPC **-32602**. It produced no accepted frame vector. No automatic retry or alternate-bank/provider fallback followed.

Request/response digests, safe statuses, actual fee values and contexts are retained in the JSON handoff. These prove that this specific request profile was refused; the sanitized error record does not identify which argument the provider rejected. Do not generalize this to lack of simulateBundle support or every pinned-slot representation. The earlier tip-bank failed partial result remains separate historical evidence.

## Provider adapter requirements remain open

The [Alchemy reference](https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/simulate-bundle) and [QuickNode reference](https://www.quicknode.com/docs/solana/simulateBundle) describe account capture and compute fields, but do not document every field our stronger normalized verifier requires. The official upstream result type also does not promise frame fee, loaded-address vector or loaded-account-data size. The earlier failed Alchemy response contained those field names, but not enough retained values/provenance to qualify success.

A future adapter must preserve actual raw values and exact packet/account ordering, refuse missing fee/loaded-data/ALT evidence and validate metadata before projecting it away. Same-bank getFeeForMessage requires equal actual context slots; a minContextSlot floor alone does not pin a bank. ALT resolution still needs independent raw-table admission. A paid plan or healthy ordinary account read establishes none of this. Do not fill absent fields with zero, original quote fees or values inferred from the conservation equation being tested.

## Verification and coordination

The final local cohort passes **179 tests across two files**: all 79 frame/request cases and all 100 economic cases. Project TypeScript, scoped typed lint and formatting pass. No new Webpack build or real browser/funded execution is claimed for this two-line unmounted wire correction.

Two existing helpers audited primary documentation and integration prerequisites read-only. Their findings led to this correction and a separate bounded lossless JSON-reader follow-up; they did not edit existing Jito files or call providers. Actual Opus 5.5 source review will be recorded with the transport-reader checkpoint, not falsely attributed to this initial commit.

No deployment, hosted/application SQL, provider/credential/cron change, real wallet unlock/sign/send, strategy run or funded trade. The original AGENTS.md dirt and seven excluded warmup drafts remain untouched. No migration added; journal still ends at 0146, next unclaimed 0147 subject to recheck. This bounded claim is released after commit.
