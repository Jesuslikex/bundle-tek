import { createClient, MicroLamports } from '@solana/kit';
import { walletSigner } from '@solana/kit-plugin-wallet';
import { solanaRpc } from '@solana/kit-plugin-rpc';
import { memoProgram } from '@solana-program/memo';

const rpcUrl = process.env.NEXT_PUBLIC_SOLANA_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const rpcSubscriptionsUrl = process.env.NEXT_PUBLIC_SOLANA_DEVNET_WS_URL ?? 'wss://api.devnet.solana.com';

export function createAppClient() {
  return createClient()
    .use(walletSigner({ chain: 'solana:devnet' }))
    .use(solanaRpc({
      rpcUrl,
      rpcSubscriptionsUrl,
      transactionConfig: { microLamportsPerComputeUnit: 1_000n as MicroLamports },
    }))
    .use(memoProgram());
}

export type AppClient = ReturnType<typeof createAppClient>;
