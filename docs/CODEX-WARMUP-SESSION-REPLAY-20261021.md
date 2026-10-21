# Warmup transition journal replay

21 October2026. Recovery decoder following the plan-consent UI checkpoint265e7c1. Automatic Start and signing remain off.

## Implemented boundary

`replayWalletWarmupSessionJournal` reads an exact original public review-response document, captured plan, separately supplied journal anchor and ordered raw transition documents. It verifies the exact source SHA-256, domain-separated initial head (including the captured start), exact expected length, contiguous versions, previous-head links and final expected head. Changing whitespace changes the raw-document hash. Missing, reordered, duplicated or changed records cannot match an unchanged anchor. A hash chain is not ownership, receipt proof or evidence that a supplied anchor is authoritative.

Every transition reuses the unchanged original sequence implementation: begin-review, observed submission, unknown outcome, finalized settlement, Pause, Resume and terminal Stop. Strict operation-specific fields refuse additional capabilities and replacement/retry operations. Canonical UTC millisecond timestamps must be monotonic, no earlier than the captured start and no later than the supplied observation time. Historical construction must occur inside the original review window, at or after its original review time. Recovery does not replace that deadline with the current time.

The returned value contains only a detached snapshot, version/head, explicit recovery-required indicator for every pending review/submission/unknown action, and false execution/signing/automatic-execution flags. It returns no mutable sequence handle or next-action method. Even a recovered reviewing label is held because a late response may exist. Valid late finalized outcomes remain recordable after Stop or expiry; they do not resume a stopped session. The original review gap, buy/sell dependencies, receipt identities, spending arithmetic and non-replenishing rent/fee reserve are unchanged. Duplicate finalization as a second journal transition refuses rather than becoming another budget event.

The entire input is bounded to4096events and4MiB UTF-8 including the source. Caller-owned plan, anchor and record array are copied before the first asynchronous digest. Errors use a fixed recovery message and return no partial snapshot. No provider, callback, timer, database write, preparation, signing or send is invoked.

## Trust and integration still required

This is an internal decoder, with no API/UI/scheduler caller. No durable table or action reservation is implemented in this checkpoint. A future owner-authenticated service must read the original source, exact anchor and complete journal in one atomic database snapshot; a caller-supplied hash/head/version is not trusted state. It must compare-and-swap version/head when appending, atomically retain exact intent/preparation/packet identity and reserve budgets/shared wallets before any possible signature, and retain ambiguous real outcomes without replacement writes. It must replay each real finalized receipt with the existing settlement adapter and bind that replay under the write guards. The synthetic settlement literals in decoder tests prove consistency only.

The plan-consent record continues granting no execution authority. This decoder neither extends the original60-second preview nor implements the distinct session authorization horizon, fresh per-action checks, browser scheduler or reload-safe runtime. Broad Proxima parity, alternative routing and live/provider/funded qualification remain unfinished. No protected UI, existing sequencer/signing rules, migration, application/hosted SQL, provider, credential, cron, deployment or real wallet action changed.

## Verification

Final339tests/17relatedfiles pass together, including30new replay cases. Whole-project plain TypeScript and scoped typed lint/format pass. Tests use the original public-plan fixture and unchanged sequence model, never a real account or provider. Cases include all pending phases, exact source/context binding, changed raw bytes/head/version/order, rehashed invalid transitions, elapsed Pause/Resume/expiry, terminal Stop with late settlement, reserve refunds/overspending, duplicate finalization, full two-cycle buy/sell replay matching the live in-memory model at each step, mutation during asynchronous hashing, malformed input, byte/version bounds and unsafe clocks. No rendered/browser/build or live-execution result is claimed for this internal-only change.

## Claude coordination

The existing Chrome computer-use connection timed out on this turn's bounded inventory attempt. No pending review was delivered and no reply or completed review is invented. The exact earlier UI request remains in `CODEX-WARMUP-SESSION-CONSENT-UI-20261021.md`. Once that same connection returns, use Opus5.5 read-only to review the committed decoder/test diff, unchanged sequence/view/digest helpers and actual test bodies. Review the external-anchor trust boundary, original lifetime, complete-chain checks, pending holds and budget replay. Do not edit or deploy, migrate SQL, change providers or perform wallet actions.
