declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    SOLANA_DEVNET_RPC_URL?: string;
    SOLANA_MAINNET_RPC_URL?: string;
  }
}
