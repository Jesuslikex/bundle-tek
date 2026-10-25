# Original saved-launch inspection

24 October 2026. Source-only checkpoint from main `62fb422` plus this owned change. No deployment or funded action.

## What changed

Account launch recovery discovery can now inspect the original saved review by its immutable venue/kind/record/project/mint/creation/expiry reference, without a current project or navigation provider. Archived, missing or edited projects do not replace the saved review. Pump create/developer/holder/group, Meteora DBC, StonkFun and LaunchLab retained formats are supported; unknown formats refuse conservatively.

The existing authenticated account GET dispatches an exact inspection query to a new SELECT-only projection. It returns original scalar terms, stored hashes/public signature references, recorded state, packet count, receipt presence, and bounded raw budgets. Private signed evidence and receipt bodies are never selected. The stored review JSON contains unsigned packets internally; those bytes are parsed on the server but never returned or rendered. All signing, execution and receipt-verification flags are false. This is inspection, not a financial review or new authority.

Saved input limits, terms limits and nullable allowances have distinct provenance. Null remains unavailable, never zero. Recorded participant intent distinguishes an explicit no-buy request from unavailable evidence, with the actual 200-holder cap. Present holder terms must match the recorded allowance rows. Fee/rent allowances remain separate from creator buys; raw quote/token amounts are not converted into guessed units.

The disclosure is passive until an explicit inspection click. Reads have cancellation, a 15-second deadline over fetch/body, 1 MiB client JSON limit, immutable-reference validation and no-store/redirect refusal. Closing, changing reference, cancellation, sign-out or errors discard old inspection data. HTTP401 offers native sign-in and manual retry. Budget pagination uses only loaded data, with keyboard focus preserved at boundaries. A stored first group signature is explicitly not a whole-group receipt.

## Validation and limitations

The final test/type/lint totals and source hashes are recorded in the companion JSON. Real disposable Turso tables and actual offline Pump group/mixed-holder fixtures exercise stored shapes. They do not simulate a funded launch or provider qualification.

Synthetic Chrome desktop and 375px iframe checks used only local fixture GET responses: passive disclosure, expired original reference/current-project independence, 5-packet labels, large exact values, unavailable evidence, loaded-data pagination and sign-out clearing. Keyboard focus reaches the budget status at a disabled pagination boundary. Mobile wrapping was inspected visually; a DOM iframe-width measurement was unavailable. No signed-in production or live-provider check is claimed. Own QA tab/server were closed after verification.

Two actual source-only claude-opus-5-5 reviews completed with unchanged isolated copies and zero permission denials. The follow-up found no security or functional blocker. Codex independently checks the review findings and runs all tests. Final lint-equivalent display-text filtering and test-only corrections, plus the developer-intent consistency follow-up, are independently verified after the review snapshot. The reviewer ran no tests/browser/providers. Names with unsupported control/bidi text conservatively refuse rather than being rewritten.

## Coordination and remaining work

Only the exact AGENTS claim paths changed. Claude PR57/protected parent/layout, existing financial POST/services, db/drizzle and providers remain untouched. The prepared recovery-project navigation patch is still unapplied pending exact owner/user approval. This inspector works without it. Full Jito live qualification remains unproven; no program pin, 32-slot bound, serial group scan, custody, consent, signing or send-once safeguard changed.

OpenCode's existing Bundle session was contacted again. Its old vault worktree remains clean at `97b8b03` (merged PR58); canonical main was `62fb422`. The session read the handoff and checked those Git states, then returned a provider free usage limit (HTTP 429) before a final reply. No acknowledgement beyond those observed reads, new edits, model change or permission bypass is claimed. A new disjoint branch/file claim is required before its next task.

The original four unstaged AGENTS additions and seven frozen warmup drafts stay outside this checkpoint. Publishing source is not deployment or funded proof.
