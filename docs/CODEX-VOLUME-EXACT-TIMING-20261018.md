# Volume Bot exact timing and schedule clarity

18 October 2026. Builds on the retained Proxima Volume Bot form ev_3d997a0321ca79e69eee8a07456821874712f44273610b8e9e1de21e806e2e26, which shows HMS timing. The vendor's backend timer and Duration/Delay mode semantics remain unknown; this does not claim execution equivalence.

## User story and result

A user enters hours, minutes and seconds, sees the exact total, estimates with canonical integer timing, and can distinguish the requested schedule limit from the shorter estimated schedule. The UI reuses the tested DurationInput/parseDurationParts code already used by DCA. Default remains 30 minutes; permitted duration remains 60..86400 seconds. Invalid/empty/fractional/exponent fields remain invalid and prevent estimation; minutes/seconds above 59 are never carried silently. Editing raw timing clears an estimate even when its numeric value stays the same.

Trade delays still accept 1..600 seconds with millisecond precision. Decimal-to-integer conversion is exact; 1.234 seconds becomes 1234 milliseconds, while 1.0004 is refused rather than rounded. Reversed ranges and other invalid canonical terms fail locally before wallet/provider reads. The same server volumeTerms rules remain authoritative. Request/save schemas, durationSeconds/delayMinMs/delayMaxMs fields, limits, seed, hash validation, USD capture/acknowledgement, approvals and signing/broadcast/recovery implementation are unchanged. No migration or provider settings change.

Browser verification exposed an existing semantic distinction: with short delays, the 250-round cap can stop the planned schedule before the entered duration. The estimate now shows both Schedule limit and Scheduled time, and copy explains volume/cap termination and additional approval/settlement waits. Time labels preserve hours, minutes and seconds instead of rounding away seconds or showing60minutes within an hour. This is planned scheduling, not a wall-clock deadline guarantee.

## Verification evidence

| Boundary | Evidence |
| --- | --- |
| UI entry | Real component and module CSS rendered in isolated synthetic fixture at 1440px desktop and 375px phone. Default 1800 seconds, selected 3723 seconds, invalid 60 minutes and 1.0004 delay verified. |
| Client request | Browser fixture records durationSeconds 3723, delayMinMs 1234, delayMaxMs 2345. It refuses all real provider requests and every save/sign/send action. |
| API/model/data | 64 current tests across six focused files pass together on Node 24.19.0, including actual Volume route/local database service, model, shared duration helper/input and mounted panel. Existing server request/plan/persistence regressions remain. |
| Response rendering | Returned plan renders exact 1h 2m 3s limit separately from an approximately 15-minute scheduled plan under the existing250-round cap. Raw-equivalent edit invalidation is tested. |
| Responsiveness | 375px viewport: innerWidth 375, clientWidth 360, scrollWidth 360. Viewport reset confirmed 1280/client1265 and own fixture tab closed. Other chat's signed-in tab untouched. |
| Static checks | Plain TypeScript, three-file type-aware lint, formatting and diff checks pass. No checker, test expectation, deadline or execution guard was weakened. |

Images: ignored work/volume-timing-qa/desktop.png, mobile.png and invalid-minutes-mobile.png. These are synthetic browser fixtures, not an authenticated real Volume Bot session, funded trade or production release. Initial fixture CSS links were stale after a prior build; references were corrected to the current public styles before final desktop/mobile captures. No application styling was changed to conceal the mismatch.

The expanded run first found one USD service test failing during quote setup, before the project-change behavior it was intended to test. Its zero-age observation sat on the cross-clock freshness boundary. The service fixture now supplies a still-fresh observation one second in the past. A separate test deliberately advances only the application clock and confirms the database still refuses a future observation. Production capture, database clock checks and freshness policy are unchanged; the original failure did not record precise compared timestamps, so no measured clock-drift cause is claimed.

## Coordination and limits

Only owned Volume panel/tests, its service test fixture and notes changed. The other chat owns warmup polish, guard/auth and the actual signed-in browser flow. Its files and shared HTTPS server are preserved. Application source is frozen for its next combined build; no new production build pass is claimed at this checkpoint. No real key access, wallet unlock, transaction preparation/signature/submission, credentials/provider/cron change, remote SQL, push or deployment. Full Proxima parity remains open, including separate multi-strategy/session-wide endings, market Cleanup and unverified vendor execution semantics.
