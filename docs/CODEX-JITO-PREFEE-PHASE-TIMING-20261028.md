# Jito prefee phase timing

The opt-in unsigned native diagnostic now records bounded, non-authoritative timing for reading and parsing the provider's batch response, parsing the in-memory discovery member, fee projection and checks, and exact-request construction. Batch timing includes network body streaming, not just local parsing. Unreached phases or unavailable clocks report null. The diagnostic does not add RPC calls, retries, relaxed checks or authority.

Independent synthetic verification passed 28 collector tests and 30 native harness tests. It compares the full returned evidence with and without diagnostics, apart from the timing fields, as well as request order and bytes. The implementing agent also ran typed lint and formatting; an independent source review found no blocking issue. No live sample was run for this change, so these timings have not yet established a performance improvement.

Recent native-only provider samples remain inconsistent and do not establish full-swap qualification. Exact bank equality, original slot windows, simulation and signing safeguards remain in force. No real wallet action, broadcast, provider setting or deployment was used.
