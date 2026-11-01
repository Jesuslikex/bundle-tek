# Launch review save continuity

Follow-up to PR 76 at 34b97fe. The metadata review disclosure now remains mounted when an existing project's draft or saving state changes. Its inner draft-keyed component still remounts, aborting outstanding work and clearing publication consent and links. No publication or signing is performed by this change.

Node 24 focused verification: three test files, 21 tests passed, including the save transition and consent reset; scoped lint and git diff --check passed. No live browser or funded testing was performed.

Limitation: the first save of a new project changes the parent TokenDetailsForm key from new-project to the new ID and can remount the whole form. Preserving the disclosure across that boundary requires a coordinated parent-level change; this patch does not claim to fix that case.
