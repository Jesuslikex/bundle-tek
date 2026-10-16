# Claude read-only review of five-account prerequisites

Claude CLI session: c9e5d750-00c9-45cb-bb9f-cf03323e9f40. Successful final result,16 October2026. This is a separate CLI conversation, not a message injected into the user's desktop Claude chat. Tools were limited to Read/Grep/Glob; Claude did not edit files or execute tests. Codex runs verification itself. Original output is retained in ignored `work/claude-five-account-review.json` and its stderr sibling.

Claude reviewed the committed prerequisites f3e6f0f through234c168 and relevant consumers. It found the basic duplicate Clock, same-context partition, stock-only+1,32-slot, transport-cap and default group behaviors sound on reading, with scope limitations. It did not inspect complete argument lists of all group callers.

## Findings to resolve before whole-path qualification

1. High: runtime code collection still selects concurrency4 with the default100-account cap. One coherent profile must govern all account readers and the transport, and reject inconsistent combinations before IO.
2. High: protected full state, lookup-table scopes and candidate/order snapshots still have uncapped requests. They need explicit same-context partition consumers; slicing them across unrelated slots is unacceptable. The new offline order-state consumer addresses one part only.
3. Medium: the partition collector creates a new stock Clock scope per invocation, resetting its effective-floor/observation accounting. Integration must share the caller's lifecycle and return the collection's own observation delta without double-wrapping.
4. Medium: Promise.all rejects before sibling requests settle. Add a linked local abort lifecycle, stop publication from cancelled sibling results and settle those tasks before returning a refusal. A request-scoped transport must also be closed by its owner; arbitrary providers may ignore cancellation.
5. Low: runtime context accounting records raw slots and can omit an effective+1 Clock slot. Carry the effective observation into runtime floors and the full32-slot span.
6. Low/work in progress: the new partition-observation mapper duplicated the earlier wallet mapping and was undocumented when Claude inspected it during this turn. It now has documentation and direct tests; consolidation remains open.
7. Operational risk: even individually valid concurrent chunks may arrive from different slots. Retain every outcome; do not retry until a pass or relax same-context admission.

Claude recommended an end-to-end offline test through the real five-account transport and a cap-enforcing provider before live qualification. This review is not approval of whole-path integration or live signing. Stock signing stays off; no deploy.
