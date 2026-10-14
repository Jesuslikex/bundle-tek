# Atomic Pump UI checkpoint

UI commit `bb48682` changes only `components/launch/pump-launch-review.tsx`, its tests and the scoped UI notice. Server/API implementation remains in prior commits, ending at `b58f5ca`. Claude's layout, holder and timeline files are untouched. The metadata parent's existing keyed draft boundary was verified and did not need an edit; the review component also keys its complete project/plan/release context.

Saved positive developer percentages now choose the atomic create/developer-buy endpoint. The user supplies a separate quote-spend cap in the selected asset's human units, with exact integer conversion and precision limits. The independent review displays the developer output target, quote budget/spending, fee/rent allowance, SOL debit, mint, payer, quote mint, metadata and packet fingerprint. It explicitly states that saved holder buys are excluded, and rejects scheduling.

The existing image/publication and browser-encrypted mint backup workflow is reused. Signing requires backup confirmation, both unlocked vaults, the exact saved review, signing consent and separate acknowledgment of simulation limits. Observed quote precision is checked against the selected asset before unlocking keys. Signing and broadcast consent remain separate. Changing quote caps, fee/rent allowance or the saved draft invalidates the appropriate approval/context. Existing signed packets can be registered without creating fresh signatures; uncertain submissions keep recovery controls.

## Verification

- Final unchanged application source: seven focused files passed, 73 tests, Node 24. Scope includes UI consent/amount/context guards, metadata, strict dual signing, real local-D1 launch APIs and independent simulation. Existing create-only regressions pass.
- Actual-source TypeScript, scoped lint and production build passed. The temporary render-only QA route was removed before these final checks and is absent from the build.
- Existing Chrome rendered a synthetic TSLAX developer-buy form at desktop size and 390x844 phone width. Document width was 375px within the 390px viewport, with no sideways overflow. No mint was generated, wallet unlocked or transaction prepared/signed in that browser check. The full review/action states are covered by controlled component/API tests, not a successful funded browser run.
- Ignored screenshots: `work/pump-atomic-desktop-20261014.png`, `work/pump-atomic-mobile-20261014.png`.
- The development preview logged a hydration attribute mismatch involving `data-qb-installed` and wallet-extension warnings. This does not establish a clean browser console; no blanket console-clean claim is made.

No funded launch, real signing/broadcast, remote migration, credential/provider change, cron enablement, push or deployment occurred. Main's two unrelated dirty files are preserved. Production remains source `11ad20b` at https://bundle-tek.vercel.app/.

## Remaining parity

The create/developer-buy UI and API are now connected locally, but funded user execution and final receipt proof are unverified. Holder-wallet buys, scheduling, StonkFun execution, full program/rounding attestation and the wider Proxima parity items remain open. The local checkpoint must not be described as a full bundled launch or a live release.
