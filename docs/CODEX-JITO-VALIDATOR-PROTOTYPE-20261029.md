# Synthetic same-bank validator prototype

The patch at patches/CODEX-JITO-SAME-BANK-PROTOTYPE-20261029.patch applies
to Jito-Solana revision 256fbf9b601a98551636a2a394158067014f47b3. It is an
isolated research draft, not a deployed endpoint or trusted authority. Do not
use it for real wallets, transactions, qualification or production.

On Ubuntu WSL2 the unmodified upstream RPC happy-path test passed. The patched
RPC library compiled and all seven bundle RPC tests passed. Its synthetic
same-bank tests check a frozen bank, agreement between per-message fee and
simulation, rejection of blockhash replacement and an unfrozen bank, and a
one-to-five-transaction limit. These tests use synthetic transfers, not a live
swap. They do not prove fee mismatches or all adversarial conditions are covered.

The separate RPC method calculates independent per-message fees and simulates
using one frozen bank object. Its bank hash is a server assertion, not
cryptographic attestation that a remote provider actually ran the claimed code.
The draft has not been security audited or integrated into Bundle; request and
response binding, trusted execution and the full runtime evidence need further
work before it can be used. The policy continues to reject unverified Jupiter
code. No pin, signing or submission gate, provider setting or migration changed.

The source checkout is /root/jito-same-bank-prototype in Ubuntu WSL2. The
unmodified baseline uses a separate worktree. Jupiter source-to-binary
verification, 32-slot full-swap runtime coverage and production integration
remain unresolved. No funded action or deployment was performed.
