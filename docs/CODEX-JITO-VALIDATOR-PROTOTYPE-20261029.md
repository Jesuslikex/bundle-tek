# Unverified same-bank validator prototype

The patch at patches/CODEX-JITO-SAME-BANK-PROTOTYPE-20261029.patch applies
cleanly to Jito-Solana revision 256fbf9b601a98551636a2a394158067014f47b3.
It is an isolated research draft, not a deployed endpoint or trusted authority.
It has not been compiled, reviewed, security audited or tested. Do not use it
for real wallets, transactions, qualification or production.

The candidate introduces a separate RPC method and attempts to calculate
independent per-message fees and simulate against the same frozen bank object.
It refuses changed blockhashes and fee disagreement. Its bank hash is a
server assertion, not cryptographic attestation that a remote provider actually
ran the claimed code. The draft includes an in-process synthetic RPC test,
but neither this test nor the upstream baseline has completed at this checkpoint.

The exact source checkout remains at /root/jito-same-bank-prototype in the new
Ubuntu WSL2 distribution; the unmodified baseline build uses a separate
worktree. The patch is published only to preserve and review the work. It does
not alter Bundle's checks, existing signing/submission gate, provider settings
or application migration. Jupiter source-to-binary verification, provider
attestation, 32-slot runtime coverage, integration, and full-swap qualification
remain unresolved. No funded action or deployment was performed.
