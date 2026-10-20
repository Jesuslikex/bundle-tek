# Current seller account inspection foundation

20 October 2026. Follow-up to b5069f1, server-internal only. No API or UI is mounted by this checkpoint.

`lib/marketplace-sale-inspection.ts` adds a read-only inspection for one exact selected seller wallet revision and asking price. The caller must authenticate and authorize the operator and supply a fresh owned inventory reader; the helper is not a public authorization boundary. It reuses the configured mainnet balance endpoint, bounded precision-preserving RPC transport and ordinary wallet pacing. No new endpoint or provider setting is introduced.

Before RPC work, the helper admits the owned inventory and exact wallet revision. It verifies mainnet genesis, captures a confirmed slot floor, requests only account metadata with a zero-byte data slice, then reads the final slot with the account floor. Reversed floors and spans above the existing 32-slot consistency limit refuse. This is an account observation consistency check, not stock-runtime qualification or signing evidence. No Clock path or signing rule changes.

The account response must include exact u64 lamports, owner, executable flag, account space and an empty base64 data slice. Null is explicitly an absent account. Only System Program ownership with non-executable, zero-space metadata is described as a system wallet. Other valid metadata is reported as unsupported, not promoted to an ordinary wallet. Current balance and its signed integer difference from the retained balance remain separate from the historical control proof. Missing historical evidence stays null; it is never substituted with a zero balance or a funding/creation date.

After provider reads, the owned inventory is read and admitted again. The selected wallet's revision, metadata, proof, retained history and receipt counts must match. Only its derived advancing age counter is excluded from that comparison. Archival/removal or changed source evidence refuses. The overall operation has a 60-second abort window and cannot publish a result at or beyond that expiry or after cancellation. Provider responses are bounded to 16 KiB; there are no retry loops. Returned provenance contains the hostname only, no provider URL/key.

Current control, token inventory, provenance, sale qualification, payment, delivery and signing flags remain false. A recent native account snapshot does not prove ownership of the signing key, absence of token holdings/authorities, exclusive custody, provenance or sale readiness. A nonzero balance is neither a checkout credit nor a promise of included funds. The snapshot has no durable entitlement and must never authorize checkout directly.

## Verification

Final marketplace run: 27 files, 375 tests pass, including 27 new inspection cases. The new transport fixtures exercise mainnet identity, exact address/floors, numeric RPC u64 precision, zero-byte slice, absent/unsupported accounts, unknown historical evidence, selected revision before reads, revision/proof/history/archive drift after reads, reversed floors, 32 accepted/33 refused, malformed/overflow amounts, malformed metadata, oversized responses, cancellation, 429 without retry and expired/reversed server time. Synthetic responses only; no live provider, wallet or application database was used. Existing native marketplace route/storage regression tests also pass within that run.

Scoped type-aware lint and formatting pass. Final plain `tsc --noEmit --incremental false` exits0. No new build/browser pass is claimed: this helper has no production caller or UI in this checkpoint. Previous marketplace browser/build evidence belongs to the preceding checkpoint.

## Next integration and boundaries

Add an operator-authorized, same-origin bounded manual inspection API with scoped provider pacing, then display this exact account evidence separately from historical listing evidence. New inspection calls must recheck current operator access. Do not let the snapshot create listing, reservation, purchase or signature authority. Fresh control verification, token/authority checks, provenance requirements, exact checkout approval, protection against hold expiry during payment, finalized payment reconciliation and secure browser delivery/import remain open.

No protected Claude files, shell/layout, UI, migration or application/hosted SQL changes. Journal remains0121; next number0122 subject to recheck. No actual listing/hold/payment, wallet unlock/sign/send, funded test, provider/credential/cron/operator configuration or deployment. Git publication does not deploy this work.
