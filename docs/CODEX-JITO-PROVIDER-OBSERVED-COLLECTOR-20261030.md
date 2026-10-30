# Separate unsigned provider-observed collector

Implementation checkpoint after user approved pursuing the proposed practical
design. New collectJitoProviderObservedAttempt entry in the existing prefee
module shares original transport, exact wire binding, independent message fee
parser and complete raw frame verifier. It forces single-batch observation and
refuses signature verification mode or nonzero signature material before I/O.
No production caller, environment switch, HTTP/UI or signing integration.

The separate profile allows independent fee observations at a different fresh
context than the simulation. Every fee still needs the same context as other
fee observations, appropriate floor and original F..F+32 span. No fee amount
tolerance: simulation must equal independently observed fee and remain within
the original reviewed cap. All raw frame/account/ALT/continuity/conservation,
replacement and metadata checks are reused unchanged. Both actual contexts and
wire observations remain retained. No fabricated exact-slot replay is sent.

Strict entry remains the default wrapper with the original equal-slot rules.
New output is explicitly provider-observed-jito-v1, providerTrustRequired true,
bankIdentityVerified/feeBankIdentityVerified false. Existing authority flags
remain false, including providerQualified/signingAllowed/executionAllowed.
This is lower provenance assurance by explicit design; not same-bank proof.

Supporting tests run both paths against identical controlled data: strict
refuses102fee/101simulation while new path captures, exactly one batch each.
Additional refusals cover fee disagreement/cap/staleness/33slots, stale window,
partial frames/missing account/replacement hash/429 and signed inputs. The test
fixture initially cloned opaque display-decimal tokens and lost their parser
identity; corrected fixture preservation, no parser guard changed.

Final Node24 verification:244tests/fivefiles, plain TypeScript, scoped typed lint
and formatting pass. No live request was made for this collector. Previous
Helius native capability observations are historical supporting evidence only.
Full code/asset bracket composition, fixed unsigned live samples, owned review
and recovery remain before any proposed signing work. Current signing gates,
providers, source policies, other-agent drafts and deployment state unchanged.
