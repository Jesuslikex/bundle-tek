# Launch review save continuity

Follow-up to PR 76 at 34b97fe. The metadata review disclosure now remains mounted when an existing project's draft or saving state changes. Its inner draft-keyed component still remounts, aborting outstanding work and clearing publication consent and links. No publication or signing is performed by this change.

Node 24 focused verification: three test files, 21 tests passed, including the save transition and consent reset; scoped lint and git diff --check passed. No live browser or funded testing was performed.

Limitation: the first save of a new project changes the parent TokenDetailsForm key from new-project to the new ID and can remount the whole form. Preserving the disclosure across that boundary requires a coordinated parent-level change; this patch does not claim to fix that case.

Follow-up: optional controlled disclosure props and a synthetic keyed-parent test now prepare that fix, while retaining the keyed inner consent and request reset. The exact proposed protected parent wiring is in `docs/patches/CODEX-LAUNCH-REVIEW-FIRST-SAVE-20261101.patch`; it has passed `git apply --check` but has not been applied to `app/page.tsx`. Until Claude or the user approves and the parent wiring is integrated, the first-save case remains unresolved in the app. Three focused test files / 22 tests pass with the synthetic parent; this is not a mounted full-app test.
