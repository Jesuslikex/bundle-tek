# Durable atomic launch review preparation

Added server-internal preparation and refresh for owned Pump create/developer-buy reviews. Preparation independently simulates the exact saved target and quote cap, checks the existing token-authority policy, reconstructs the version-1 signing packet, and saves immutable terms, project bytes, review and simulation evidence in `pump_launch_reviews`. The existing migration's context, active project/payer/mint uniqueness, shared swap reservation and append-only guards apply. No migration was added or changed.

Identical terms recover the existing review without another RPC collection; flat terms are serialized with sorted keys. Different terms or a changed project require recovery/cancellation first. An existing swap or launch reservation is rejected before collection, while the database insert guards arbitrate concurrent changes. A review is saved in `review` state and grants neither signing nor execution permission.

Refresh loads only an owner-scoped review, reconstructs the unsigned packet, verifies the saved project remains active and unchanged, and re-simulates with the original blockhash and last-valid height. Packet bytes, observed account hashes, deployment metadata hashes, prices, quote spending and SOL debits must match the saved evidence. Ownership/folder guards are rechecked by the owned collector. This function performs no approval transition or signing.

The owned initial-buy collector gained server-only input capture and original-lifetime options. The existing create-only authority policy was exported with a narrow structural type; its behavior and live create-only flow were preserved.

## Verification

Five focused files passed, 50 tests, with Node 24. They include the real preflight route/local D1 database and real launch triggers, atomic review persistence and retry, exact refresh, foreign-owner rejection, immutable review enforcement, conflicting swap reservation and project changes during simulation. Existing create-only route/UI, atomic simulation and strict signing regressions passed. Actual-source TypeScript, scoped lint and production build passed on final source.

Test setup retains append-only launch history instead of attempting to delete it. Controlled RPC mocks now preserve explicitly supplied providers and lifetimes, so race and refresh tests exercise their intended calls. These are controlled tests, not funded execution proof.

## Remaining integration

These internal services are not yet called by the live launch route or UI. Explicit approval and signature-registration transitions, separately approved submission, version-1 receipt recovery and the initial-buy UI must still be connected. Signing permission stays false in preparation responses. Holder buys, scheduling, StonkFun execution, buyback split-rounding attestation and funded user proof remain open.

Nothing was deployed, signed or broadcast. No remote migration, cron, provider or credential change occurred. Claude's UI files and main's two unrelated dirty files remain untouched. Production remains source `11ad20b` at https://bundle-tek.vercel.app/.
