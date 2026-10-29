# Alchemy exact-bank refusal diagnosis

Read-only offline analysis of all three retained attempts in
`work/release-qa/jito-alchemy-native-20261029-1793234950090/`.
No new provider request, credential change, policy change or transaction occurred.

| Attempt | Both fee slots and discovery slot | Exact requested slot | Exact result | Discovery headers to exact request start |
| --- | ---: | ---: | --- | ---: |
| 1 | 462684680 | 462684680 | -32602, bank not found for the provided slot | 110.17 ms |
| 2 | 462684687 | 462684687 | -32602, bank not found for the provided slot | 116.51 ms |
| 3 | 462684694 | 462684694 | succeeded; response context 462684694 | 122.23 ms |

These values were extracted from each original batch response and exact request
and response, rather than inferred from the abbreviated campaign reason.
The decoder correctly identifies the exact documented refusal string and
retains failure. Both failed attempts had coherent discovery/fee evidence;
they failed when the provider could not serve the subsequent explicitly pinned
bank. The passing attempt had a slightly longer measured request gap, so these
three observations do not demonstrate that reducing client latency fixes it.

The responses do not identify the serving backend or fork. Node routing,
retention and fork changes are hypotheses, not proven causes. Matching numeric
slots in the first batch do not guarantee that the later request can retrieve
that bank. Do not change to tip, replace the requested slot, soften equality,
disable pacing, or repeat attempts until a favorable result occurs.

Before claiming repeatable qualification, establish a provider-supported way
to retain/retrieve the discovered bank or obtain all required evidence in one
coherent response, then implement and test that contract. Any alternative must
preserve exact packet binding, complete fee/account/runtime evidence, both code
checks and the original freshness window. Such a provider guarantee is not
established by the current documentation or these captures.

Full-swap qualification remains separately incomplete: the native System
transfer fixture does not exercise swap economics or pinned Jupiter/Token-2022
identity. The retained program artifacts differ from current policy pins, as
documented in CODEX-JITO-OFFLINE-PROGRAM-FIXTURE-AUDIT-20261028.md. No pins or
submission gates were changed. No deploy or funded action is authorized here.
