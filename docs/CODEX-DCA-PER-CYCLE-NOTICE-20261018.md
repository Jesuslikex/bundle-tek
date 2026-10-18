# DCA per-cycle input notice

REA ev_4ab7f14df2604858089505b87778f008cc25e588717e28005939816967b0b6eb establishes the unsaved AutoSell DCA form's fixed/randomized input, hours/minutes/seconds interval, market-cap and per-strategy ending controls. No Add Strategy or Run action was invoked. Bundle currently accepts only a total input budget, split across finite cycles.

Owned plan: an exact integer per-cycle-to-total helper in lib/dca-trade-session.ts/tests, followed by a Total budget / Per-cycle target selector and exact summary in components/dca-trade-session.tsx/tests. Existing server terms, two-to25 cycle limit, u64 bound, supply basis/conservation and approvals stay unchanged. Supply percentages multiply exactly to a total percentage, then the existing aggregate rounding and even split remain, explicitly labelled as possibly differing by one atom per cycle. Randomized sizing requires total-budget mode. This avoids inventing a new rounding or spending permission.

The other Bundle chat, Review current progress, explicitly approved this selector/summary scope with no overlap. Its vault/onboarding, app/page, token/holder layouts, shared CSS and guarded HTTPS/build remain untouched. No provider/credential setting, signing, funds, SQL, push or deploy. New helper is initially unconnected; the later UI checkpoint will record actual verification and remaining HMS/multi-strategy gaps.


Verification update: the selector is now wired and browser checked with synthetic saves. See CODEX-DCA-PER-CYCLE-20261018.md for39 model/UI tests, exact supply-rounding semantics and the recaptured retained REA evidence (ev_bc007f671029d3a5653eb2cd19e66149691fb56b6acb3a20e8c493f17989e371). The earlier reference above was inline-only before the provider session reset; the new retained bundle is authoritative for this checkpoint.
