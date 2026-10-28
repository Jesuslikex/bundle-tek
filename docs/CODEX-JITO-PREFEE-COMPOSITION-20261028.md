# Diagnostic Jito prefee composition

The full read-only Jito controller now exposes a separately named, explicitly labeled prefee experiment. The existing public entry point always selects its original legacy profile, even if a caller supplies an extra profile-like dependency. No application route, UI or environment flag selects the experiment.

The experiment uses the existing bounded transport and reconnects to the same post-simulation account, lookup, two full runtime-scan, bracket and economic checks. The original floor and 32-slot window, exact bank equality, request budgets, per-method pacing, 429 stop and no-retry behavior remain. All signing, execution and provider-qualification authority stays false.

Independent Node 24 verification passed 183 tests across 11 related files, plus a final rerun of 59 composition tests after a test-only compatibility assertion. The implementing agent ran 146 tests across six files, TypeScript, typed lint and formatting. An independent source review found no blocker. Successful full-controller composition uses declared runtime test doubles; the real runtime integration tests cover refusal, not a positive live swap or provider qualification. No live RPC, credential, real wallet, signing, funded transaction or deployment was used.
