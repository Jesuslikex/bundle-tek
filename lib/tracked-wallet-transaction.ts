import { solanaTokenBalanceChanges } from './solana-token-balance-changes';
import bs58 from 'bs58';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { DEVNET_GENESIS_HASH } from './devnet-intent';
import { getSolanaRpcEndpoint } from './solana-rpc';
import { walletAddress } from './wallet-workspace';
import { transactionSignature } from './transaction-signature';
export { transactionSignature } from './transaction-signature';

export type TrackedTransaction = {
  transactionVersion?: 'legacy' | 0 | 1;
  transactionConfig?: {
    priorityFeeRaw: string | null;
    computeUnitLimit: number | null;
    loadedAccountsDataSizeLimit: number | null;
    heapSize: number | null;
  };
  nativeAccountChanges?: {
    address: string;
    beforeRaw: string;
    afterRaw: string;
    changeRaw: string;
  }[];
  movementInstructions?: MovementInstruction[];
  address: string;
  network: 'mainnet' | 'devnet';
  signature: string;
  slot: number;
  blockTime: number | null;
  failed: boolean;
  feeRaw: string;
  feePayer: string;
  walletSigner: boolean;
  nativeChangeRaw: string | null;
  tokensComplete: boolean;
  tokenChanges: {
    mint: string;
    program: string;
    decimals: number;
    beforeRaw: string;
    afterRaw: string;
    changeRaw: string;
    accounts: string[];
  }[];
  programs: string[];
  innerInstructionsAvailable: boolean;
  observedAt: string;
  source: string;
  commitment: 'confirmed';
};
export type MovementInstruction = {
  program: string;
  topLevel: boolean;
  outerInstructionIndex?: number;
  innerInstructionIndex?: number;
  // Absent when the provider did not report depth. Never infer it from program names.
  stackHeight?: number;
  accounts?: string[];
  dataHex?: string;
  type?: string;
  info?: Record<string, string>;
};
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid transaction data.');
  return value as Record<string, unknown>;
}
function uint(value: unknown, max = (1n << 64n) - 1n) {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > max
  )
    throw new Error('Invalid transaction integer.');
  return BigInt(value);
}
function array(value: unknown, max: number) {
  if (!Array.isArray(value) || value.length > max)
    throw new Error('Incomplete transaction data.');
  return value as unknown[];
}
const key = (value: unknown) => walletAddress(value, 'Solana');
export function decodeTrackedTransaction(
  raw: unknown,
  address: string,
  signature: string,
) {
  address = key(address);
  signature = transactionSignature(signature);
  const result = record(raw),
    tx = record(result.transaction),
    message = record(tx.message),
    meta = record(result.meta);
  if (
    array(tx.signatures, 64)[0] !== signature ||
    meta.err === undefined ||
    !(
      result.version === undefined ||
      result.version === 'legacy' ||
      result.version === '0' ||
      result.version === '1'
    )
  )
    throw new Error('Transaction identity or version mismatch.');
  const isV1 = result.version === '1';
  let transactionConfig: TrackedTransaction['transactionConfig'];
  if (isV1) {
    const config = record(message.transactionConfig);
    if (
      Object.keys(config).some(
        (k) =>
          ![
            'priorityFee',
            'computeUnitLimit',
            'loadedAccountsDataSizeLimit',
            'heapSize',
          ].includes(k),
      )
    )
      throw new Error('Unknown v1 transaction configuration.');
    const limit = (value: unknown) =>
      value === null || value === undefined
        ? null
        : Number(uint(value, (1n << 32n) - 1n));
    transactionConfig = {
      priorityFeeRaw:
        config.priorityFee === null || config.priorityFee === undefined
          ? null
          : uint(config.priorityFee).toString(),
      computeUnitLimit: limit(config.computeUnitLimit),
      loadedAccountsDataSizeLimit: limit(config.loadedAccountsDataSizeLimit),
      heapSize: limit(config.heapSize),
    };
    if (
      message.addressTableLookups !== undefined &&
      array(message.addressTableLookups, 0).length
    )
      throw new Error('V1 lookup tables are unsupported.');
    if (meta.loadedAddresses !== undefined && meta.loadedAddresses !== null) {
      const loaded = record(meta.loadedAddresses);
      if (
        Object.keys(loaded).some((k) => !['readonly', 'writable'].includes(k))
      )
        throw new Error('Invalid v1 loaded addresses.');
      array(loaded.readonly ?? [], 0);
      array(loaded.writable ?? [], 0);
    }
    array(message.instructions, 64);
  } else if (message.transactionConfig !== undefined)
    throw new Error('Configuration does not match transaction version.');
  const keys = array(message.accountKeys, isV1 ? 64 : 256).map((v) => {
    const k = record(v);
    if (typeof k.signer !== 'boolean' || typeof k.writable !== 'boolean')
      throw new Error('Invalid account flags.');
    if (isV1 && k.source !== undefined && k.source !== 'transaction')
      throw new Error('V1 account must be inline.');
    return { address: key(k.pubkey), signer: k.signer };
  });
  if (
    !keys.length ||
    !keys[0].signer ||
    new Set(keys.map((k) => k.address)).size !== keys.length
  )
    throw new Error('Invalid transaction account keys.');
  if (isV1) {
    const signatures = array(tx.signatures, 64);
    if (signatures.length !== keys.filter((k) => k.signer).length)
      throw new Error('V1 signer count differs.');
    signatures.forEach(transactionSignature);
  }
  const before = array(meta.preBalances, 256).map((v) => uint(v)),
    after = array(meta.postBalances, 256).map((v) => uint(v));
  if (before.length !== keys.length || after.length !== keys.length)
    throw new Error('Balance account mismatch.');
  const walletIndex = keys.findIndex((k) => k.address === address);
  const tokens = solanaTokenBalanceChanges(
    keys.map((k) => k.address),
    address,
    meta.preTokenBalances,
    meta.postTokenBalances,
  );
  if (walletIndex === -1 && !tokens.walletIncluded)
    throw new Error('Transaction does not include the tracked wallet.');
  const programs = new Set<string>();
  const movementInstructions: MovementInstruction[] = [];
  const instructions = (
    value: unknown,
    topLevel: boolean,
    outerIndex?: number,
  ) => {
    for (const [ordinal, item] of array(value, 1024).entries()) {
      const program = key(record(item).programId);
      if (!keys.some((k) => k.address === program))
        throw new Error('Program missing from transaction accounts.');
      programs.add(program);
      const raw = record(item),
        fact: MovementInstruction = {
          program,
          topLevel,
          outerInstructionIndex: topLevel ? ordinal : outerIndex,
          ...(!topLevel ? { innerInstructionIndex: ordinal } : {}),
        };
      if (raw.stackHeight !== undefined && raw.stackHeight !== null) {
        const height = Number(uint(raw.stackHeight, 255n));
        if (topLevel ? height !== 1 : height < 2)
          throw new Error('Invalid instruction stack height.');
        fact.stackHeight = height;
      }
      if (Array.isArray(raw.accounts) && raw.accounts.length <= 256) {
        fact.accounts = raw.accounts.map(key);
        if (fact.accounts.some((a) => !keys.some((k) => k.address === a)))
          throw new Error('Instruction account missing from transaction keys.');
      }
      if (isV1 && typeof raw.data === 'string' && raw.data.length > 5600)
        throw new Error('V1 instruction data exceeds read bounds.');
      if (
        typeof raw.data === 'string' &&
        raw.data.length <= (isV1 ? 5600 : 1800)
      ) {
        const bytes = bs58.decode(raw.data);
        if (isV1 && bytes.length > 4096)
          throw new Error('V1 instruction data exceeds read bounds.');
        if (bytes.length <= (isV1 ? 4096 : 1232))
          fact.dataHex = Array.from(bytes, (b) =>
            b.toString(16).padStart(2, '0'),
          ).join('');
      }
      if (raw.parsed && typeof raw.parsed === 'object') {
        const parsed = record(raw.parsed);
        if (typeof parsed.type === 'string' && parsed.type.length <= 80)
          fact.type = parsed.type;
        if (parsed.info && typeof parsed.info === 'object') {
          const info = record(parsed.info);
          fact.info = {};
          for (const name of [
            'source',
            'newAccount',
            'destination',
            'mint',
            'account',
            'owner',
            'wallet',
            'authority',
            'amount',
            'lamports',
            'decimals',
          ])
            if (typeof info[name] === 'string' && info[name].length <= 100) {
              const value =
                name === 'amount' || name === 'decimals' || name === 'lamports'
                  ? info[name]
                  : key(info[name]);
              if (
                ['source', 'destination', 'account', 'newAccount'].includes(
                  name,
                ) &&
                !keys.some((k) => k.address === value)
              )
                throw new Error(
                  'Parsed instruction account missing from transaction keys.',
                );
              fact.info[name] = value;
            }
          if (info.tokenAmount && typeof info.tokenAmount === 'object') {
            const amount = record(info.tokenAmount);
            for (const name of ['amount', 'decimals'])
              if (
                typeof amount[name] === 'string' &&
                amount[name].length <= 100
              )
                fact.info[name] = amount[name];
          }
        }
      }
      movementInstructions.push(fact);
    }
  };
  instructions(message.instructions, true);
  if (meta.innerInstructions != null) {
    const indexes = new Set<number>();
    for (const item of array(meta.innerInstructions, 256)) {
      const inner = record(item);
      const index = Number(uint(inner.index, 255n));
      if (
        index >= array(message.instructions, 1024).length ||
        indexes.has(index)
      )
        throw new Error('Invalid inner instruction index.');
      indexes.add(index);
      instructions(inner.instructions, false, index);
    }
  }
  return {
    transactionVersion:
      result.version === undefined
        ? undefined
        : result.version === 'legacy'
          ? ('legacy' as const)
          : result.version === '1'
            ? (1 as const)
            : (0 as const),
    ...(transactionConfig ? { transactionConfig } : {}),
    slot: Number(uint(result.slot, BigInt(Number.MAX_SAFE_INTEGER))),
    blockTime:
      result.blockTime === null
        ? null
        : Number(uint(result.blockTime, BigInt(Number.MAX_SAFE_INTEGER))),
    failed: meta.err !== null,
    feeRaw: uint(meta.fee).toString(),
    feePayer: keys[0].address,
    walletSigner: walletIndex !== -1 && keys[walletIndex].signer,
    nativeChangeRaw:
      walletIndex === -1
        ? null
        : (after[walletIndex] - before[walletIndex]).toString(),
    nativeAccountChanges: keys.map((k, i) => ({
      address: k.address,
      beforeRaw: before[i].toString(),
      afterRaw: after[i].toString(),
      changeRaw: (after[i] - before[i]).toString(),
    })),
    tokensComplete: tokens.complete,
    tokenChanges: tokens.changes,
    programs: [...programs],
    movementInstructions,
    innerInstructionsAvailable: meta.innerInstructions != null,
  };
}
export async function observeTrackedTransaction(
  address: string,
  network: 'mainnet' | 'devnet',
  signature: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<TrackedTransaction | null> {
  address = key(address);
  signature = transactionSignature(signature);
  const endpoint = getSolanaRpcEndpoint(network);
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(endpoint, method, params, signal, fetcher);
  if (
    (await rpc('getGenesisHash', [])) !==
    (network === 'mainnet' ? SOLANA_MAINNET_GENESIS : DEVNET_GENESIS_HASH)
  )
    throw new Error('Transaction provider network mismatch.');
  const raw = await rpc('getTransaction', [
    signature,
    {
      encoding: 'jsonParsed',
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 1,
    },
  ]);
  if (raw === null) return null;
  return {
    ...decodeTrackedTransaction(raw, address, signature),
    address,
    network,
    signature,
    source: new URL(endpoint).hostname,
    observedAt: new Date().toISOString(),
    commitment: 'confirmed',
  };
}
