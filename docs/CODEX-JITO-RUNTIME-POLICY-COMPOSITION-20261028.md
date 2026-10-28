# Jito runtime policy refusal composition

A synthetic integration test exercises the real read-only qualification controller together with the real runtime scanner. A deliberately changed System program identity triggers the existing program-policy refusal. The test verifies that the sibling asset read is aborted, runtime-after and bundle-attempt evidence stay absent, no qualification simulation or submission is called, and every returned authority flag remains false.

The synthetic baseline capture separately uses an injected simulated transaction response to prepare its fixture. It does not contact a provider or sign or submit anything. This negative test does not qualify a live provider, a successful swap, or Jupiter's program identity. It changes no pins, checks or signing authority.

Independent Node 24 verification passed 10 tests across two files. The author also ran typed lint and formatting; an independent review confirmed the test's scope and prompted explicit no-simulation and authority assertions.
