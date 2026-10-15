# Authenticated complete Pump launch group API

15 October 2026, based on 28f53aa. Connects existing complete-group preparation, immutable review/approval/signature registration and persistent observation services to /api/launch/pump/groups. Submission and browser signing UI remain unavailable.

## HTTP contract

GET projectId selects paged group history (page=1 and cursor use the existing group-bound launch history format). GET id reads one exact owned review. GET id with observations=1 reads observation history and returns an opaque nextCursor bound to that exact review and observation type. Duplicate, cross-scope and unknown query fields reject. Observation cursor encoding has fixed field order independent of the caller object's insertion order.

POST supports prepare, approve, register, revalidate, observe and cancel. Prepare reuses the existing strict wallet-selection and raw-limit parser, retaining up to 200 slots and deriving owner/origin on the server. Group approval/registration require exact whole-group manifest, context, simulation and scope consent. Registration accepts one through five distinct, canonical bounded packet strings; the service independently verifies the complete exact group. A partial or reordered group cannot be retained. Caller-authored observations/reviews, endpoint overrides, owner/origin overrides, private-key/session fields and all submit/send/sign actions reject.

Authentication precedes parsing/database/provider access. Writes require the exact request origin and JSON content type. Streamed bytes are capped at 64 KiB, UTF8 decoding is strict, and the body has a 10-second cancellation/deadline guard inside the overall 60-second request guard. Provider errors are returned as plain sanitized JSON with no-store headers. Expensive actions use a 5-second owner/project/action rate gate and Retry-After; reads and idempotent retained-signature registration retries remain available.

The provider adapter uses only the configured server HTTPS endpoint and explicitly allows the required read/simulation methods. Mutation and submission RPC methods are refused. Registration and unsigned cancellation do not instantiate a provider. Existing service ownership/revision/approval/reservation and observation insert guards remain authoritative. All API results retain existing signingAllowed, executionAllowed and completeLaunch policies; approval is not runtime qualification.

## Verification

Four selected files exercised 28 unique passing cases: the initial full run passed 26, then the final two-file boundary run passed 15 after two added cases. Reports: work/group-api-tests.json and work/group-api-final-boundary-tests.json.

The real route integration test uses Request/Response, actual local libSQL, all real group business services and their migration guards. Authentication, creation preflight and the RPC provider are controlled fixtures. It covers complete multi-packet preparation, fresh durable approval, synthetic signed-vector registration/idempotency, persistent partial observations, history reads, foreign-owner rejection, blocked approved cancellation/submission and retained wallet reservations. No actual provider, user account or wallet is used, and no send method is invoked.

Boundary cases cover all 200 input slots, raw caps, exact consent, disallowed fields/actions, vector count/encoding, owner/origin/content type, paged query scopes, canonical cursors, streamed size/UTF8/JSON, cancellation, a stalled body through a controlled deadline signal, per-action rate gates, provider-free registration/cancellation, sanitized errors and refusal of mutation transport methods. Existing single-packet holder route regressions pass alongside the new API. An initial cursor-order bug and test-only URL-parameter inference issue were corrected before completion.

Current-source TypeScript, five-file typed lint and production Next.js webpack build passed. The built route inventory includes /api/launch/pump/groups. A TCP smoke test was attempted after the build, but automatic approval review rejected the temporary local production server launch with "blocked by policy" and supplied no further reason. No server started; no alternate launch method was attempted. TCP/deployed endpoint verification is therefore not claimed.

## Remaining work

Connect the workspace UI to this API, preserving explicit group scope and live context across review/unlock/sign/register. Guarded terminal recovery/release, economic settlement, program/runtime/code/authority qualification and a reviewed one-attempt transport/tip policy are still required before enabling group execution. More than five packets has no enabled policy. No full Proxima parity or funded execution is claimed.

No protected UI/Claude files, migration, remote SQL, real provider request, provider/credential setting, cron, push, deployment, user signature or transaction submission changed. Production remains b58355d; 0085 is local only. Main's two unrelated dirty files remain excluded.
