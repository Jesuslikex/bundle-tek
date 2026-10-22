# Next warmup execution root: admission requirements

22 October2026. Sourcef82beabc88df36f197cf67df2503c48679740482. This is a reviewed implementation contract, not implemented storage, permission, a migration reservation or a completed warmup runner. Journal currently ends0138; next0139 is unclaimed and must be rechecked.

## What exists

The execution manifest and ledger are unmounted bookkeeping. WarmupExecutionLedger.create calls bindWarmupExecutionManifest, which strictly parses shape, policy, dependencies, economics and pacing before hashing. Opus's opening statement that it accepts any value without checking is incorrect and is not adopted. These validators still do not establish real consent, ownership, provider facts or receipts. Existing v1/v2 approvals explicitly keep authority false. Reusing their IDs or changing flags is not execution approval.

The actual sell receipt route optionally looks up an app intent. A genuinely signed historical packet can be observed without one. Preserve that feature: new execution-bound admission must not forbid ordinary manual/external receipt capture. Its appearance after a reviewed baseline must invalidate eligibility for new session work, rather than be retroactively counted as a session action. Recovery of already in-flight work remains possible under its original identity.

## Exact next implementation slice

Build distinct server-internal execution terms and immutable approval/root storage, with same-ID recovery, no event dispatch, wallet hold, API mount, signer, timer or provider-setting change. All returned authority flags remain false. This is a necessary dependency, not a substitute for durable CAS, shared wallet/lot admission and the real outcome writer required by CODEX-WARMUP-EXECUTION-CONTRACT-20261022.md. Do not claim an operational Generate Activity loop from storing a root.

1. Obtain a fresh owned retained review and its exact raw source/document/hash. Bind server-authenticated owner, plan/revision, ordered actions, wallet revisions, source baseline, fixed policy and original deadline. Retain the original reviewed timestamp; do not use a new timestamp to extend eligibility. Recheck freshness and current source in the insert transaction, not just by comparing the retained row to itself.
2. Capture new internal verifier evidence for missing asset and conservative fee/rent facts. Actions expose mint but not a complete program/decimal/rent contract. Saved-lot facts must come from exact retained source entries and agree with current mint evidence; missing old tokenProgram is a refusal for execution admission, not permission to default to classic TOKEN. No arbitrary request-body metadata or verified:true is evidence. Preserve every action; include only wallets that actually occur, while the original plan/source still binds inactive wallets.
3. Buy ceilings must match captured raw spends. Per-action fee/rent ceilings require a reviewed policy and verified account-size/rent facts, sum within the exact reviewed wallet ceiling and fit u64. The saved review's signed rent/net reserve calculation must not silently let refunds/proceeds replenish execution authority. Prove gross historical debits and available budget from source receipts, or require a new explicit review with independently bounded terms. Do not invent a fee formula or narrow the rule until those facts are established.
4. Store distinct execution consent and immutable root only after the exact terms were separately approved. Same owner/ID plus identical canonical terms recovers the original record and original deadline. A reused ID with different terms, a legacy v1/v2 consent, stale source or another root for that consent refuses. A fresh review is required for new authority; a recovery read is never a renewal.

## One-way canonical binding

The current flat model manifest contains consentSha256. A new consent must bind the complete intended manifest, so directly hashing a consent that contains a hash of that same consent-bearing manifest is circular. Use explicitly versioned domains:

- Terms contain every planned manifest field except consentSha256, the exact root/consent identities, retained review/source identities and verifier-evidence digest. There must be no placeholder consent hash or extra omitted semantic field.
- termsSha256 = H(canonical(terms)).
- Consent contains its distinct format, owner/root/consent/review identities, termsSha256, exact explicit acknowledgement and original deadline. consentSha256 = H(canonical(consent)).
- Root contains its distinct format, exact terms and consentSha256. rootSha256 = H(canonical(root)). Rebuild the terms from the owned source/evidence and compare exactly on admission and read; hash equality alone is not verification.

Do not silently rename the existing model format or pass the new root hash into the old flat model as if they were interchangeable. The future adapter must bind both domains explicitly, or introduce a separately versioned model with corresponding replay/mutation tests. The model's expectedRootSha256 currently means its flat manifest digest. No adapter or new root format is implemented by this note.

## Storage and refusal proof required

Before choosing a migration, measure canonical maximum4800-action and maximum-ID/source/evidence bytes against actual D1/Turso row, bind, response and total-history limits. Chunking must preserve an exact complete manifest and refuse partial publication. Existing1.5MiB consent limits cannot simply be assumed sufficient. Terms/root/approval capacity is separate from76100event-model capacity.

Use the unchanged full schema in disposable SQL. Prove immutable owner/identity/source/consent/manifest binding; canonical format and all leaf mutations; wrong-domain or circular/placeholder hashes; exact-ID replay/conflict; duplicate consent/root; original freshness/deadline; every wallet/action/lot budget and asset dependency; altered or missing verifier evidence; missing source between verify and insert; concurrent identical/conflicting admissions; no partial root if a component fails; and recovery without new authority. Manual receipt insertion before root must remain valid while making root admission refuse; insertion after root must leave root history intact and make new work ineligible. No cursor is rebased to the latest receipt count.

Current thirteen-file Opus review could not establish saved UUID/order compatibility, all legacy source guards, asset/rent verifier semantics, maximum byte capacity or the future adapter. Codex must inspect and test these rather than accept the proposed design as qualified. All32-slot, both-code-scan, custody, Clock, minimum-output, original expiry, per-action qualification and one-send rules remain requirements. Held/unknown outcomes never release based on expiry or absent history. Existing v2 isolation remains unchanged.

## Review and verification scope

Actual claude-opus-5-5 Read/Glob/Grep review completed18:57:51Z to19:00:26Z with13unchanged source copies and zero denials. No edits/tests/browser/network were performed by the reviewer. Codex independently checked the manifest constructor validation, optional intent capture, source action shape and current migration number. Findings above are scoped requirements, not a production proof or broad reviewer approval.

A separate frozen integration run targets committedf82beab and797physical test files with environment-file loading disabled and unmocked external Node network blocked. It is still running when this contract is written; no full-suite pass is claimed. The first normal live-checkout attempt was intentionally stopped to replace its isolation configuration, not because an observation timeout was treated as termination. All46 native script tests passed separately on the same app source; the frozen harness also runs them after Vitest. Detailed active process and eventual results remain under work/release-qa/full-release-f82beab-20261022. This note does not enable a release, strategy, signing or funded test.
