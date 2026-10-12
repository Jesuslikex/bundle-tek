import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { getSolanaIndexerRpcEndpoint } from './solana-rpc';
import {
  decodeHolderIndexPage,
  HOLDER_INDEX_PAGE_SIZE,
  type HolderIndexPage,
} from './holder-index';
import { TOKEN_PROGRAMS } from './wallet-holdings';
import { tokenExtensionNames } from './token-extension-names';
export async function observeHolderIndexPage(
  mint: string,
  page: number,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  previous: HolderIndexPage | null = null,
  method: 'das-cursor' | 'program-accounts-v2' = 'das-cursor',
) {
  const endpoint = getSolanaIndexerRpcEndpoint();
  const rpc = (method: string, params: unknown[] | Record<string, unknown>) =>
    balanceRpc(endpoint, method, params, signal, fetcher, 1_048_576);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Holder network differs.');
  if (
    previous &&
    (!previous.enumeration ||
      previous.nextCursor === null ||
      previous.nextCursor === undefined)
  )
    throw new Error('Start a fresh cursor-based holder scan.');
  const supply = (await rpc('getTokenSupply', [
    mint,
    { commitment: 'finalized' },
  ])) as { context: { slot: string } };
  const mintAccount = (await rpc('getAccountInfo', [
    mint,
    {
      commitment: 'finalized',
      encoding: 'base64',
      dataSlice: { offset: 0, length: 0 },
      minContextSlot: Number(supply.context.slot),
    },
  ])) as { value?: { owner?: string; executable?: boolean } };
  const program = mintAccount.value?.owner;
  if (
    !program ||
    !TOKEN_PROGRAMS.includes(program as (typeof TOKEN_PROGRAMS)[number]) ||
    mintAccount.value?.executable !== false
  )
    throw new Error('Mint token program unavailable.');
  if (previous?.tokenProgram && previous.tokenProgram !== program)
    throw new Error('Mint token program changed.');
  const cursor = previous?.nextCursor ?? null;
  const enumeration = previous?.enumeration ?? method;
  if (enumeration === 'das-cursor') {
    const result = (await rpc('getTokenAccounts', {
      mint,
      limit: HOLDER_INDEX_PAGE_SIZE,
      options: { showZeroBalance: false },
      ...(cursor ? { cursor } : {}),
    })) as {
      last_indexed_slot?: unknown;
      cursor?: unknown;
      token_accounts?: unknown[];
    };
    const decoded = decodeHolderIndexPage(
      result,
      supply,
      mint,
      page,
      new URL(endpoint).hostname,
    );
    const nextCursor = result.cursor ?? null;
    if (
      nextCursor !== null &&
      (typeof nextCursor !== 'string' ||
        !nextCursor ||
        nextCursor.length > 512 ||
        nextCursor === cursor)
    )
      throw new Error('Holder cursor failed to advance.');
    if (
      decoded.accounts.length === HOLDER_INDEX_PAGE_SIZE &&
      nextCursor === null
    )
      throw new Error('Full holder page lacks a continuation cursor.');
    return {
      ...decoded,
      enumeration,
      requestedCursor: cursor,
      nextCursor:
        decoded.accounts.length === 0 ? null : (nextCursor as string | null),
      tokenProgram: program,
    };
  }
  const result = (await rpc('getProgramAccountsV2', [
    program,
    {
      commitment: 'finalized',
      encoding: 'jsonParsed',
      withContext: true,
      minContextSlot: Number(supply.context.slot),
      limit: HOLDER_INDEX_PAGE_SIZE,
      filters: [{ memcmp: { offset: 0, bytes: mint } }],
      ...(cursor ? { paginationKey: cursor } : {}),
    },
  ])) as {
    context?: { slot?: unknown };
    value?: {
      accounts?: Array<{
        pubkey?: unknown;
        account?: {
          owner?: unknown;
          executable?: unknown;
          data?: {
            parsed?: {
              type?: unknown;
              info?: {
                mint?: unknown;
                owner?: unknown;
                state?: unknown;
                tokenAmount?: { amount?: unknown; decimals?: unknown };
                extensions?: unknown;
              };
            };
          };
        };
      }>;
      paginationKey?: unknown;
    };
  };
  const data = result?.value;
  if (
    !Array.isArray(data?.accounts) ||
    (data.paginationKey !== null &&
      (typeof data.paginationKey !== 'string' ||
        !data.paginationKey ||
        data.paginationKey.length > 512))
  )
    throw new Error('Holder cursor response unavailable.');
  if (data.paginationKey !== null && data.paginationKey === cursor)
    throw new Error('Holder cursor failed to advance.');
  const rows = data.accounts.map((row) => {
    const account = row.account,
      parsed = account?.data?.parsed,
      info = parsed?.info;
    if (
      account?.owner !== program ||
      account?.executable !== false ||
      parsed?.type !== 'account' ||
      !['initialized', 'frozen'].includes(String(info?.state))
    )
      throw new Error('Indexed token account layout differs.');
    let withheldRaw: string | undefined;
    if (program === TOKEN_PROGRAMS[1] && info?.extensions !== undefined) {
      const names = tokenExtensionNames(info.extensions);
      if (names.includes('transferFeeAmount')) {
        const fee = (
          info.extensions as Array<{
            extension: string;
            state?: { withheldAmount?: unknown };
          }>
        ).find((e) => e.extension === 'transferFeeAmount');
        const raw = fee?.state?.withheldAmount;
        if (
          typeof raw !== 'string' ||
          !/^(0|[1-9]\d{0,19})$/.test(raw) ||
          BigInt(raw) > (1n << 64n) - 1n
        )
          throw new Error('Indexed account withheld fees unavailable.');
        withheldRaw = raw;
      }
    }
    return {
      address: row.pubkey,
      mint: info?.mint,
      owner: info?.owner,
      amount: info?.tokenAmount?.amount,
      frozen: info?.state === 'frozen',
      ...(withheldRaw !== undefined ? { withheldRaw } : {}),
    };
  });
  const decoded = decodeHolderIndexPage(
    { last_indexed_slot: result.context?.slot, token_accounts: rows },
    supply,
    mint,
    page,
    new URL(endpoint).hostname,
  );
  if (
    decoded.indexedSlot < decoded.supplySlot ||
    data.accounts.some(
      (row) =>
        Number(row.account?.data?.parsed?.info?.tokenAmount?.decimals) !==
        decoded.decimals,
    )
  )
    throw new Error('Holder token precision or slot differs.');
  return {
    ...decoded,
    enumeration: 'program-accounts-v2' as const,
    requestedCursor: cursor,
    nextCursor: data.paginationKey as string | null,
    tokenProgram: program,
  };
}
