# Production-runtime stock qualification checkpoint

Implementation commit: adcfac5. Both live qualification entry points now require Node 24.x before reading pinned fixture files, creating work artifacts or starting provider reads. New receipts retain the exact Node patch and required major separately from the existing runtime simulation evidence. The campaign requires child runtime metadata to match its own. Offline summaries reject changed, omitted-within-sample, unsupported or malformed runtime metadata, while preserving historical receipts without inventing runtime evidence for them. The new policy constant is tested against package.json's production engine.

The bundled runtime is Node 24.19.0. The ordinary shell resolves Node 26.4.0. Actual CLI checks confirm both entry points reject Node 26 before a deliberately nonexistent fixture can be read and without creating work folders. Twenty-four harness tests pass on Node 24, including rate-limit stopping, six-attempt accounting, quiet-reference identity, timing, raw Clock capture and mixed-runtime refusal. Scoped script lint and formatting pass. Production source, UI and SQL were not changed; no new full app test/build claim is made.

## One bounded Node 24 campaign

A new fixed alternating six-attempt campaign was started under Node 24.19.0 with the same pinned public references. It stopped after the first 429 in attempt four. No remaining attempt or replacement was started. All four tracked source vectors match current source; the full receipts and computed phase measurements are in CODEX-PAIR-NODE24-QUALIFICATION-20261016.json.

| Attempt | Asset | Outcome |
| --- | --- | --- |
| 1 | SOL | Exact Clock context 457712059 vs raw slot 457712060, wall skew 786 ms. Refused before quote or simulation. |
| 2 | USDC | Simulation and both full code scans completed; snapshot 457712081..457712122 spans 41 slots and refuses. |
| 3 | SOL | Exact Clock context 457712140 vs raw slot 457712141, wall skew 1132 ms. Refused before order/simulation. |
| 4 | USDC | A runtime getGenesisHash request returned 429. Pending work was cancelled and the campaign stopped. Post-attempt reference audit unavailable; never treated as quiet/pass. |

Observed attempts: SOL 0/2, USDC 0/2. Two planned attempts were not run. This is an incomplete campaign with a null six-attempt summary, not a completed 0/3-per-asset sample. The first three references remained unchanged; the fourth after-audit was unavailable. No new minimum-output or writable-custody refusal occurred. There was no retry, endpoint switch or pacing increase.

For the reached USDC runtime, each full code collection contains 25 logical RPC reads (including identity metadata/genesis reads). The first spans about 4491 ms and the final about 4162 ms; these overlap other stage reads, so they must not be summed as non-overlapping total pipeline time. Before-simulation observed reads span 457712074..457712107; after-simulation reads span 457712108..457712122. These broad trace spans include preflight/setup floors and are distinct from the reported runtime's 41-slot refusal. Both scans remain fully present. The larger route/read count differs from the preceding 13-read sample, so these runs do not establish a Node-version performance effect.

Next: reduce measured full-code read latency without skipping bytes, reusing the final scan, increasing read/size/slot limits or changing custody acceptance. Clock exactly +1 acceptance remains an explicit pending user decision. The new runtime guard fixes evidence quality, not either live refusal. Stock signing remains off, no deploy/push/remote SQL, provider/credential/cron changes, UI edit, wallet unlock, signature or broadcast occurred. Claude-owned files and main's two unrelated dirty files remain untouched.
