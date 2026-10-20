# Generate Activity wallet summary

20 October 2026. Source checkpoint follows bc504dc. No deployment, hosted SQL, provider/credential/cron change or funded activity.

Recorded cycle progress now shows a responsive card for every selected wallet: completed recorded loops, finalized transaction count with separate buy/sell counts, exact recorded SOL turnover, recovery state and a collapsed buy/sell volume breakdown. Empty evidence stays zero; it does not imply a completed loop. This is receipt-backed progress, not an active automatic-session indicator.

The existing validated lot accounting now retains buy spending and sell proceeds before network fees and account rent. One admitted buy receipt counts once; each admitted linked sell counts once, including partial sells. The existing unique-signature, finality, wallet/token, slot, source and conservation checks run before these values are returned. Turnover adds the native settlement amounts in integer lamports across mints and does not infer USD price, profit, balances, external trades, failed or pending transactions. Existing P&L allocation arithmetic is unchanged.

A pure summary admission checks exact plan/revision/archive scope, the full cycle/wallet/token vector, unique steps and lot identities, source ownership, remaining-unit conservation, non-negative bounded counts/volume, consistent recovery counts and completion states. Earlier matching revisions enter only through the existing explicit toggle. Recovery counts repeat in the cycle response but are counted once per wallet. Missing or malformed volume fields withhold the result instead of falling back to planned volume. Opening progress still uses the existing one read; this feature adds no provider or HTTP request.

## Verification

-42 related files/410 tests pass together. This includes the real disposable D1 cycle-progress route and full warmup API suite, exact linked-lot economics,18 new summary admission cases, synthetic buy-to-sell component integration, corrupted-state refusal, and static accessible summary rendering.
- Whole-project TypeScript (`tsc --noEmit --incremental false`), typed lint and formatting pass for the10 changed source/test/style files.
- Existing Chrome rendered the actual progress component and CSS with JSON exported by the disposable route test. Current scope shows no recorded trades; explicitly including earlier matching revisions shows two finalized transactions, one buy/one partial sell,0/1 completed loops and0.00000015 SOL volume. The breakdown separates0.0000001 buy spending and0.00000005 sell proceeds, while fees/rent remain in the existing performance panel.
- Desktop width1920 has equal client/scroll width. Phone375x812 has document client/scroll360/360, summary278/278 and a44px breakdown control. Local screenshots: work/wallet-activity-browser-20261020/activity-desktop.jpg and activity-phone.jpg. The browser viewport and original Proxima reference were restored.
- Final isolated production build uses bc504dc plus the10 source/test/style overlays. It passed with exit0 and unchanged source hashes. No production or live-provider verification is claimed.

Proxima documents per-wallet progress, transaction count and volume in https://docs.proxima.tools/wallets/generate-activity/. Automatic warmup sessions, cancellation of such sessions and alternative routing remain open. Existing exact per-transaction approval, signing, submission and recovery safeguards are unchanged. Full Proxima parity remains unproven.
