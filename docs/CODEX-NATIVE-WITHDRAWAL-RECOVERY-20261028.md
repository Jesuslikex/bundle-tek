# Native withdrawal signature recovery

External withdrawal packets are now retained before the signer's final wallet and review checks, and registered only after those checks pass. The panel probes session storage before reserving an external signing attempt. If a later storage write fails, it keeps the verified packet in the mounted panel, warns that closing it can lose the packet, and does not register it automatically.

For vault signing, an explicit signer-start marker prevents a post-signing error from being classified as proof that no signature exists. The signer retains the packet before its final context check. Recovery displays the signed packet for private copying, warns that it can be submitted while valid, and disables registration after expiry. It never automatically re-signs or submits.

Synthetic tests cover normal external signing, changed wallet accounts or signer, unavailable storage before and after signing, unmount after successful tab retention, and vault signing followed by expiration or storage failure. Independent verification passed 23 tests across three focused files, a repeat of all eight panel tests after a test-only type correction, TypeScript, typed lint and formatting. Independent review identified no further blocker in this bounded change.

Limits: tab storage is not durable across tab closure, and a storage failure combined with unmount can still lose an unregistered packet. Cancelled rows are not currently exposed by this panel's active recovery view. No real wallet, signature, funded transaction, provider change or deployment was used.
