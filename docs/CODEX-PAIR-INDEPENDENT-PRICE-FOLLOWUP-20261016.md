# Independent stock price review follow-up

## Separate missing-price consent

A missing independent market comparison now requires its own initially unchecked checkbox with the exact text: “No independent price check is available for this order.” It is separate from exact-order consent and from the worse-than-2% acknowledgement. Requoting, context changes, expiry and a completed authorization attempt clear or invalidate it. The server accepts only an explicit boolean, bound inside the exact hashed authorization consent; missing, false, null, numeric and string acknowledgements fail when the comparison is unavailable.

New additive migration `0091_pair_order_independent_price_consent` adds a second BEFORE INSERT authorization trigger. Existing ownership, immutable reviews, one authorization per review and maximum five-second rules are not rewritten. The trigger treats missing/false/malformed availability as unavailable and requires a literal JSON `true` acknowledgement. No historical migration is edited or remotely applied.

Initial verification: four review/service/authorization/panel files pass 65 tests, including raw local-SQL insert refusal for missing/false/nonboolean acknowledgement, server consent refusal, separate UI checks and reset behavior. Full migration and combined verification follow after server quote pricing and selected-market handling. Stock signing remains hard-disabled. No push or deploy.
