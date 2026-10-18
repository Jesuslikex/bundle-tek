# Mobile warmup field recovery

Local continuation after `68b6954`; latest shared checkpoint inspected was `eb13ac5`. The index was empty. Concurrent DCA start-delay source, tests, matrix and notes belong to the other chat and are excluded from this commit.

## Change

Review previously opened Custom token addresses for every validation failure, including an expired saved start time and invalid fee reserve. A mounted-component regression reproduced the expired-start failure against the old implementation before the fix.

Existing plan validation now identifies the editable field while retaining its messages, ordering, numeric limits and exact budget calculations. Review opens only the relevant disclosure, focuses and scrolls to the field, marks it invalid, and associates it with the alert for assistive technology. Edits, reopening a draft and successful review clear the marker. Native browser validation still opens hidden options. Invalid plans cannot enable Save, and correction/review never saves automatically.

## Verification

- 97 Vitest tests across six files passed: guided warmup, saved plans, read panels, cycle workflow, plan model and the Miniflare-backed plans route. Includes nine model field cases, invalid amount/reserve focus, empty token focus, and expired-start correction without mutation. These use isolated fixtures, not real wallet signing.
- Plain TypeScript, typed lint on the four owned source/test files, formatting and scoped diff checks passed.
- Production webpack build passed using Node 24. Log: `work/release-qa/warmup-field-recovery-build-20261018.log`. Combined app source included the other chat's frozen DCA changes; those are not owned by this commit.
- Restarted the existing guarded local HTTPS server using the normal launcher. Auth health returned 200; an empty submit-action probe returned 403 before upstream forwarding.
- Real signed-in Julz session in Codex browser tab 1: opened the existing public wallet's warmup and saved Mobile unfunded wallet check draft. At 375px, its expired start opened timing and focused the invalid start field; Start in 5 minutes followed by Review recovered successfully. A zero reserve, with options collapsed before Review, reopened those options and focused the reserve. A malformed buy amount focused that field while technical options stayed closed. Both corrections restored the 0.013 SOL review and enabled Save, without clicking Save.
- DOM measurements showed no horizontal overflow at widths 320, 375 and 430 (client/scroll widths 305/305, 360/360 and 415/415). Screenshots inspected at 320 and 375. This is browser viewport testing, not a physical phone or mobile wallet-extension test.
- Restored the original draft fields via Review with fresh start and reviewed again. Persisted r2 was not changed. All technical disclosures stayed collapsed. Reset the temporary viewport and kept the real tab open. Screenshot: `work/release-qa/warmup-field-recovery-375-20261018.png`.

No funding, vault unlock, transaction preparation, signature, submission, deployment, push, migration or provider change occurred. No funded execution is proven. Current saved start times can expire by design; the field correction and fresh-start paths now recover without misleading token-entry detours.
