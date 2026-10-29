# Alchemy access clarification, 29 October 2026

Two bounded requests used the existing SOLANA_HOLDER_RPC_URL in memory from
the original checkout's ignored local configuration. No configuration or
credential file was copied, created, changed or deleted. The endpoint was
restricted to HTTPS solana-mainnet.g.alchemy.com, redirects were forbidden,
and each request had a ten-second timeout with no retry.

- getVersion: HTTP 200, matching response id and a string solana-core version.
- simulateBundle with zero encoded transactions and empty account configuration
  arrays: HTTP 200, matching response id, a result field and no numeric RPC error.
  Signature verification was not skipped and blockhash replacement was false.

This establishes connectivity and an empty-method response only. It does not
establish a valid nonempty bundle, same-bank account/fee evidence, program
identity, sequential execution, repeatability or provider qualification.
No wallet was unlocked, no signatures created, no transaction bytes provided,
and nothing was broadcast or deployed. No endpoint or response body is published.

The original 28 October 19:00 UTC rejection concerned a combined command that
temporarily wrote configuration, ran a Helius campaign and deleted that file.
Its reason was only 'blocked by policy'. It has not been retried. Treating it
as a demonstrated account-wide Alchemy prohibition was unsupported.
The exact signed-vector qualification and final submit gate remain unfinished;
the draft submission block must remain enabled.
