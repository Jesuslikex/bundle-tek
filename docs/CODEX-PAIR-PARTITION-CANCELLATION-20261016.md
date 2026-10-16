# Partition sibling cancellation

Follow-up to finding4 in docs/CODEX-CLAUDE-FIVE-ACCOUNT-REVIEW-20261016.md. The collector now links the caller signal to a local AbortController. A failed collection aborts sibling tasks and awaits allSettled before propagating the original refusal. Cooperative injected RPC providers receive that lifecycle as an optional third argument.

Reads are raced against cancellation, with abort listeners removed on completion/cancellation. After cancellation, a late result cannot populate retained provider responses or proceed through the collector's Clock observation wrapper. Providers that ignore the signal cannot hold the collector open indefinitely. The collector does not retry or publish a partial result.

This does not forcibly terminate arbitrary provider work. The integration owner must still close its request-scoped transport and bind physical fetch cancellation to the lifecycle. Existing two-argument RPC functions remain compatible but ignore the optional third argument. Shared stock scope/floor/observation-budget handling, consistent account-profile propagation and effective-slot runtime accounting remain open findings. No live qualification should be inferred from this correction.

Final Node24.19.0 run:12 files/301 tests passed together. Five-file typed lint and plain TypeScript pass; formatting/diff checks pass. New deterministic tests cover abort delivered to a cooperative sibling, first failure while a sibling ignores cancellation and returns late, and outer cancellation with unresponsive providers. Existing partition, order-state, wallet, transport, Clock, order-first, order-candidate and runtime tests pass. No real provider, build, browser or full-suite result is claimed.

No production entry point opts into partitioned state or wallet reads. No UI/provider setting/credential/database/cron/deployment/wallet action changed. Stock signing stays off.
