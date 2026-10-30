# Direct Raydium CPMM Jito candidate, 2026-10-30

## Result

The existing Jito policy **refuses** Raydium CPMM. This investigation does not add a policy pin, approve a route, verify a source build, qualify a swap or enable signing. It does not resolve same-bank bundle simulation and independent fee evidence.

Raydium publishes CPMM source and identifies its mainnet address as `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`. Its source at the commit referenced by the public verification service describes an exact-input swap with 13 ordered accounts and two u64 amounts. This is research evidence only: that source has not been proven to match the currently deployed executable. Token-2022 behavior, account permissions, pool and vault ownership, quote/slippage, receipt conservation and every other mandatory gate remain to be verified before any implementation could be admitted.

## One live read-only policy-refusal probe

Using the existing production Jito runtime collector and Alchemy holder endpoint, with the System program and the candidate CPMM program only:

- Original confirmed floor: 463344141. Maximum observed slot: 463344150, a span of 9 slots. Nine HTTP reads, no 429. This is one incomplete program-only sample, not a full route or repeatability qualification.
- The actual executable bytes were 793,824 bytes with full-code SHA-256 `b6dbea8cefc2e7d490775ce6115e34a2ba480c0853c359e0bb4043b9381ef09a`. ProgramData was `DMawCQzbgNTmbzaESc7o6pvL1KAeetY8zA7jNpzntHhU`, deployment slot `452376460`, upgrade authority `FytDrVzDybM1TwFQPGb8qaxZR7dBCzNeqT3vtQsceZQK`.
- The collector completed the scan and returned `program-policy-refused` because the existing reviewed policy has no CPMM entry. It stopped before any second scan. Captured bytes are observations, not a review or permission to pin today's hash. The script always exits nonzero.
- The public OtterSec status endpoint reported `is_verified: false` and no successful verification timestamp while referencing source commit `cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce`. Its normalized `on_chain_hash` was `93cad2458ac72435c94b8ac89faa686987f4e29d2f0e862d546fbc5aa814a0d2`. That hash is a different representation from the collector's full-code hash and should not be compared directly. This status is not proof that no other verification exists.
- Compared with the previous Orca first scans at 22–23 slots, 9 slots suggests CPMM may leave more time, but one scan does not establish that two scans, all other programs and checks, and the same-bank simulation will fit within 32 slots.

The probe can be repeated explicitly with an authorized configured holder RPC:

```powershell
node --env-file=C:/Users/Julian/Desktop/Bundle/.env.local --import tsx scripts/probe-jito-raydium-cpmm.ts --live-readonly
```

The diagnostic does not emit the provider URL, a wallet, a quote or a signed transaction. It has no retries, never substitutes a newly observed program hash for a reviewed pin, and marks provider, program, source, execution, signing and full-swap qualification false. No Vercel settings, provider settings, production data or user funds were changed.

## Next evidence required

1. Independently establish the exact source revision, build settings and a reproducible deployed-program binary comparison. A successful verification is not a security audit; the instruction and account model still needs review.
2. Separately review the candidate code, upgrade authority, version and program policy. Do not add a pin solely from this diagnostic.
3. Build and test a direct-route verifier covering the full packet and economic proof. Test realistic complete program sets with both scans and the unchanged 32-slot span.
4. Obtain authenticated same-bank simulation and independent fee evidence, then run the full read-only qualification with no signing or submission.

Sources:

- https://github.com/raydium-io/raydium-docs-v1/blob/main/reference/program-addresses.mdx
- https://github.com/raydium-io/raydium-cp-swap/blob/cfdb70a8ca9ea62bb5c304d4492ac0fc371ae8ce/programs/cp-swap/src/instructions/swap_base_input.rs
- https://solana.com/docs/programs/verified-builds
- https://verify.osec.io/status/CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C
