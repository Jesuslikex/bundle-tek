# Direct Orca route: Jito read-only investigation, 2026-10-30

## Result

Full swap qualification remains **blocked**. Orca is a candidate for a direct route that avoids Jupiter, but no direct Orca swap, full bundle simulation or same-bank fee proof was performed. Signing and execution remain disabled. The diagnostic is not a qualification gate and changes no runtime policy.

## Evidence

- The existing `PAIR_TRUSTED_PROGRAMS` entry includes the Orca Whirlpool program. On-chain source verification is a separate claim: at this investigation the public verification service reports `is_verified: false` for the deployed Whirlpool program. The existing code pin matching does not establish a reproducible source build.
- Three independent first scans using the existing Jito runtime collector and configured Alchemy holder RPC accepted the System and Whirlpool program identities. Floors and maximum observed slots were 463342753 to 463342776 (23 slots), 463342812 to 463342834 (22 slots), and 463342947 to 463342969 (22 slots). Each first scan used 22 logical reads. The Whirlpool program's pinned full-code SHA-256 was `c422b22f3eefe86dd55878a4f505b9c68c26e241dc96af1573ca032b24b8ee3f`, with 10,485,715 code bytes. The observed upgradeable loader and upgrade authority also matched the existing policy.
- On the third sample the diagnostic immediately started a second complete scan against the same initial floor, **without** a simulation between the scans. It was refused when a response reached slot 463342980, 33 slots after the initial floor. There were 31 total transport reads and no 429. This is a single lower-bound observation for this provider and minimal program set, not proof that every candidate/provider must fail. It is also not a substitute for the mandatory full before/simulation/after sequence.
- Two initial diagnostic setup attempts made zero collector HTTP reads because the temporary harness omitted the required System program. The harness was corrected before the three scans above; those failed setup attempts are not included as runtime results.
- The current full Jito economic verifier and simulation replay are Jupiter/Metis-specific. A direct route requires its own complete swap instruction and account decoding, exact input/output and balance conservation checks, quote/price bounds, mint and rent verification, program and writable-account admission, and the same independent fee and same-bank evidence. Existing historical movement classifiers do not grant execution approval.
- The previous same-bank blocker remains: this investigation did not establish a synchronized trusted validator endpoint providing the project's exact bank-bound evidence and independent fee checks. A passing Orca code pin would not resolve that blocker.

## Reproduce the bounded diagnostic

Run only with an already configured, authorized mainnet read-only holder RPC; the script does not print the URL. It makes one `getSlot` request and up to two serial code scans, stops on refusal or a provider rate limit, and never signs or sends a transaction:

```powershell
node --env-file=C:/Users/Julian/Desktop/Bundle/.env.local --import tsx scripts/probe-jito-orca-runtime.ts --live-readonly
```

The lower-bound diagnostic does not use a wallet, quote, swap transaction, simulation, fee-bank evidence, signing or broadcasting. Its `fullSwapQualified`, `providerQualified`, `sourceAuthenticated`, `signingAllowed` and `executionAllowed` fields are always false. No full qualification can be claimed from this output.

## References

- Orca public program repository and legacy swap accounts: https://github.com/orca-so/whirlpools and https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/instructions/swap.rs
- Orca on-chain source verification status: https://verify.osec.io/status/whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
