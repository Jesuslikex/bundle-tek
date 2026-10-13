# Current Proxima DCA controls, 13 October 2026

REA controlled browser scenarios exercised only the existing signed-in launch workspace's unsent Auto Sell configuration. They selected DCA and expanded End Conditions, Market Cap Range and Advanced Options. No amount, timing, wallet or slippage field was filled; Add Strategy, Run, Buy, Sell, export and signing controls were never clicked.

Fresh observed controls:

- DCA offers fixed or randomized sizing, an amount with a supply-percentage unit control, and an hours/minutes/seconds interval.
- Strategy-specific ending controls expose an optional maximum token amount and duration. The UI explains that these stop that strategy while other strategies continue.
- Market-cap bounds expose minimum and maximum inputs, initially zero and unbounded.
- Advanced options expose start delay, slippage and a wallet selector. Its session-wide end conditions expose maximum amount and duration, with UI text saying either condition stops the whole Auto Sell session when both are set.

This establishes current interface semantics, not the server's settlement, precise duration anchor, inclusive range boundaries, randomness distribution, amount accounting, custody, execution frequency or concurrency implementation. No runner was executed. The displayed absence of an active AutoSell session is a UI observation, not a complete backend audit.

Evidence and cleanup:

- `ev_4b324c750f3c9ce7488daeee83051671ce87618cb5bd0e28eb1c1b3e2f292dee`: end-condition form expansion. Its final Escape action completed but did not actually close the form; the retained accessibility state revealed that limitation.
- `ev_9dba68a2abdfa9af3c5e4f9a99dcabb9835538502e007150ef7fdf4f94dc30ab`: range/advanced controls, followed by the actual Close button. Final accessibility no longer contains the Auto Sell form heading.
- `ev_ec9fc265b6d32e42f43dd06b93cb3863f7b54b4956d6608e9c53d051db959414`: restored the originally open account route after inspection.

Complete inline form evidence is saved under `C:\Users\Julian\Desktop\REA\results\proxima-dca-controls-20261013\end-conditions.json` and `range-and-advanced.json`. Credentials, request/response bodies, header values and storage values were not captured or exported. The controlled provider reports incomplete event coverage; it does not prove a complete network trace. The existing external Chrome process remains open.

Bundle comparison: finite single-wallet budgets, per-cycle eligibility, explicit signing and an optional absolute deadline now exist. They are not the entire observed Proxima DCA configuration. Remaining concrete work includes separate strategy/session ending semantics, a duration convention grounded in captured start state, market-cap bounds rechecked at preparation/approval/submission, randomized amount rules, and integrated wallet selection. Preserve the user's encrypted-browser-vault and per-transaction approval requirements while implementing those behaviors. Do not infer Proxima custody or authorize unattended signing from these form controls.
