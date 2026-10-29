# Alchemy nonempty native sample, 29 October 2026

The existing prefee native campaign ran three fixed attempts against the
existing Alchemy holder endpoint. Configuration was read in memory; no
credential file was copied, created, changed or deleted. The exported
production adapter and campaign were used unchanged, preserving configured
pacing, the original 32-slot window, exact-bank checks and first-429 stop.
No additional replacement attempt was run.

| Attempt | Original floor | Account slot | Result |
| --- | ---: | ---: | --- |
| 1 | 462684676 | 462684677 | Refused: bank-unavailable |
| 2 | 462684683 | 462684684 | Refused: bank-unavailable |
| 3 | 462684690 | 462684691 | Native capture at bank 462684694, floor +4 |

All attempts submitted nonempty unsigned, zero-value System-transfer packets
to simulation only. The first two used five HTTP requests each; the third used
six including the final genesis check. The report records zero signatures
created and zero broadcasts. The bank-unavailable refusals are retained;
they are not successful simulations or a reason to loosen bank checks.

One native capture in three is not repeatable qualification. This does not
prove a Jupiter swap, pinned program identity, token economics, custody across
a swap, exact signed-vector qualification, or final submit admission. Every
qualification/signing/execution authority flag remains false. The draft API
submission block remains unchanged. No deployment or hosted mutation occurred.

Private source snapshots, request/response evidence and campaign report remain
in ignored work/release-qa/jito-alchemy-native-20261029-1793234950090/. They are
not published. This note intentionally excludes endpoint credentials and raw
transaction material.
