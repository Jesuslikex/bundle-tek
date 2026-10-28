# Experimental read-only Jito bank ordering, 28 October 2026

This is a native diagnostic only. It is not mounted in the application, a swap qualification, a provider endorsement, or permission to sign or send. No deployment, hosted SQL, persistent provider settings, wallet signing or funded action occurred.

An explicit `--prefee` native profile sends the two real fee requests and an unadmitted confirmed-bank discovery simulation in one actual JSON-RPC batch, then sends a separate explicit-bank simulation. The fee members must each equal the discovered bank, the exact simulation must use and return that same bank, and all observations remain in the original F..F+32 window. Every method is paced and counted; there are no retries or provider fallbacks. The default production collector and the native harness's legacy default are unchanged. The experimental profile's `providerQualified` and all signing/execution flags remain false even after captures.

The actual batch parent, member byte ranges and hashes, and separate exact simulation response are retained. Fee projection and discovery-member extraction are explicitly marked as derived, not separate wire responses. HTTP-200 JSON-RPC 429 errors during native setup or final genesis now stop the entire campaign even with an unmatched ID, without leaking the provider's body into the summary.

## Actual bounded sample

Three unsigned zero-value native-transfer attempts used the existing Alchemy holder endpoint with existing pacing. No other endpoint was selected, no signature was made and nothing was broadcast. All three refused:

1. Fee and discovery banks matched, but the explicit simulation returned the provider's specific bank-not-found response.
2. Fee and discovery banks matched, but the explicit simulation returned the same bank-not-found class of response.
3. Discovery bank 462556566; fee banks 462556565 and 462556566. The different banks were refused before an exact simulation was requested.

This is not a successful qualification or evidence about a funded swap. The complete private receipts and request/response bytes are under ignored `work/release-qa/jito-native-prefee-20261028/`. Do not copy endpoint credentials or raw private captures into a commit. Previously retained legacy samples are unchanged; these three attempts cannot be treated as retries of, or successes for, those samples.

## Verification and remaining gates

Node 24 focused verification: 67 collector/legacy-replay tests and 24 native harness tests pass, with typed lint. Independent review found the RPC-429 stop gap; deterministic setup/final-genesis tests now exercise the fix, and a follow-up review found no blocker in its scope. A complete repository suite, production build and funded proof were not performed. The real swap path still needs reviewed program provenance, same-bank provider evidence, full runtime/economic qualification and an approved release process. Retain exact bank equality, both scans, original slot limits and current signing gates.
