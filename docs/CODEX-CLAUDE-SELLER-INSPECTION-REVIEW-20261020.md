# Opus review and seller inspection recovery fixes

20 October2026. Separate follow-up to785a254. Julian asked Codex to use Claude Opus5.5 again. Codex used the existing signed-in Chrome Bundle project conversation, observed Opus5.5 selected, and sent a focused read-only review request for0f60969 and its collector parent825e730. Claude confirmed a separate cloud checkout and no edits, PR, deployment or wallet actions. This was a review, not a transfer of implementation ownership.

## Findings assessed

Claude initially reported a device-clock recovery dead end, an inventory-key concern, overly generic4xx messages and missing cooldown guidance, plus a diagnostics/logging nit. Codex checked the findings against the actual control paths and requested the missing context/helpers. Claude then retracted the inventory-key finding: `load()` calls `begin()`, which clears `review` before replacing inventory, while edits/expiry/cancel also clear or unmount the reviewed panel. No key/layout patch was needed. The original parent integration test already covers price edits and late replies.

Claude's follow-up read AGENTS, the handoff note and the imported request/owned-reader/RPC/slot/JSON helpers. It found no additional issue there. It did not run tests, typecheck or build, did not inspect tests line by line, and did not review the new token-inspection foundation. Codex retained implementation, testing and final judgment. This note is not a claim of exhaustive security approval or Proxima parity.

## Implemented changes

Inventory admission now distinguishes a stale or ahead-of-device capture with a fixed typed error. Its accepted time interval is unchanged: future observations refuse; exactly60000ms of inventory age remains accepted;60001ms refuses. Canonical timestamp and every retained source predicate remain in place. The operator console recommends automatic device date/time and a fresh inventory read instead of only repeating an unexplained verification error.

Native account inspection admission similarly classifies future or expired observation time. It still refuses any future observation, accepts an otherwise valid inspection at59999ms, and refuses at60000ms. No server Date header is used to enlarge expiry, and no timestamp, slot, balance, ownership or consent predicate is relaxed. All signing and financial flags remain false. Stale responses and a mismatched device clock share cautious wording; the client does not claim to diagnose the actual cause from a timestamp alone.

The panel maps400,408,413 and415 to fixed local explanations, alongside its existing401/403/409/429 handling. It never displays the response's raw error string.409 and cancellation explain the15-second gate. A visible local cooldown disables new inspection requests for15seconds from their start, retains Cancel during pending reads, and restarts for15seconds after a provider/local429 response, including a delayed response. Timer completion only re-enables the manual action; it never retries or polls. Unmount still aborts pending work, old replies cannot set results, and backend pacing remains the authority across remounts/tabs. Saving/publication consent is unchanged.

The optional logging nit was not implemented in this checkpoint. Provider/collector errors still receive a sanitized503; no raw SQL, URL, key or upstream text was added to logging. More precise server-side reason-code diagnostics remains a separate improvement.

## Verification

Final combined marketplace run: **482 tests across31files pass**. Ten new regressions cover inventory and inspection freshness boundaries, wrong-device-clock guidance in the console/panel, four fixed4xx explanations, the full15-second cancellation cooldown, and a fresh cooldown after a delayed429. The prior server/session/cancellation/source-replay/native SQLite/Turso route tests remain in the same passing run. Plain `tsc --noEmit --incremental false`, scoped type-aware lint and formatting pass.

Chrome renders the actual console and panel with public synthetic metadata and production styles. The inventory-clock fixture returns an explicit clock guidance message and no selection form. The inspection-clock fixture refuses its future result, shows the same actionable guidance and disables another read. After the cooldown, the button becomes available with the request counter unchanged. A manual ordinary retry displays the valid result while its new cooldown remains visible. Five fixture requests, zero financial writes/signatures. At desktop1440 and phone375, no horizontal overflow; phone document widths both360 with a15px browser vertical scrollbar and inspection widths both326; action height46px. Images: `docs/qa/20261020/marketplace-inspection-review/`. Fixtures do not establish live provider or production sign-in behavior. Temporary tab closed and viewport reset.

Final isolated production build exits0 on785a254 plus the eight exact source/test overlays, with all canonical and snapshot hashes unchanged. It uses a sanitized environment, no application `.env`, local font fixtures and a dependency junction. Evidence: `CODEX-CLAUDE-SELLER-INSPECTION-REVIEW-BUILD-20261020.json` and `CODEX-CLAUDE-SELLER-INSPECTION-REVIEW-QA-20261020.json`. No new full-repository suite, funded test or live provider qualification is claimed.

## Coordination and remaining work

Owned seller/model files only. No protected Claude shell/token layout, migration, application/hosted SQL, operator/provider/credential/cron setting, real listing/hold/payment, wallet unlock/sign/send, funded action or deployment. Next migration stays0122 subject to recheck. The token inspection foundation is committed separately as785a254; it still needs API/UI integration. Fresh control/provenance, checkout, payment reconciliation and secure key delivery/import remain unfinished, as does broader Proxima parity.
