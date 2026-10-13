# Following retained conditional notices, 13 October 2026

The token workspace's background conditional monitoring panel now offers explicit Follow / Stop following controls. Following reads the existing authenticated saved-notice API every five seconds while the page is visible and online. It uses the existing retained-run status transport, retries failed reads with bounded backoff, retains earlier notices during failure, and shows paused/retrying state. Visibility and online events resume reads. Stop, unmount and project/revision/archive changes abort pending reads.

The panel remounts at each project context, clearing previous notices and stopping follow mode. A manual reload or settings update pauses followed reads; a late cancelled response cannot replace the newer setting or notice page. New snapshots pass the existing strict project-bound notice decoder. Read-only following invokes neither the review callback nor POST settings changes. An accessible summary includes the newest retained match timestamp so a new notice is announced even when the retained count remains ten. Explicit level review still enters the existing fresh preparation and signing path.

Verification on the final 1,040-file source snapshot, digest `8becf128e119adf11e7d9488b00d1320e2fd075bd0166289f757400a4ba49b95`:

- Nineteen tests passed across `components/conditional-monitor.test.tsx`, `lib/retained-run-status-feed.test.ts` and `components/conditional-buy-workflow.test.tsx`. Final JSON: `work/release-qa/monitor-notice-follow-final-tests-20261013.json`.
- Mounted tests cover new notices, non-JSON gateway retry, retained results, hidden-tab abort/resume, project revision invalidation, stop, manual settings races and absence of automatic writes/reviews.
- Actual-source TypeScript passed using the existing isolated configuration that excludes archived work copies. Typed lint passed for all three changed code files.
- Production build passed: `work/release-qa/monitor-notice-follow-build-verified-20261013.log`. Earlier invocation-path and pre-correction lint results remain historical evidence, superseded by these final checks.

React review: hooks remain unconditional, context state is reset by a keyed panel, callback references update before subscription work, fetches are cancelled, and visibility/connectivity listeners are removed on cleanup. Notice detail pagination and demand mounting remain intact.

No schema, worker schedule, provider configuration, deployment or signing behavior changed. Claude's workspace/launch, holder and timeline files remain untouched. This proves mounted fixture behavior and compilation, not current live provider activity, a browser-rendered deployment, after-close worker operation, funded execution or full Proxima parity. Background worker deployment remains disabled pending hosting recovery. Following does not itself activate that worker.
