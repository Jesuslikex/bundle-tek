# QuickNode stock-runtime Production setting

The user authorized creating a free Solana Mainnet endpoint in their signed-in QuickNode account, keeping the HTTP URL private, saving it as Production `SOLANA_STOCK_RUNTIME_RPC_URL` for Vercel `bundle-tek`, and redeploying. This supersedes the prior no-provider-configuration boundary for this one setting only. No other provider, credential, cron, database or signing change was authorized or made.

## Configuration and deployment

- QuickNode endpoint 675871, displayed as `bold-necessary-arm`, is Active on Solana Mainnet. The selected Free trial is $0, one month, 10M credits, 15 requests/second, no overage and no card required. No paid plan or add-on was selected. This is a time-limited trial, not a permanent free production plan.
- Vercel project `prj_Fy1IRrsW0JQIpIUoRezo4ttgHZXS`, team `team_M6GTUdujU7FPO7CZq29qETrG`: `SOLANA_STOCK_RUNTIME_RPC_URL` is saved as Sensitive, Production only. Metadata verification found no changes to unrelated environment-variable IDs/keys/types/targets/update times. Preview, Development and local provider configuration were not altered.
- The URL was transferred through an ignored temporary file and the authenticated CLI's standard input, never a command argument or committed file. The temporary transfer file was removed after checks. No URL/key is included in this note or receipts.
- Configuration-only production redeploy: `dpl_FbmX1qdqSxwHxV3h6QhCeGciChyY`, READY, unique URL https://bundle-l3d2trj6d-jesuslikexs-projects.vercel.app/ . The API used existing production deployment `dpl_C2jmmfnfpKq7DrJjXjfMbaReXFho` as its source with `withLatestCommit: false`. It uploaded no local source, dirty files or new Counter commits. The final aliases include https://bundle-tek.vercel.app/ . No migration command was issued.

The remote metadata does not identify a source Git commit. Its truncated source inventory could not establish whether that historical release contains the latest stock-only runtime selector. This redeploy establishes the Production setting/release status, not application routing through it or completion of the new stock implementation. Releasing newer local code remains separate work.

## Bounded verification

The corrected read-only probe made three calls: getGenesisHash, confirmed getSlot, and a floor-bound getMultipleAccounts for two actual Clock accounts. Mainnet genesis matches the repository constant; duplicates agree exactly; response context and Clock both equal slot 457739709; the observed wall-time skew was 750 ms, inside the unchanged 30-second bound. No signature, wallet or transaction was used. An initial ad hoc check refused because its expected genesis string was accidentally truncated; the corrected probe reads the canonical constant from source. This was a probe correction, not a provider/network rule change.

Anonymous production checks after READY: `/` and `/sign-in` return HTML200; `/api/launch/pump/groups` returns JSON401. No signed-in workflow was exercised. Sanitized local receipts are `work/quicknode-stock-setup-check.json` and `work/quicknode-production-http.json`. A screenshot of the endpoint list, without its access URL, is `work/quicknode-setup-active.png`.

This does not qualify SOL/USDC stock pairs, Clock behavior across a campaign, route support, latency, or repeatability. The fixed three-per-asset qualification is still pending. Keep the 32-slot bound, final code recheck, batch/byte/pacing checks and stock signing gate unchanged. No wallet unlock, signing, broadcast, SQL, cron, remote Git push, paid upgrade or Claude-owned source edit. Main's two unrelated dirty files remain byte-identical. The independent Counter exclusion diagnostic is a separate local commit and was not deployed here.
