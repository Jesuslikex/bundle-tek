# Jito same-bank fee batch, 24 October 2026

This is an internal, unmounted evidence checkpoint. It does not enable signing or qualify the provider, complete the Jito flow, or deploy anything.

## Change

New lib/jito-fee-batch.ts builds one immutable, privately bound fee batch for the exact canonical transaction messages. Template expected fees are structural input only. The raw lossless reader admits actual positive fees within the original caps, exact ordered string IDs and cardinality, and one common actual slot within the unchanged 32-slot floor/span. A batch itself is not proof of a common bank. Reordered responses refuse under this intentionally stricter local profile. There is no retry, provider selection or single-read fallback.

Only observed success returns fee-derived packets and a simulation bank. Refusals may retain safe partial observations for diagnosis, never a packet vector or bank authority. Raw captures are private mutable evidence, not public DTOs or durable owned storage. All signing, execution, source, provider, signature, ALT and runtime authority flags remain false. A future transport must bind the actual sent body/hash and carry the same floor; no production transport is mounted here.

## Verification

Pinned Node24, envDir:false, ten targeted files: **473 passed, zero failed, zero skipped**, including 37 fee-batch cases and the prior 436-case cohort. Scoped typed lint, formatting and plain project TypeScript pass. No full historical suite, production build or browser pass is claimed for this unmounted module.

Actual authenticated Claude Opus 5.5 reviewed seven copied source/test files read-only, found no blocker, changed no source and reported zero permission denials. It did not run tests. Codex then added five targeted cases for pre-aborted/forged signals, simultaneous result/error, invalid RPC error code and valid API-version metadata, and independently reran the final cohort. The implementation is unchanged from that review.

## One fixed live read-only outcome

Existing Alchemy holder endpoint, unchanged settings: five HTTP requests, six RPC methods, no retry or fallback. Two fee replies both returned slot **460683397** and fee **5000 lamports**. The exact-bank unsigned simulation then returned RPC **-32602**, **bank not found for the provided slot: 460683397**. The raw adapter refused it; exact sent-request binding and complete raw refusal bytes/hash were retained under ignored work/release-qa/jito-retained-native-batch-capture-20261024. There were zero created signatures and zero broadcasts; simulated System transfers had zero amount.

This confirms a common-bank fee observation for this one sample, not repeatability or accepted simulation. Do not substitute a later bank or relax the fee/frame checks to turn this into a pass. Existing earlier sequential and concurrent fee refusals remain retained. Complete raw simulation success, real swap/ALT/program qualification and owned review/recovery integration remain open.

## Coordination

See CODEX-CLAUDE-ACTIVE-SPLIT-20261024.md. Codex owns Jito; Claude's visible proposed first slice is non-Pump Sniper Guard, with existing recovery reuse and accounting work separate. Marketplace remains in Julian's requested scope. Seven unrelated warmup drafts and the original four dirty AGENTS lines are preserved. No schema, hosted SQL, provider/credential/cron, real-wallet, funded-trade or deployment change occurred.
