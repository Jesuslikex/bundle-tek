# Volume Bot USD target scope

Work is isolated on codex/volume-usd-targets from 88fdc2b while the other Bundle chat builds main. No credentials/environment copied. Existing provider adapter observes Solana native mint in USD; conversion must be server captured, immutable, fresh at estimate/create and exact in the saved plan. USD is converted to a fixed SOL turnover target, explicitly reviewed, not a guarantee of future USD volume. Existing spend, batch signing, custody, minimum-output and recovery gates remain.

Scope: exact conversion/evidence model, append-only 0102 retained quote/plan guards, authenticated same-origin quote action, estimate/create binding and UI/tests. No remote SQL, provider/credential changes, funded test, signing, push or deployment. The other chat confirmed no volume-file overlap. Main and its shared build/server remain untouched until integration is coordinated.
