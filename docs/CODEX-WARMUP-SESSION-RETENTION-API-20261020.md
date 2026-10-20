# Save and recover warmup reviews

20 October 2026. Follows `4155bd8`. Adds `/api/wallet-workspace/warmup/session-reviews` using the committed immutable snapshot service and migration 0117.

POST requires authentication, exact request origin, JSON under 2 KiB, exactly five selection fields plus literal `save: true`, and a canonical current review. It never accepts a client manifest. The service rebuilds owned source evidence, requires the original review hash and retains the snapshot once. GET accepts exactly one canonical review UUID and recovers only the signed-in owner's record. Both operations disable caching, stop cancelled work, preserve controlled conflict/status messages and sanitize unknown storage failures. A cancelled or unknown write response tells the caller to recover the same ID, without reissuing a write. No authentication, signing or submission endpoint was changed.

Verification: 22 new real local-D1 route cases and 22 existing snapshot service cases pass together. Owner isolation, raw-source omission, false authority flags, exact field/byte/origin guards, historical recovery, absent records, cancellations, missing immutable guards and sanitized errors are covered. Plain TypeScript and scoped typed lint pass. These routes make no live provider call and issue no signing or broadcast request.

The forthcoming owned Save/Recover UI is a separate source checkpoint. Automatic session execution, spending consent, fresh runtime authorization and scheduling remain unavailable. No protected layout, new migration, provider, credential, cron, application/hosted database or deployment change occurred. Production requires migration 0117 during a separately approved release; it was not applied here.
