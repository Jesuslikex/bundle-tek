# Current randomized DCA form evidence

13 October 2026. REA connected to the already-approved dedicated Chrome profile at loopback port 9223, target 3693D0D2327B26B35068D16F84D8A0BC. Chrome reports 155.0.8059.40. No new browser/profile/debugging configuration or credential was created.

Controlled browser scenarios opened the existing unsent Auto Sell form, selected DCA, and selected Randomized. The actual interface changed from one Amount field to **Min Amount** and **Max Amount**, each with a **% Supply** unit control. Hours/minutes/seconds interval controls and Market Cap Range/End Conditions remain present. Required-field messages include interval, amount and maximum amount. No amount, interval or other value was filled; Add Strategy, Run, Buy, Sell, wallet export and signing controls were not clicked.

The actual Close control removed the Auto Sell form, confirmed in the final accessibility snapshot. A separate controlled scenario restored the original account URL; Chrome remains open. This was controlled replay, not passive inspection.

Complete structured inline Evidence is retained locally:

- ev_e2e81d9c1d0ced5c001e59b21a2542d4eefb31c2bb75cd65a15a94dcd50e36d2: opening/selecting DCA, C:/Users/Julian/Desktop/REA/results/proxima-random-dca-20261013/open-form.json.
- ev_f06fe6cad725362c71bc999d4bf05bcd0bf12237e40d0f0ca2efa7f6a00e6c1b: randomized controls and verified Close, randomized-controls.json in the same directory.
- ev_5bedd89513bbfd16fb89c9b74258c930900e621d88a84c0fcf9cb445ecdd52c2: account restoration, restore-account.json in the same directory.

The opening scenario requested page-associated network metadata, without request/response bodies or header values; its provider reports incomplete event coverage. The randomized-control and restoration scenarios requested no event collection. Storage values, cookies and private keys were not captured. A truncated model-facing preview of the large opening result is not the evidence archive: its full structured record was retained before inspection continued.

This establishes minimum/maximum per-cycle interface controls and the displayed percentage unit. It does not establish Proxima's random distribution, entropy source, rounding, amount accounting, alternative unit behavior, custody or server execution. Bundle's explicit finite allocation uses reviewed SOL/token input units, bounded sequential cryptographic draws and an exact total budget. Supply-percentage random sizing, precise backend equivalence, strategy/session ending semantics and funded execution remain open.
