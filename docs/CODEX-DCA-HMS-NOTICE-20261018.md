# DCA HMS timing work notice

Scope: new exact HMS parse/format helper, controlled hours/minutes/seconds input with CSS module/tests, and owned DcaTradeSession/tests. Existing retained REA strategy form evidence ev_bc007f671029d3a5653eb2cd19e66149691fb56b6acb3a20e8c493f17989e371 and ev_5e2f23d15920096f6dc8db94c6aa5404f5f4a06e75ebfd8d3919f763926b3849 show separate time units for intervals and duration.

Preserve the existing1to86400second interval bound, positive safe-integer duration, exact schedule/deadline interpretation, all end-time/custody/signing checks and current provider settings. No new server fields or migrations. No elapsed-time timer or background execution. Keep malformed input invalid; never silently normalize out-of-range minutes/seconds. Empty individual units mean0, all empty means unspecified. Existing draft identity includes raw unit edits.

The other Bundle chat confirmed no overlap and retains wallet/warmup/browser/guarded HTTPS ownership. Shared source/build/server changes will be coordinated separately. No app/page, shared CSS, token/holder/vault/warmup edit, key/password access, funding, signing, submission, push or deploy. Browser QA will use an isolated synthetic component harness.
