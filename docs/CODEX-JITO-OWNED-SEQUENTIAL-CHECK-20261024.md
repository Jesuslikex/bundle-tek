# Owned Jito sequential diagnostic, 24 October 2026

Base: d8ab072. This checkpoint connects the sequential collector to an explicit check for an owned, unsigned saved Jito bundle. It is informational and adds no signing or execution authority. Nothing was deployed.

## Workflow

The existing authenticated Jito API accepts `check-sequential`. Only the saved ID and manifest hash reach the new service. Existing origin/JSON/body-size admission and the 15-second owner provider-review gate apply. Registration and submission keep their original explicit approvals.

The service checks the exact owned, unexpired reviewed bundle with no registered packets. It reads current project, wallet, preparation, session, control and intent context, reconstructs the original packet bindings, then rechecks the source fingerprint after provider work. The original minimum comes from saved fee/simulation observations and the tip slot; the complete 32-slot bound is preserved. Server-read lookup tables are compared to approved identities and rechecked after successful simulation.

The already configured holder RPC and its existing fallback behavior are used without setting changes. Each fee method reserves an ordinary pacing unit; no qualification profile is enabled. Supporting genesis/lookup reads use lossless integer parsing. Provider work has a 12-HTTP/18-method budget and a 45-second provider-stage signal. The nested collector retains its 30-second deadline. HTTP 429 stops further provider reads. There is no retry, rotation, replacement blockhash or later-bank substitution.

The public DTO contains only identity/expiry binding, fixed status/reason, packet count, slot and bounded fee observations, with every authority flag false. Raw responses, account data, packet bytes and provider details are excluded. Server and client independently validate it. Optional acquisition selections remain manifest-bound, but this diagnostic does not reread their ledger. Existing submission acquisition guards remain unchanged.

The panel reads only after an explicit click. A keyed inner component resets and aborts when context or disabled state changes; late results cannot populate the new context. Expiry is checked before and after parsing. Any registered packet disables the check. HTML, private provider text, unknown fields, wrong hashes and true authority flags are rejected. The owner HTTP-429 message explains the minimum 15-second wait without retrying.

The existing `canSign` expression and signing/registration/send/recovery implementations are unchanged. The service does not write bundle or intent state. The outer API retains its existing rate-gate bookkeeping.

## Verification

**694 tests pass across 32 files**, with zero failures or skips, on an isolated source snapshot of committed HEAD plus only eleven owned code/test files. No local secret file or concurrent warmup edits were copied. Source hashes stayed stable. Isolated project TypeScript, typed lint and formatting pass.

Coverage includes 32 server cases using real native SQLite and the actual collector, eight Buy/Sell, ALT and Token-2022 combinations, 36 strict DTO cases, and 13 jsdom interaction cases. Four route-composition tests exercise the actual authenticated route through native SQL and the real service/collector with RPC responses mocked. They cover a complete response, cross-owner rejection before RPC, a late control-row change and first-429 stop. Bundle and packet rows remain unchanged; only the test rate-gate row is inserted.

These are disposable test databases, not application or hosted SQL. This is not a complete migration-ledger audit, whole-repository suite, production build, signed-in browser-layout check or live-provider qualification.

An Opus 5.5 source-only review was requested through the existing authenticated CLI. Its session limit stopped it before review; it reported a reset at 05:10 Europe/London and zero cost. No Haiku or other model was substituted. **This checkpoint is not Opus-approved.** Independent helpers reviewed the source and lifecycle; Codex verified the combined result. Detailed logs, source hashes and isolated manifests remain under ignored `work/release-qa/jito-owned-check-isolated-20261024`.

## Coordination and remaining gates

At pinned Claude PR57 head f7bc15aa1ed35e049937bacce4c28d9c88be4e36, Codex independently inspected the new Cleanup runner and posted [two findings](https://github.com/Jesuslikex/bundle-tek/pull/57#issuecomment-6379061401): repeated sell/buy rotation conflicts with the agreed cleanup scope, and an ordinary recovery error can allow another round while a submitted trade remains unresolved. This is source review, not an allegation of deceptive intent or a funded reproduction. A scope/unknown-outcome hold was requested; no acknowledgement or merge is claimed.

Unrelated warmup edits appeared during shared-checkout QA. They are preserved and excluded from this commit and isolated verification. Original dirty AGENTS notes and the seven frozen warmup drafts are also preserved.

The previously observed exact-bank provider refusal remains unresolved. Complete accepted live frames, independent program/mint/Rent/ALT/runtime admission, retained economic replay and exact signed final replay/recovery integration remain open. This diagnostic cannot replace those gates. No application/hosted database, migration, provider/credential/cron setting, real wallet or funded-trade action was performed by Codex.
