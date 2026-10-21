import {
  balanceRpc,
  SOLANA_MAINNET_GENESIS,
  WalletRpcError,
} from './wallet-balances';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import { walletAddress } from './wallet-workspace';
import { formatNativeBalance } from './wallet-balance-format';
import { tokenExtensionNames } from './token-extension-names';
import {
  HoldingsBatchError,
  type HoldingsBatchCode,
} from './holdings-batch-error';

export const TOKEN_PROGRAMS = [
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
] as const;
export class HoldingsReadError extends Error {
  constructor(
    public readonly method: string,
    public readonly host: string,
    public readonly status: number | null,
    public readonly code?: HoldingsBatchCode,
  ) {
    super('Token holdings provider request failed.');
  }
}
export type TokenHolding = {
  mint: string;
  program: string;
  raw: string;
  amount: string;
  decimals: number;
  accounts: {
    address: string;
    raw: string;
    frozen: boolean;
    extensions: boolean;
    extensionTypes?: string[] | null;
  }[];
};
export type HoldingsSnapshot = {
  chain: 'Solana';
  address: string;
  holdings: TokenHolding[];
  accountCount: number;
  slots: { program: string; slot: number }[];
  minSlot: number;
  maxSlot: number;
  observedAt: string;
  source: string;
  commitment: 'confirmed';
};
function uint(value: unknown, max: bigint) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > max
  )
    throw new Error('Invalid token-account integer.');
  return value;
}
export async function observeWalletHoldings(
  address: string,
  signal: AbortSignal = AbortSignal.timeout(25000),
  fetcher: typeof fetch = fetch,
  minimumSlot = 0,
): Promise<HoldingsSnapshot> {
  if (!Number.isSafeInteger(minimumSlot) || minimumSlot < 0)
    throw Error('Invalid holdings slot floor.');
  address = walletAddress(address, 'Solana');
  const endpoint = getSolanaIndexerRpcEndpoint();
  const rpc = async (method: string, params: unknown[]) => {
    try {
      return await balanceRpc(endpoint, method, params, signal, fetcher);
    } catch (error) {
      throw new HoldingsReadError(
        method,
        new URL(endpoint).hostname,
        error instanceof WalletRpcError ? error.status : null,
        error instanceof HoldingsBatchError ? error.code : undefined,
      );
    }
  };
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Holdings provider network mismatch.');
  const baseline = Number(
    uint(
      await rpc('getSlot', [
        {
          commitment: 'confirmed',
          ...(minimumSlot > 0 ? { minContextSlot: minimumSlot } : {}),
        },
      ]),
      BigInt(Number.MAX_SAFE_INTEGER),
    ),
  );
  if (baseline < minimumSlot)
    throw Error('Holdings observation predates the required receipt.');
  const snapshots = await Promise.all(
    TOKEN_PROGRAMS.map(async (program) => {
      const result = (await rpc('getTokenAccountsByOwner', [
        address,
        { programId: program },
        {
          commitment: 'confirmed',
          encoding: 'jsonParsed',
          minContextSlot: baseline,
        },
      ])) as { context?: { slot?: unknown }; value?: unknown };
      const slot = Number(
        uint(result?.context?.slot, BigInt(Number.MAX_SAFE_INTEGER)),
      );
      if (slot < baseline || slot > baseline + 150)
        throw new Error('Token-account observation slots are inconsistent.');
      if (!Array.isArray(result?.value) || result.value.length > 500)
        throw new Error(
          'Token-account enumeration exceeds the supported limit.',
        );
      return { program, slot, accounts: result.value };
    }),
  );
  const holdings = new Map<string, TokenHolding>();
  const seen = new Set<string>();
  for (const snapshot of snapshots)
    for (const row of snapshot.accounts) {
      const accountAddress = walletAddress(row?.pubkey, 'Solana');
      if (seen.has(accountAddress))
        throw new Error('Duplicate token account in provider response.');
      seen.add(accountAddress);
      const parsed = row?.account?.data?.parsed;
      const info = parsed?.info;
      if (
        row?.account?.owner !== snapshot.program ||
        row?.account?.executable !== false ||
        parsed?.type !== 'account' ||
        info?.owner !== address ||
        !['initialized', 'frozen'].includes(info?.state)
      )
        throw new Error(
          'Token account does not match the requested owner and program.',
        );
      const mint = walletAddress(info?.mint, 'Solana');
      const raw = uint(info?.tokenAmount?.amount, (1n << 64n) - 1n);
      const decimals = Number(uint(info?.tokenAmount?.decimals, 255n));
      const key = snapshot.program + '/' + mint;
      const holding = holdings.get(key) ?? {
        mint,
        program: snapshot.program,
        raw: '0',
        amount: '0',
        decimals,
        accounts: [],
      };
      if (holding.decimals !== decimals)
        throw new Error('Inconsistent decimals for a token mint.');
      holding.raw = (BigInt(holding.raw) + BigInt(raw)).toString();
      holding.amount = formatNativeBalance(holding.raw, decimals);
      holding.accounts.push({
        address: accountAddress,
        raw,
        frozen: info.state === 'frozen',
        extensions: snapshot.program === TOKEN_PROGRAMS[1],
        extensionTypes:
          snapshot.program === TOKEN_PROGRAMS[0]
            ? []
            : info.extensions !== undefined
              ? tokenExtensionNames(info.extensions)
              : row.account.data.space === '165'
                ? []
                : null,
      });
      holdings.set(key, holding);
    }
  const slots = snapshots.map(({ program, slot }) => ({ program, slot }));
  return {
    chain: 'Solana',
    address,
    holdings: [...holdings.values()].sort((a, b) =>
      a.mint.localeCompare(b.mint),
    ),
    accountCount: seen.size,
    slots,
    minSlot: Math.min(...slots.map((s) => s.slot)),
    maxSlot: Math.max(...slots.map((s) => s.slot)),
    observedAt: new Date().toISOString(),
    source: new URL(endpoint).hostname,
    commitment: 'confirmed',
  };
}
