# Pair runtime concurrency review

## Initial observation barrier

Static candidate/mint/Rent/fee checks now begin alongside the runtime's initial account inventory. That inventory still identifies the actual executable programs and intermediate custody scope. Once it resolves, the full first code observation and protected account/Rent reads run together. An internal, optional collector barrier joins all initial evidence after instruction assessment and immediately before original-packet simulation. Ordinary candidate callers retain their existing path.

The runtime owns a child abort scope so a failed parallel branch prevents later simulation/publication and stops further scoped reads. Every context-bearing ordinary read is checked against its actual captured request floor, including floors raised by the runtime wrapper. Code observations validate their own captured starting floor rather than the mutable high-water mark of an unrelated concurrent response. All returned evidence still contributes to the unchanged global 32-slot bound; out-of-order completion does not permit a response below its own request floor.

Three deterministic latch tests hold either initial code or protected accounts while proving static fee reads proceed, prohibit simulation until released, and reject a first code observation with HTTP 429 after fee checks without simulating. Existing runtime, byte bounds, account/auxiliary/Rent, candidate and both API route selections pass together: **9 files / 263 tests** (10.81s). Standalone TypeScript and typed lint on the three changed TypeScript files pass. These are offline ordering proofs, not live latency qualification. No group production code or UI changes; stock signing remains off and no deploy.
