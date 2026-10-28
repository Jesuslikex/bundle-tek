# Explicit Helius native Jito diagnostic, 28 October 2026

The native-only qualification harness supports an explicit `--helius` selection of the existing mainnet Helius RPC setting. This selection has no automatic fallback. The Alchemy/public default, exact-bank checks, original F..F+32 window, ordinary pacing, fixed three-attempt scope and first-429 stop remain unchanged. Helius diagnostics never set provider qualification or signing/execution authority, including after three synthetic successes. No saved provider setting, credential, hosted state or deployment was changed.

One fixed `--helius --prefee` run exercised unsigned zero-value native transfers with the existing endpoint. There were three attempts and no replacement attempt, signature or broadcast:

| Attempt | Result | Original F | Account slot | Simulation bank |
| --- | --- | --- | --- | --- |
| 1 | Refused: discovery bank 462561365, both fee banks 462561366 | 462561361 | 462561362 | Not admitted |
| 2 | Native frames captured, final genesis matched | 462561367 | 462561368 | 462561371 |
| 3 | Native frames captured, final genesis matched | 462561375 | 462561376 | 462561379 |

The two captures show this particular provider and request profile can sometimes return matching fee and simulation banks. The refusal remains part of the sample: **2/3 is not repeatable qualification**. These native transfers are not a swap or economic/runtime proof. Exact request/response evidence is retained privately in ignored `work/release-qa/jito-native-prefee-helius-20261028/`; do not publish endpoint credentials or raw private material. The earlier Alchemy and legacy attempts remain separate evidence.

The native harness change passed 28 Node 24 tests, scoped lint and formatting. Independent review found no blocker in the explicit host, 429 and authority checks. No full repository suite, production build, actual swap simulation or funded execution is implied. Continue reviewing program provenance and provider availability without relaxing any bank, 32-slot, custody or signing rule.
