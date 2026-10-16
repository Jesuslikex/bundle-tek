# Pinned quiet references and fixed sample

The read-only harness can now discover references from bounded older public transaction history, including token owners that differ from routing-service fee payers. Discovery checks ordinary system ownership, at least 0.012 SOL, unchanged funding snapshots and a latest observed signature at least 4096 slots old. USDC additionally needs a stable canonical ATA with at least one USDC. These are fixture screens, not changes to production acceptance. Six attempts use the same pinned per-asset identities, with fresh existing funding/custody checks and unchanged mandatory before/after activity audits on every attempt. The fixture hash and public-reference hashes are recorded; the offline checker rejects fixture changes or per-asset identity rotation, including on refused runs. The actual public-address fixture stays in ignored work, not user wallet storage.

Discovery is limited to sixteen older pages, sixteen transactions, 48 candidate owners, 100 requests and 180 seconds. It uses only allowlisted read methods on the configured endpoint with explicit qualification pacing. Missing transactions are counted and excluded, never considered quiet; a 429 cancels discovery without retry. No quote, simulation or wallet action occurs during discovery. This proves sampled provider-visible inactivity only. Public owners can resume activity at any time. The ordinary 256-slot qualification idle threshold, every production guard, 32-slot limit and signing gate are unchanged.

The JSON retains all four discovery outcomes, including the initial unavailable transaction and two unsuccessful fixture searches. The final discovery found SOL idle for 11215 slots and USDC idle for 4831 slots. Earlier discovery revisions sampled fee payers/USDC owners before all token owners; those discovery receipts lack a source hash and are historical diagnostics only. They are not qualification receipts. The six subsequent receipts include unchanged source hashes, all match the current harness, and are retained without replacement.

Fixed sample: SOL 0/3 and USDC 0/3. All six before/after activity checks were unchanged, with zero 429s, signatures or broadcasts. Refusals, in order:

1. SOL: packet minimum below original protected minimum.
2. USDC: Clock/context bank mismatch.
3. SOL: quote unavailable/no route.
4. USDC: full runtime completed in 31 slots, one simulation and both 13-read code phases. Post-attempt activity audit raised the qualification span to 33. Refused against unchanged 32.
5. SOL: code identity read at slot 457694852 exceeded minimum 457694819 by 33 slots. Refused, not a scan pass.
6. USDC: decoded SPL Token CloseAccount at instruction 3 refused the existing token-close guard. Captured opcode is 09 and all account privileges are in the receipt. The exact failing predicate was not captured, so do not infer one from the error name.

A separate later read at slot 457695612 found that close target differed from the USDC canonical ATA, held 13 raw token units and 1488453 lamports. The USDC ATA held 872930001 raw units. This later snapshot is not the original order bank and does not prove which token-close predicate failed. Next investigate wrapped-SOL fixture state without permitting account closures before the route or weakening custody rules.

Verification: fourteen Node tests pass, covering pinned identity/hash validation, rotation refusal, quiet audit bounds, the six-attempt denominator and stop-on-429 behavior. Scoped script lint and formatting pass. Production source, UI, group serial defaults, credentials, providers and cron unchanged. No push/deploy/hosted SQL/unlock/sign/send. Repeatable 32-slot qualification remains incomplete; stock signing remains hard off.
