# Pair order minimum refusal guidance, 28 October 2026

The prepare review API now returns a fixed 409 message when an internally tagged minimum-output check refuses: the user is told the order is below the required quote bound and to request a fresh quote. It exposes no provider message, internal numeric diagnostic or arbitrary error text. Other failures retain their existing generic response. The message is limited to preparation, not approval, signature registration, submission or recovery.

The UI already offers a manual Prepare action. Tests verify that a refusal does not automatically retry, approve or sign, and a new review requires fresh unchecked consent. This is guidance for an existing fail-closed behavior: no minimum, slippage, custody, clock, 32-slot or signing check is changed. No provider setting, deployment or funded action occurred.

Node 24 focused validation passed 68 tests across four files, TypeScript, scoped lint and formatting. It was run in a separate worktree with existing installed dependencies; it is not a full suite, release build, real signed-in browser check or funded trading proof. Stock runtime repeatability and Jito qualification remain open.
