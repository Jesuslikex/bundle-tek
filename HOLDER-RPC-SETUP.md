# Bundle holder RPC setup

Completed 12 October 2026 with explicit user approval. The app and ignored local holder endpoint are active. One bounded live API verification passed: 20 validated sampled holder rows from four successful read-only RPC requests. Only Solana Mainnet and Node API are enabled. Existing Helius settings were preserved. See PRODUCT-PARITY.md and work/live-provider-qa/holder-read-report.json for the completion record. The steps below retain the preparation and verification plan.

## Proposed provider

Alchemy, existing signed-in team, existing Free plan ($0/month). App name: Bundle Holder Reads. Description: Read-only sampled token holder analysis for Bundle. Use case: DeFi. Enable Solana Mainnet with standard Node RPC only. Stop if the wizard requires a paid service or new binding terms.

Official method documentation: https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/get-token-largest-accounts
Official Free tier documentation: https://support.alchemy.com/articles/5827006872-what-is-included-in-the-free-tier

These documents identify a candidate, not a successful live verification. The method samples at most 20 token accounts; this does not provide complete holder indexing.

## Local integration

Save the app's HTTPS Solana Mainnet RPC endpoint only in C:\Users\Julian\Desktop\Bundle\.env.local as SOLANA_HOLDER_RPC_URL. Check that file remains ignored before writing. Never print the endpoint or key, put it in a screenshot/report, or commit it. Existing Helius balance, indexer and signing settings stay unchanged.

The supply analysis route now uses a dedicated server-only holder selector. Absent configuration preserves the existing indexer fallback. Invalid explicit configuration rejects rather than silently using another provider. HTTPS is required, with no URL user-info or fragment.

## Verification after approval

Run exactly one bounded opt-in holder QA against the actual supply API with public USDC mint and no excluded wallets. Allowed methods are getGenesisHash, getTokenSupply, getTokenLargestAccounts and getMultipleAccounts. Verify mainnet, complete metadata, account owners, amounts and slot consistency. Require API 200 with validated sampled holder rows. Save only sanitized method/status/error codes, holder count, slot and raw supply in work/live-provider-qa/holder-read-report.json. Never report a failed success assertion as a pass.

Existing Helius returned JSON-RPC -32600 at getTokenLargestAccounts. The public fallback returned HTTP 403 at getTokenSupply. Both live checks failed and returned no holder rows. No credential or .env setting has been changed during preparation.

If Alchemy verification fails, remove only the newly added holder setting and report the exact sanitized failure. Do not purchase upgrades or retry unchanged endpoints repeatedly. No trades, signatures, transaction broadcasts, production deployment or database changes are part of this setup.

## Preparation checks

Dedicated selector and route tests: 8 passed. TypeScript and production build passed. Creation form is staged in the user's existing Chrome session; no Next/Create action has been submitted and no new API key exists yet.
