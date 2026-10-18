# Mobile draft refresh recovery

Started from clean local checkpoint `32cda61`, after warmup field-recovery checkpoint `e7472fe`. Own changes are limited to the warmup saved-plans component, its tests and this note.

## Changes

Reload drafts previously cleared the selected editing draft when no save was pending. The button changed from Save changes to Save draft despite retaining the reviewed form, risking an unintended duplicate. A new component regression failed against the original source, and the signed-in 375px browser reproduced the same switch before rebuilding.

Normal reload now preserves draft identity, expected revision, current name, form edits and review. A reload which finds a changed revision, archived draft or missing draft keeps the local edits but disables Save changes. Guidance offers reopening the latest saved draft or explicitly choosing New draft to keep a separate copy. It never silently advances an old form to a newer revision.

Recovering a cancelled or unconfirmed save now loads the saved document through the parent callback, invalidating the previous review before further saving. Identity reuse and manual retries are retained. Save/reload notices and errors now appear next to those controls, before the saved-draft list.

## Validation

- 49 tests across four files passed on final source: saved plans, guided warmup, read panels and cycle workflow. Added normal refresh identity/revision checks and changed/missing/archived refresh recovery checks; cancellation recovery asserts the saved document is reopened. No real provider or transaction is involved in these fixture tests.
- TypeScript, typed lint for both owned TSX files, formatting and diff checks passed.
- Production webpack build passed on Node 24. Log: `work/release-qa/warmup-draft-refresh-build-20261018.log`. Restarted the existing HTTPS guard with launcher PID 24724; auth health returned 200 and the empty submit-action probe was blocked with 403 before forwarding.
- Real signed-in Julz session, existing public wallet and Mobile unfunded wallet check draft: at 375px, changed the local amount to 0.002 SOL, reviewed the 0.016 SOL budget, and changed the local name. Reload retained both edits, the review and Save changes; the saved row retained its original name. No live Save was clicked. Restored original fields via Review with fresh start and reviewed the 0.013 SOL budget again. Persisted draft r2 and the saved-draft count remained unchanged.
- Inspected the save/reload feedback at 320, 375 and 430px. No horizontal overflow: client/scroll widths were respectively 305/305, 360/360 and 415/415. Technical disclosures remained collapsed. Reset the viewport and retained the real tab. Proof: `work/release-qa/warmup-draft-refresh-375-20261018.png`.

No API, schema, provider, credential or transaction control changes. Physical phone, wallet-extension behavior and funded execution remain outside this validation.

No funding, vault unlock, transaction preparation, signing, submission, migration, deployment or push occurred. Concurrent/missing/archived recovery was verified with controlled component responses, not by modifying the user's saved draft from another session.
