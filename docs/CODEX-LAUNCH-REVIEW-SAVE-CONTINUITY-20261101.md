# Launch review save continuity

Follow-up to PR 76 at 34b97fe. The metadata review disclosure now remains mounted when an existing project's draft or saving state changes. Its inner draft-keyed component still remounts, aborting outstanding work and clearing publication consent and links. No publication or signing is performed by this change.

Node 24 focused verification: three test files, 21 tests passed, including the save transition and consent reset; scoped lint and git diff --check passed. No live browser or funded testing was performed.

Limitation: the first save of a new project changes the parent TokenDetailsForm key from new-project to the new ID and can remount the whole form. Preserving the disclosure across that boundary requires a coordinated parent-level change; this patch does not claim to fix that case.

Follow-up: optional controlled disclosure props and a keyed-parent test prepare that fix, while retaining the keyed inner consent and request reset. The proposed protected parent wiring is in `docs/patches/CODEX-LAUNCH-REVIEW-FIRST-SAVE-20261101.patch`; it has passed `git apply --check` but has not been applied to the checkout's `app/page.tsx`. An earlier patch omitted the form props and failed a local browser test; the corrected patch includes them. With the corrected patch applied only to a disposable local Linux copy, a signed-in test account created a new draft, opened review, saved it to the local database, and saw the review remain open with publication consent unchecked. No metadata was published, wallet unlocked, or transaction signed. The test used source at 41c492b plus the corrected patch, not a deployed app. Until the parent wiring is approved and integrated, the first-save case remains unresolved in the application branch.
