import {
  balanceRpc,
  SOLANA_MAINNET_GENESIS,
  WalletRpcError,
} from './wallet-balances';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import { walletAddress } from './wallet-workspace';
import {
  TOKEN_PROGRAMS,
  HoldingsReadError,
  type TokenHolding,
} from './wallet-holdings';
import { formatNativeBalance } from './wallet-balance-format';
import { tokenExtensionNames } from './token-extension-names';
export type MintHoldingsSnapshot = {
  format: 'solana-mint-holdings-v1';
  scope: 'mint';
  chain: 'Solana';
  address: string;
  mint: string;
  program: string;
  decimals: number;
  raw: string;
  frozenRaw: string;
  unfrozenRaw: string;
  amount: string;
  accounts: TokenHolding['accounts'];
  accountCount: number;
  mintSlot: number;
  slot: number;
  slots: number[];
  observedAt: string;
  source: string;
  commitment: 'confirmed';
  mintExtensions: string[] | null;
};
const object = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid mint holdings data.');
  return value as Record<string, unknown>;
};
function uint(value: unknown, max: bigint) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > max
  )
    throw new Error('Invalid mint holdings integer.');
  return BigInt(value);
}
export async function observeWalletMintHoldings(
  address: string,
  mint: string,
  decimals: number,
  signal: AbortSignal = AbortSignal.timeout(25000),
  fetcher: typeof fetch = fetch,
  options: { pagination?: 'helius-v2' } = {},
): Promise<MintHoldingsSnapshot> {
  address = walletAddress(address, 'Solana');
  mint = walletAddress(mint, 'Solana');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)
    throw new Error('Invalid mint precision.');
  const endpoint = getSolanaIndexerRpcEndpoint(),
    source = new URL(endpoint).hostname;
  const rpc = async (method: string, params: unknown[]) => {
    try {
      return await balanceRpc(endpoint, method, params, signal, fetcher);
    } catch (error) {
      throw new HoldingsReadError(
        method,
        source,
        error instanceof WalletRpcError ? error.status : null,
        error instanceof Error &&
          error.message === 'Balance response too large.'
          ? 'RESULT_TOO_LARGE'
          : undefined,
      );
    }
  };
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Mint holdings provider network differs.');
  const metadata = object(
    await rpc('getAccountInfo', [
      mint,
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]),
  );
  const mintSlot = Number(
      uint(object(metadata.context).slot, BigInt(Number.MAX_SAFE_INTEGER)),
    ),
    account = object(metadata.value),
    parsed = object(object(account.data).parsed),
    info = object(parsed.info);
  const program = account.owner;
  if (
    typeof program !== 'string' ||
    !TOKEN_PROGRAMS.includes(program as (typeof TOKEN_PROGRAMS)[number]) ||
    account.executable !== false ||
    parsed.type !== 'mint' ||
    info.isInitialized !== true ||
    Number(uint(info.decimals, 255n)) !== decimals
  )
    throw new Error('Mint metadata differs from requested token.');
  const mintExtensions =
    program === TOKEN_PROGRAMS[0]
      ? []
      : info.extensions === undefined
        ? null
        : tokenExtensionNames(info.extensions);
  let values: unknown[] = [],
    slots: number[] = [];
  if (options.pagination === 'helius-v2') {
    if (source !== 'mainnet.helius-rpc.com')
      throw new Error('Mint pagination provider is unsupported.');
    let cursor: string | undefined;
    const cursors = new Set<string>();
    // Each response keeps the 512 KiB bound. The explicit paginated path can
    // enumerate up to 5,000 accounts without an unbounded provider response.
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const result = object(
        await rpc('getTokenAccountsByOwnerV2', [
          address,
          { mint },
          {
            encoding: 'jsonParsed',
            commitment: 'confirmed',
            minContextSlot: mintSlot,
            limit: 50,
            ...(cursor ? { paginationKey: cursor } : {}),
          },
        ]),
      );
      const pageSlot = Number(
        uint(object(result.context).slot, BigInt(Number.MAX_SAFE_INTEGER)),
      );
      const page = object(result.value);
      if (
        pageSlot < mintSlot ||
        pageSlot > mintSlot + 150 ||
        (slots.length > 0 && pageSlot < slots[slots.length - 1]) ||
        !Array.isArray(page.accounts) ||
        page.accounts.length > 50 ||
        values.length + page.accounts.length > 5000
      )
        throw new Error('Mint account coverage or slots differ.');
      slots.push(pageSlot);
      values.push(...page.accounts);
      if (page.paginationKey === null) break;
      if (
        typeof page.paginationKey !== 'string' ||
        !page.paginationKey.length ||
        page.paginationKey.length > 4096 ||
        cursors.has(page.paginationKey) ||
        page.accounts.length === 0 ||
        pageNumber === 99
      )
        throw new Error('Mint pagination is incomplete or invalid.');
      cursors.add(page.paginationKey);
      cursor = page.paginationKey;
    }
  } else {
    const result = object(
      await rpc('getTokenAccountsByOwner', [
        address,
        { mint },
        {
          encoding: 'jsonParsed',
          commitment: 'confirmed',
          minContextSlot: mintSlot,
        },
      ]),
    );
    const slot = Number(
      uint(object(result.context).slot, BigInt(Number.MAX_SAFE_INTEGER)),
    );
    if (
      slot < mintSlot ||
      slot > mintSlot + 150 ||
      !Array.isArray(result.value) ||
      result.value.length > 500
    )
      throw new Error('Mint account coverage or slots differ.');
    slots = [slot];
    values = result.value;
  }
  const slot = slots[slots.length - 1];
  const accounts: TokenHolding['accounts'] = [],
    seen = new Set<string>();
  let raw = 0n,
    frozenRaw = 0n;
  for (const value of values) {
    const row = object(value),
      publicKey = walletAddress(row.pubkey, 'Solana'),
      a = object(row.account),
      data = object(a.data),
      parsedAccount = object(data.parsed),
      i = object(parsedAccount.info),
      tokenAmount = object(i.tokenAmount);
    if (
      seen.has(publicKey) ||
      a.owner !== program ||
      a.executable !== false ||
      parsedAccount.type !== 'account' ||
      i.owner !== address ||
      i.mint !== mint ||
      !['initialized', 'frozen'].includes(String(i.state)) ||
      Number(uint(tokenAmount.decimals, 255n)) !== decimals
    )
      throw new Error('Mint account identity, state or precision differs.');
    seen.add(publicKey);
    const units = uint(tokenAmount.amount, (1n << 64n) - 1n);
    raw += units;
    if (raw > (1n << 64n) - 1n)
      throw new Error('Mint holdings exceed supported aggregate units.');
    const frozen = i.state === 'frozen';
    if (frozen) frozenRaw += units;
    accounts.push({
      address: publicKey,
      raw: units.toString(),
      frozen,
      extensions: program === TOKEN_PROGRAMS[1],
      extensionTypes:
        program === TOKEN_PROGRAMS[0]
          ? []
          : i.extensions !== undefined
            ? tokenExtensionNames(i.extensions)
            : data.space === '165'
              ? []
              : null,
    });
  }
  return {
    format: 'solana-mint-holdings-v1',
    scope: 'mint',
    chain: 'Solana',
    address,
    mint,
    program,
    decimals,
    raw: raw.toString(),
    frozenRaw: frozenRaw.toString(),
    unfrozenRaw: (raw - frozenRaw).toString(),
    amount: formatNativeBalance(raw.toString(), decimals),
    accounts,
    accountCount: accounts.length,
    mintSlot,
    slot,
    slots,
    observedAt: new Date().toISOString(),
    source,
    commitment: 'confirmed',
    mintExtensions,
  };
}
