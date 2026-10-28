# Imported Jito signed-packet recovery

An imported recovery file previously stayed only in a packet component, so an inner remount could hide the signed packet while bundle controls still described it as unsigned. The panel now verifies the exact packet and a fresh authenticated owner-scoped bundle record, then retains the signature in the existing non-evicting memory coordinator before exposing recovery. Existing reservations, unknown outcomes, conflicting slots and capacity limits fail closed; import does not start a wallet, register or submit.

Any pending packet blocks new signing, bundle cancellation and submission across that bundle. The signing handler also checks synchronously, so a stale enabled button cannot bypass the gate. The existing explicit unchecked recovery approval remains available to register a verified retained packet, and confirmed registration unblocks other signing. Reviewed bundles whose review time has expired can import for export only.

Independent Node 24 verification passed 116 tests across nine signer and recovery files, plus full TypeScript, scoped typed lint and formatting. The implementer ran 55 focused tests, including stale-render, unknown-outcome, remount and registration cases. Independent source review found no blocker after cross-packet and stale-render corrections.

Recovery is still memory-only and does not survive a full reload or tab closure. Cancelled-state or separately expired-state bundle rows do not yet expose an import surface. Other devices and a cookie switch after the last server check remain non-atomic. No live provider, real wallet, signing, submission, funded action or deployment was used.
