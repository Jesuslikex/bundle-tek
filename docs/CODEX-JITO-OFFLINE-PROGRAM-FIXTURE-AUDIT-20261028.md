# Jito offline program fixture audit

28 October 2026. This read-only local audit searched the Jito fixtures, program-review documentation and retained Jito program-artifact directories for bytes that could exercise the current pinned runtime policy without a provider request. It did not read credentials, call a provider, copy binaries, change application code or authorize signing or submission.

The following sizes and full-file SHA-256 hashes were independently recomputed from the local files. The current policy values below come from `lib/pair-trusted-programs.ts` in the audited checkout.

| Artifact | Retained size | Retained full-file SHA-256 | Current program policy SHA-256 | Result |
| --- | ---: | --- | --- | --- |
| Jupiter v6, `jito-program-artifacts-20261024/jupiter.so` and `jito-program-review-20261025/jupiter.so` | 2,892,224 bytes each | `0394bfa4311fac40dd3d32e431ab2f541227e6c32923715455cfac58e4004d30` | `099da3a26d336aa7174960f057546f192fc1ccda8e3e9d1b4aa5c69fa8a79a5f` | Differs; current policy must refuse it. |
| Token-2022, `jito-program-review-20261025/token2022.so` | 1,382,016 bytes | `15a2e615a42e20f31714bbaaee43002ae6f1cda2e8d7118243117ab3c1342e2d` | `0999dbf708971e723b08d1caafc988826a59c6001ed6dc02260da07defbe1469` | Differs; current policy must refuse it. |
| Official Token-2022 v11.1.0 release artifact, `jito-program-review-20261025/official-token2022-v11.1.0.so` | 611,056 bytes | `3dde54d202caa2d10514fd58a154df5f26f07643f9f5fd0402ff08084f0cb954` | `0999dbf708971e723b08d1caafc988826a59c6001ed6dc02260da07defbe1469` | Differs in size and digest; it is not the pinned full padded program image. |
| Tess, `jito-program-artifacts-20261024/tess.so` | 576,932 bytes | `82fd37995fcece47a253b1a00c1dd7e4c3fff706b2e42384110e2cbabf4201b3` | No matching program entry in the current policy | Not admitted by the current policy. |

The artifact folders above are under `C:/Users/Julian/Desktop/Bundle/work/release-qa/` and are ignored local QA storage. `docs/CODEX-JITO-PROGRAM-ARTIFACTS-20261024.json` records their historical extraction context and constraints; `docs/CODEX-JITO-PROGRAM-REVIEW-20261025.md` documents the later review and the official Token-2022 artifact comparison. Those records describe historical provider-reported data assembled from chunks, not an atomic capture, current-source proof, independent Jupiter build verification or provider attestation. This audit rehashed the files; it did not independently reconstruct the original captures or verify their origin.

The available local Jupiter review does not establish a license permitting redistribution of its binary. No license conclusion follows from its presence in local QA storage. The Token-2022 review identifies an official release source, but this audit did not verify redistribution terms for either file.

The current full-swap synthetic composition replaces the runtime scanner; the real-runtime full-swap test demonstrates a policy refusal. The separate native-System runtime fixture is not a Jupiter swap. The located images can support historical mismatch and refusal tests, but cannot establish a passing real-policy Jupiter composition. Their existence does not justify changing a pin, loosening runtime checks, claiming a current code identity, or declaring a positive Jito qualification.
