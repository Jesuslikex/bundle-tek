# Owned atomic Pump initial-buy preflight

The existing authenticated `POST /api/launch/pump/preflight` now accepts an optional positive u64 `maximumQuoteCostRaw`. Without it the existing create-only response is retained; with it the server independently simulates creation and the atomic developer buy. The request cannot override the saved developer percentage or specify a token output amount.

The server selects the exact owned active saved project, released image/metadata, verified deployer revision and selected active wallet folder. It derives developer token output from the saved percentage and independently observed Pump supply using exact integer arithmetic. The quote cap is separate from the SOL fee/rent allowance. The final saved-project builder must reproduce the simulated packet hash; project, proof and folder state are checked again around collection and construction. Terms are cloned before asynchronous reads.

The initial-buy collector now supports a saved-percentage intent alongside its existing explicit base-unit internal intent. Mixing those target modes is rejected. Both modes still use exactly two unsigned simulations within the existing deadline/read budget and original blockhash lifetime. Native, SPL quote and Token-2022 quote custody and pricing checks are retained.

Same-origin authentication, strict bounded JSON, sanitized errors, no-store responses and the per-owner/project rate gate apply to both preflight modes. Creating a preflight does not create an approval or sign anything. Scheduling and zero developer targets are rejected for the atomic path. Requested holder buys remain visible but are explicitly not contained in this packet; `completeLaunch`, `signingAllowed` and `executionAllowed` remain false. Buyback split rounding remains explicitly unattested.

## Verification

Seven focused files passed, 59 tests, with Node 24. This covers the real route and local D1 reads with independently laid-out controlled RPC account fixtures for SOL, SPL stock and Token-2022 stock, exact saved output targets, immutable release identity, quote cap validation, foreign/watch-only payers, ownership and developer-target changes during simulation, scheduling, shared rate limiting and sanitized atomic failure. Existing create-only preparation, signing and review regressions also pass. No controlled fixture is proof of actual funded execution or issuer identity.

Actual-source TypeScript, scoped lint and Next.js production build passed. No UI, signing-service, migration or provider configuration was changed. The test fixture gained an explicit URI setter so released metadata identity reaches the closure that generates simulated mint metadata, instead of changing only a copied output object.

## Still required

The atomic preflight is now reachable through the owned API, but has no UI control or durable signing review integration. Version-1 exact packet verification, reservations, explicit dual signing and independently approved submission/receipt recovery must be integrated before enabling initial buys. Holder-wallet buys, timing, StonkFun execution and funded human proof remain outstanding. The create-only signing service still rejects initial-buy requests. Production remains deployment `dpl_FYnVoBwpWTLC6QHejGZBV6ghVTFP`, source `11ad20b`; this checkpoint is local only and was not deployed. No remote SQL, cron enablement, wallet signing or broadcast occurred.
