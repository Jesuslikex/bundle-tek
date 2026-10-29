# Single-batch recorder and Alchemy sample

The native-only recorder now retains a single-batch simulation as a derived
member of its original wire response, validating its exact ID, byte range,
parent digest and member digest. It does not label that member a second RPC
response or overwrite the parent capture. A mismatch fails closed.

The existing three-attempt prefee campaign ran on Alchemy with the opt-in
single-batch collector and configured pacing. Each contained two unsigned
zero-value System transfers. Configuration was read into memory; no credential
file or provider setting was changed. There were no signatures or broadcasts.

| Attempt | Fee slots | Simulation slot | Result |
| --- | --- | --- | --- |
| 1 | 462689513, 462689513 | 462689514 | fees-refused |
| 2 | 462689518, 462689519 | 462689518 | fees-refused |
| 3 | 462689525, 462689525 | 462689525 | native captured; original floor 462689521 |

The fixed sample completed, keeping both refusals. Its private wire and
derived-member evidence remains in ignored work/release-qa/
jito-alchemy-single-recorder-20261029-1793235982448/. No endpoint is published.
The recorder test suite passed 31 tests, including member tamper checks.

One native capture in three does not qualify a provider or a swap. Even equal
numeric context slots in separate batch members do not by themselves prove the
same fork or bank identity. The API submission gate remains in place. Jupiter
program provenance, actual swap evidence, repeatability and signed-vector
qualification remain unresolved. No deployment or funded action occurred.
