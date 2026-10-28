# Offline qualification compiler writes, 28 October 2026

The full script test run failed six tests because the esbuild subprocess could not write its generated output on this Windows environment. Five exchange tests stopped before making their synthetic provider request; the warmup snapshot test reported the same output-write denial directly. These were offline harness failures, not proof that a live provider or trade succeeded or failed.

Both affected harnesses now ask esbuild for output in memory, validate that it produced the single expected file, and write exactly those bytes using Node's exclusive-create flag. Existing source hashes, migration snapshot checks, request guards and refusal behavior remain. An added test verifies an existing output is never overwritten.

Node 24 validation: all eight focused tests passed. The full script suite passed 88/88 with matching before/after hashes of 4,113 tracked and nonignored source files on the tested snapshot; subsequent independent Jito edits are not covered by that snapshot. Scoped lint and formatting passed. No provider credentials, actual network, wallet signature, funded transaction, hosted migration or deployment were used.

The earlier full unit run on commit 1e22910 did not pass: 12,514 tests passed, 23 failed, 914 were skipped, and 78 test files failed. Its reported failures involved workerd being denied permission to create Miniflare's cache directory; a fresh process-local temp root reproduced the problem. A normal child process could create the same directory under the same ACL, but the precise workerd-specific cause remains unknown. This compiler fix does not resolve that D1 test-environment problem.
