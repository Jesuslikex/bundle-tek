import { getSolanaSnapshot } from '@/lib/solana-rpc';

export const dynamic = 'force-dynamic';

export async function GET() {
  const startedAt = new Date().toISOString();
  const [devnet, mainnet] = await Promise.allSettled([
    getSolanaSnapshot('devnet'),
    getSolanaSnapshot('mainnet'),
  ]);
  const normalize = (network: 'devnet' | 'mainnet', result: PromiseSettledResult<Awaited<ReturnType<typeof getSolanaSnapshot>>>) => {
    if (result.status === 'fulfilled') return result.value;
    const message = result.reason instanceof Error ? result.reason.message : 'RPC unavailable';
    return {
      network,
      status: 'degraded',
      error: network === 'devnet' && message.includes('authenticate')
        ? 'Private Devnet RPC required'
        : message,
    };
  };
  return Response.json({
    service: 'pulseforge-control-plane',
    mode: 'simulation-only',
    signing: 'locked',
    checkedAt: startedAt,
    networks: [normalize('devnet', devnet), normalize('mainnet', mainnet)],
  }, { headers: { 'cache-control': 'no-store' } });
}
