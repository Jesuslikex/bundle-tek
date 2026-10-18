# REA capture recovery and completed Volume form inspection

Local continuation after `a4d41c4`. The other chat's launch/exchange work was preserved. Its `3fa29b9` backend checkpoint was frozen for the combined build; the later exchange UI ownership note and any subsequent files are excluded from this commit. Own changes: Volume panel/CSS/test, one REA adapter script and this note.

## Browser repair

The existing dedicated Chrome and loopback relay remained reachable. MCP interactive calls remained stalled while passive observations worked. Provider source serializes captures, so a prior unfinished capture likely kept later requests queued; this is an inference rather than a directly observed queue dump. A diagnostic through the dormant native reference build exposed the concrete opening error: `Emulation.setLocaleOverride` reports another locale override already in effect. Native CLI input also differs from installed WSL 6.4.0: its connect ownership/cleanup and origin fields are not interchangeable. No reference-source changes, default launcher switch, installations or configuration writes were made.

The repair uses the active WSL runtime through `scripts/rea-browser-scenario.mjs`. It launches an isolated, bounded REA capture rather than entering the stalled MCP queue. Its invocation-only Node loader adapts the single locale call in the installed browser module, pinned to original SHA256 `f08cc802b6de547394145d75c6c473778433dddb6d754be190ff7fa6f4389f2d`. Only the exact already-active-locale error is tolerated; every other error propagates. The existing locale is retained and explicitly reported as unverified in the provider result before REA constructs its Evidence identity. The installed module and default REA launcher stay unchanged. Runtime drift fails closed and requires review of the adapter.

The wrapper uses REA's normal schema, composition/provider and Evidence service. It admits only the existing loopback endpoint, Proxima start origin, connect mode and click/press actions, with no secrets, storage seeds, storage capture, or raw network bodies/headers. It uses a 45-second abort signal, writes a new private result without overwriting files, and closes the owned provider connection. It does not move authentication, modify the profile, start a browser or alter financial approval rules. The old MCP interactive queue was not restarted or claimed repaired; future interactive REA work should use this isolated runner until that connection is reconnected separately.

Example (supply a reviewed scenario JSON using the installed 6.4.0 schema; output must be a new path):

```powershell
wsl.exe -d Ubuntu -u rea --exec /opt/rea/tools/node-v24.21.0-linux-x64/bin/node /mnt/c/Users/Julian/Desktop/Bundle/scripts/rea-browser-scenario.mjs /mnt/c/Users/Julian/Desktop/Bundle/work/release-qa/scenario.json /opt/rea/results/new-capture.json
```

## Completed live inspection

- Initial successful restored-page capture: `ev_a1a49b4c6b0daffa2a7011b021a3d6dac4e0cea38f7c0bea186299c06c3f8ccd`.
- Opened Volume Configure successfully in 3.9 seconds: `ev_d73b93994900ad9f12b39677f4c5f95db86190ceeee29df63230b1df3b2d5754`.
- Opened Advanced settings: `ev_764df3f4fecccb3cd1eaed9de6a612b9f7170b8c0908acfd59d025acdb2a24d5`.
- Complete seven-step navigation/configuration/cancel capture in 5.3 seconds: `ev_ae3bc48d32281a00b43e5db498e0da43944293ddeb0a01ddb56265234949bf72`, private `/opt/rea/results/volume-bundle-full-20261018.json`.
- Final adapter source was rerun successfully, restoring the exact original funding page with no modal: `ev_1654b8ab1099039e0427f7ba6dfd51186d794666160423d1aeae45be7b1375d6`, private `/opt/rea/results/volume-restored-adapter-final-20261018.json`.

The initial form exposes target volume and Duration/Delay timing, with optional controls under Advanced. Selecting Bundle displays the one-wallet same-block buy/sell definition and removes Wave Intensity. Selecting Organic restores that control. Delay timing displays min/max minutes/seconds and Fixed/Random per-trade sizing in the quote currency (Tesla in this inspected workspace). The optional Fee Target remains a native SOL total tip budget. Wallet selection is optional in that reference form.

Only Configure, Advanced, Bundle, Delay, Organic and Cancel were invoked. No numeric values or wallet selection were changed. Estimate/Plan was never clicked. No session was started. This confirms configuration UI behavior, not backend execution, tip allocation/refunds, atomic settlement, same-block delivery or eligibility on other chains. Locale remains unverified; event capture was intentionally disabled, so equality/complete-network claims are not made. Private captures contain account-specific display information and stay outside Git.

## Bundle UI improvement

Following the observed progressive disclosure, optional delay, trade sizing and wave intensity now sit under Trade settings, closed initially. Target, duration and required wallet selection remain visible. Existing defaults, exact terms, estimate invalidation, approval rules and payloads are unchanged. A failed setup exposes Edit trade settings, which opens and focuses the disclosure; native invalid fields also reveal their containing section. Same-block Bundle execution and session tip accounting remain explicitly unavailable, as documented in the preceding checkpoint.

## Validation

- 58 tests passed across Volume panel, planner, service and batch files, including default-collapsed settings, required wallet visibility, invalid hidden delay recovery, successful correction and no creation/preparation/signing/submission during that regression. Existing exact payload and legacy schedule tests passed.
- Plain TypeScript, two-file typed lint, formatting, script syntax and scoped diff checks passed.
- Final shared Next production build 74695 passed with frozen `3fa29b9` source; log `work/release-qa/volume-rea-repair-build-20261018.log`. This does not cover the other chat's subsequent changes.
- Restarted guarded local HTTPS using the normal launcher (PID 24208). Auth health returned 200 and the empty submit-action probe remained blocked with 403 before forwarding.
- Actual component and production styles in the isolated Volume fixture: at 375px, entered an invalid delay, closed settings, observed local refusal, reopened through Edit trade settings, corrected the delay and obtained the unchanged scheduled estimate. No session save was clicked; the fixture refuses all writes/non-fixture network requests. At 320/375/1440px, client/scroll widths matched 305/305, 360/360 and 1425/1425. Keyboard opening worked at desktop width. Reset the viewport, closed the fixture tab and stopped its listener. Proof `work/release-qa/volume-rea-repaired-375-20261018.png` is synthetic UI verification, not provider proof.

No funding, transaction preparation, vault unlock, signatures, transaction submission, runner activation, hosted migration, push or deployment occurred.
