declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SOLANA_DEVNET_RPC_URL?: string;
    SOLANA_MAINNET_RPC_URL?: string;
    SOLANA_INDEXER_RPC_URL?: string;
    SOLANA_STOCK_RUNTIME_RPC_URL?: string;
    SOLANA_HOLDER_RPC_URL?: string;
  }
}
