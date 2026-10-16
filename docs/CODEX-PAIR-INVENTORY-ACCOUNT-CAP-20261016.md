# Runtime inventory account cap and provenance

`collectPairRuntimePreview` accepts a server-only optional inventoryAccountLimit of5 or100(default). Only initial/final sliced runtime inventories use it. Each chunk still uses the existing bounded reader, supplies its actual requested floor and contributes its actual response slot to the32-slot span. Following chunks use the latest floor. Every account is retained in original compiled/lookup order.

Writable-state diagnostics now derive the response slot, position and response count from the selected chunk size. Packet provenance still uses the original compiled account index, transaction hash and lookup mapping. No custody acceptance predicate changed. The inventories retain their existing multiple-observation semantics; they do not claim that different chunk slots are one bank snapshot.

## Verification

Seven files/88 tests pass together on Node24.19.0: pair-runtime-inventory-cap, imported-pair-runtime, pair-runtime-ordering, pair-runtime-exposure, pump-group-code-account-cap, pump-group-code-identity and pair-mixed-code-packing. Plain TypeScript, two-file typed lint, formatting and diff checks pass.

New tests run the real owned preparation and runtime collector with synthetic provider responses. Both capped inventories complete alongside the existing economic simulation, trace and two full code collections. Advancing slots remain individually recorded with subsequent floors. Partial, stale and33-slot chunks refuse. A blocked writable account at compiled index5 in the second chunk reports that actual advancing context, response position0 and count5, plus the original packet provenance. This catches the old100-based diagnostic arithmetic.

Existing runtime ordering tests still verify that simulation waits for initial identities, final identities complete before publication, and the last custody/Rent/lifetime checks run after code IO. No live RPC, build, browser, full-suite or new SOL/USDC qualification result is claimed.

## Integration still required

No production/API/script caller selects the new inventory setting. It is not a whole-pipeline account cap. Code collection has its separate explicit cap from1872bc3; protected full-state reads, lookup sets, candidate state and wallet observations need their own appropriate handling. Wallet snapshots must retain identical-context/Clock admission, rather than using the inventory's multiple-observation model. The transport cap must also be selected so coalescing cannot exceed five actual accounts.

Keep every observation in qualification evidence and preserve all floors, byte/pacing limits,32-slot ceiling, strict initial minimum and final code recheck when integrating these paths. Stock signing remains off. No UI ownership file, provider setting, credential, database, cron, deployment or wallet action changed. Preserve the two unrelated desktop edits.
