# Jito bank profile diagnosis, 24 October 2026

Base: `464bb66`. This supersedes the numeric-only request recommendation in the preceding checkpoint. The source fix is unmounted and grants no signing/execution authority.

## Corrected conclusion

Pinned upstream sources disagree. The [Rust enum](https://github.com/jito-foundation/jito-solana/blob/a3f2fe92c1166c7ec9f21a3655b37877fe1279a3/rpc-client-api/src/bundles.rs) uses an externally tagged slot object; the [TypeScript SDK](https://github.com/jito-labs/jito-ts/blob/7a0f569336cd1720edbe3282ce00d171350b30ae/src/sdk/rpc/connection.ts) declares a bare number. It was incorrect to treat that SDK declaration as universal provider behavior. The [Rust handler](https://github.com/jito-foundation/jito-solana/blob/a3f2fe92c1166c7ec9f21a3655b37877fe1279a3/rpc/src/rpc/bundles.rs) can also return invalid-params when a correctly selected bank is absent from its live bank forks. RPC -32602 alone cannot distinguish those cases.

The request builder now requires an explicit `bankEncoding`: `slot-object` or `numeric-slot`. There is no default, automatic detection, retry or alternate-bank/provider fallback. Both encode the same independently selected exact slot. Returned-bank equality, 32-slot span, original bytes/blockhash, ordered full vectors, signature mode and all authority flags remain unchanged. No production caller currently uses this builder.

## Fixed bounded diagnosis

One explicit two-profile diagnostic used the existing Alchemy holder endpoint and the established public reference payer. It used seven read-only RPC calls: genesis, latest blockhash, public account observation, two exact-message fees, then the two planned simulation forms. This was a fixed comparison, not a production retry/fallback. No signatures or broadcasts; transfer amounts were zero. Settings and credentials were unchanged.

Both independent fees were **5000 lamports at slot 460665204**.

| Requested bank form  | Observed result                                                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `{"slot":460665204}` | HTTP200, summary succeeded, exact returned slot460665204, two frames, both err null, each fee5000, units150, loaded account data221, three pre and three post accounts, empty actual loaded-address vectors. |
| `460665204`          | HTTP200 / RPC-32602: `Invalid params: invalid type: integer ... expected string or map.`                                                                                                                     |

The safe record retains request/response digests, fee contexts/values, cardinalities and field names. A bounded diagnostic error message was redacted for endpoint/path/query credentials, URLs and long tokens before retention. Raw complete account vectors were not retained, so this record does **not** establish mathematical frame replay, code identity or a fully qualified vendor profile. It identifies the accepted bank encoding for this actual endpoint on this attempt. The earlier object-bank refusal and failed tip-bank sample remain historical outcomes, not overwritten or relabeled.

The successful response actually contained fee, loadedAddresses, loadedAccountsDataSize, replacementBlockhash, balance/token arrays, logs/returnData and raw account metadata (`rentEpoch`, `space`). **The current normalized verifier would reject that raw response**, because it intentionally refuses those extra vendor fields/account metadata. A strict bounded vendor adapter can now be developed against the observed fields and pinned Rust schema, validating ancillary metadata before projection and refusing missing/inconsistent/unknown evidence. It must retain full raw response/source bindings and prove fee/ALT provenance, runtime and exact signed replay before integration. Context key names were not retained, so context metadata remains unqualified too.

The diagnostic source requested `skipSigVerify:true` and `replaceRecentBlockhash:false`; the safe outcome record preserves request digests rather than the full request/config. This is source-level verification of the controls, not independently retained raw-wire proof. A later capture must bind original request/response bytes and all controls.

## Verification and boundaries

The exact-wire and economic cohort passes **188 tests across two files**, zero failures/skips. Project TypeScript, scoped typed lint and formatting pass. The JSON proof compares the source AST outside the request builder against the base commit so unchanged frame admission is independently checked. No new production build or full-suite claim.

Helpers researched pinned sources and existing fee/ALT boundaries read-only. The source audit also found an aggregate fixture limitation: its multi-wallet ALT messages originally referred to one table address while assuming different per-wallet bytes. The mathematical replay does not admit raw ALT sources and retains false ALT authority, so its existing positive tests cannot prove lookup provenance. A separate fixture/source correction is required before using it as a full same-bank source test.

Actual authenticated Claude Opus5.5 completed a six-file source-only review with Read/Glob/Grep, zero permission denials/edits/tests and unchanged copied sources. It found no blocking builder regression, confirmed no default/fallback and unchanged exact-bank/32-slot checks, and highlighted the raw-vendor/normalized-verifier incompatibility. That limitation and unretained request/context metadata are now explicit above. Final code matches the review copy. The reviewer did not run tests or call providers; Codex independently ran the verification.

Only the unmounted builder/test and owned handoff are changed. AGENTS.md and seven excluded warmup draft files remain intact. No deployment, application/hosted SQL, migration, provider/credential/cron setting change, real wallet unlock/sign/send, strategy run or funded trade. Next free migration remains0147 subject to recheck. Full Jito and product parity remain unproven.
