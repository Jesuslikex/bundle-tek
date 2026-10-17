# Stock-pair refusal diagnostics

Base: PR #1 branch `claude/project-thread-2s6vlv` at `1def59c`.

Commit `d7f3a2c` adds exact operands to the three refusal paths in the sanitized
six-attempt evidence from 17 October. It does not change any acceptance rule,
the 32-slot limit, or the disabled signing policy.

- Token-spend and output-minimum refusals now retain the token balance before
  and after simulation and the required delta beside the actual delta.
- Native conservation refusals now retain the system-wallet balance before
  and after, the expected native-delta constraint, and the exact wallet/WSOL
  delta, fee, rent, refund, auxiliary gain, input, and minimum-output operands.
- Existing auxiliary-account refusals now retain the required status and rent
  floor alongside the observed status, lamports, and account length.

The four earlier receipts (#2, #4, #5 and #6) still lack those values; this
change cannot reconstruct them. The fixed six-attempt campaign has not been
rerun against live RPC, so no new live diagnosis or SOL/USDC qualification is
claimed. The attempt to launch it with the existing local provider settings
was rejected by command policy before execution. No provider request started,
and no local environment file was created in this checkout.

Validation on this commit: the candidate and auxiliary regression files passed
123 tests; `npm run typecheck` passed; scoped Oxlint, formatting, and
`git diff --check` passed. Signing and execution remain disabled; nothing was
pushed or deployed.

Next: run `scripts/run-stock-repeatability.mjs --live-readonly` on Node 24 with
the same approved Alchemy runtime settings. Keep the 3 SOL / 3 USDC order, stop
on the first HTTP 429, retain every attempt receipt, and inspect the new
`diagnostic.comparisons` for attempts that refuse. No check should be relaxed.
