# REA wallet onboarding and Bundle entry guidance

Started from clean local `2a6e052`; the other chat committed docs-only `96f6ce1` during this work. Its files are excluded. Coordinate before using the shared Proxima target or shared local build. No deployment authorization is implied.

## Fresh reference observations

REA connected to the user's existing dedicated Chrome session on loopback 9223, restricted to app.proxima.tools. The other Bundle chat finished its inspection and released the target before any navigation here. Target discovery: `ev_3fe144115fe36e89be377b8abcc7296c615a14c6483001c6f9542dddfe56bfce`. Passive initial funding view: `ev_3562d179325a08f8db0544e5759c71557d072d5d54845349e50064e2d5e02b17`.

- Wallet navigation `ev_179ae0444fff5b8d41d1f8f5beb1c1348e8889025a3b5a1e7796bd0d8b7c1fef` initially captured only the loading shell. The subsequent settled passive view `ev_b076f1d28c1c3fc198ff0f9230fd09bcae377ae0bdd8fca4d9009083d9d498d9` showed Generate Activity, Delete and Manage disabled with no wallet selected. There was no nearby selection explanation in the captured accessibility text. This is a bounded view observation, not proof that no tooltip or documentation exists.
- Opening the Create options only, `ev_972a8dac06089e5171075077382af377dc8a58f059e317854be80548ec3f9bab`, showed Create New/Marketplace tabs, an empty Number of Wallets field, disabled Create, folder search and Skip. No number was entered, no final Create was clicked and no wallet was generated.
- An address-text click copied the public address rather than selecting its row (`ev_c1c062325499212a03e4e88756f57fa0116f18c5eb15524c3505fdaf56bbb41d`). Clipboard contents were not read. Captured DOM then identified the separate selection button. Explicitly selecting one existing row enabled Generate Activity, Delete and Manage: `ev_b64810afa9156c14e62aeb6f48289d98425d38bbd838c0ce6a0218b3abb38139`. Generate Activity was never clicked; whether it opens configuration or starts a runner remains unknown.
- Restored the original exact funding URL with no modal left open: `ev_36ad74cc54573b5b41e90b0065b728cfe6f873b93f4dcee81abb23cfb533103f`.

Complete private REA session export: `/opt/rea/results/proxima-wallet-onboarding-20261018-02-evidence.json`, eight records, 1,262,923 bytes. Captures contain account-specific display information and are not committed. Headers, request/response bodies, cookies, storage values, script sources and console text were not requested. Some scenario captures intentionally omit event sections and are not equality-eligible. Passive coverage is attach-limited and policy-filtered. No complete backend, custody, signing or execution semantics are established. The export's zero top-level unknown records does not close these limitations.

## Bundle changes informed by the reference

The observed selection prerequisite identifies a discoverability problem worth solving explicitly. The following guidance is a Bundle design choice, not a claim that Proxima implements it:

- Explain disabled warmup entry for no wallet, multiple unselected wallets, archived view or more than 20 selected wallets.
- Offer Show all wallets when filters yield no results, Show active wallets for the archived view, and Clear selection for an oversized selection. These change local view/selection only.
- Associate the explanation with the disabled button for assistive technology, use 44px touch controls, and keep valid single-wallet or selected-wallet entry free of extra copy.
- Preserve explicit selection and the existing one-visible-wallet shortcut. Never automatically select a whole wallet group. No wallet, draft, API, validation or transaction authority changes.

## Validation

- 52 tests across six files passed: entry component, guided warmup, saved plans, read panels, browser vault and workspace handoff. Entry coverage includes empty/filter/archived/over-limit recovery, explicit opening for valid selections, no automatic opening, accessible descriptions, and busy/loading guards.
- Plain TypeScript and typed lint of the three touched TSX files passed. React review: component declared at module scope, derived state rather than effects, useId for description association, explicit event callbacks, no network/storage side effects. New component/test/CSS formatting passed; the existing workspace file is edited narrowly without broad reformatting.
- Production webpack build passed on Node 24; log `work/release-qa/warmup-rea-entry-build-20261018.log`. Restarted the existing guarded HTTPS launcher (PID 26556). Auth health returned 200 and the empty submit-action probe returned 403 before forwarding.
- Real signed-in Julz session at 375px: entered a search with no match, saw the explanation and Show all wallets, and used it to restore the existing wallet with search cleared. Toggled the archived view, saw its reason and Show active wallets, and used that to return to the active view. The one-wallet Warmup button selected only the existing wallet and opened setup. Reopened the original saved Mobile unfunded wallet check with fresh start and reviewed its unchanged 0.013 SOL budget without saving. Draft count and persisted r2 unchanged.
- No horizontal overflow at 320, 375 and 430px: client/scroll widths 305/305, 360/360 and 415/415. Recovery controls inspected in screenshots at 320 and 375; 430 recovery/opening verified through accessibility state. Proof: `work/release-qa/warmup-rea-entry-375-20261018.png`. Reset the temporary viewport and retained the real tab with technical disclosures collapsed.
- Multiwallet/no-selection and over-limit states were verified through the mounted component tests; the real account has only one saved wallet. No extra wallet or folder was created for testing.

No funding, transaction preparation, vault unlock, signing, submission, runner activation, deployment, migration, push, provider or credential change occurred. Physical mobile devices and financial execution remain untested.
