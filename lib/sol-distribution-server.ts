import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { getSolanaRpcEndpoint } from './solana-rpc';
import {
  DISTRIBUTION_MAX_WALLETS,
  RENT_EXEMPT_LAMPORTS,
  SYSTEM_PROGRAM,
  batchFee,
  chunkTransfers,
  distributionMessage,
  isSolanaAddress,
  lamportsOf,
  toBase64,
  validateBatch,
  verifySignedBatch,
  type DistributionBatch,
  type DistributionMode,
  type DistributionTransfer,
} from './sol-distribution';

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
type RawAccount = {
  lamports: string | number;
  owner: string;
  executable: boolean;
  data: [string, string];
} | null;

export function distributionRpc(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Rpc {
  const endpoint = getSolanaRpcEndpoint('mainnet');
  return (method, params) =>
    balanceRpc(endpoint, method, params, signal, fetcher);
}

const big = (value: unknown) => {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return BigInt(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error('Invalid RPC number.');
};

export type DistributionRequest =
  | { mode: 'fund'; funder: string; transfers: DistributionTransfer[] }
  | { mode: 'return'; funder: string; wallets: string[] };

/** Strict request parsing shared by the route. */
export function distributionRequest(
  body: Record<string, unknown>,
): DistributionRequest {
  const mode = body.mode as DistributionMode;
  if (!isSolanaAddress(body.funder) || body.funder === SYSTEM_PROGRAM)
    throw new Error('Choose a valid funder wallet.');
  const funder = body.funder;
  const list = mode === 'fund' ? body.transfers : body.wallets;
  if (
    !Array.isArray(list) ||
    !list.length ||
    list.length > DISTRIBUTION_MAX_WALLETS
  )
    throw new Error(`Choose 1 to ${DISTRIBUTION_MAX_WALLETS} wallets.`);
  const seen = new Set([funder]);
  const check = (address: unknown) => {
    if (!isSolanaAddress(address) || seen.has(address))
      throw new Error('Wallets must be distinct and differ from the funder.');
    seen.add(address);
    return address;
  };
  if (mode === 'fund')
    return {
      mode,
      funder,
      transfers: list.map((entry) => {
        const t = entry as { address?: unknown; lamports?: unknown };
        const address = check(t?.address);
        lamportsOf(t?.lamports);
        return { address, lamports: String(t.lamports) };
      }),
    };
  if (mode === 'return') return { mode, funder, wallets: list.map(check) };
  throw new Error('Unknown distribution mode.');
}

async function balances(rpc: Rpc, addresses: string[]) {
  const out = new Map<string, bigint>();
  for (let i = 0; i < addresses.length; i += 100) {
    const part = addresses.slice(i, i + 100);
    const result = (await rpc('getMultipleAccounts', [
      part,
      { encoding: 'base64', commitment: 'confirmed' },
    ])) as { value: RawAccount[] };
    if (!Array.isArray(result?.value) || result.value.length !== part.length)
      throw new Error('Wallet balances unavailable.');
    result.value.forEach((account, j) => {
      if (
        account &&
        (account.owner !== SYSTEM_PROGRAM ||
          account.executable !== false ||
          account.data?.[0] !== '')
      )
        throw new Error(
          `${part[j]} is not a plain wallet account. Use ordinary wallets only.`,
        );
      out.set(part[j], account ? big(account.lamports) : 0n);
    });
  }
  return out;
}

export type PreparedDistribution = {
  mode: DistributionMode;
  funder: string;
  blockhash: string;
  lastValidBlockHeight: string;
  funderLamports: string;
  totalLamports: string;
  feeLamports: string;
  batches: (DistributionBatch & { message: string })[];
  skipped: string[];
};

export async function prepareDistribution(
  input: DistributionRequest,
  rpc: Rpc,
): Promise<PreparedDistribution> {
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Distribution network is not Solana mainnet.');
  const latest = (await rpc('getLatestBlockhash', [
    { commitment: 'confirmed' },
  ])) as { value: { blockhash: string; lastValidBlockHeight: unknown } };
  const blockhash = latest?.value?.blockhash;
  if (!isSolanaAddress(blockhash)) throw new Error('Blockhash unavailable.');
  const wallets =
    input.mode === 'fund'
      ? input.transfers.map((t) => t.address)
      : input.wallets;
  const lamports = await balances(rpc, [input.funder, ...wallets]);
  const funderLamports = lamports.get(input.funder)!;
  let transfers: DistributionTransfer[];
  const skipped: string[] = [];
  if (input.mode === 'fund') {
    transfers = input.transfers;
    for (const t of transfers)
      if (lamports.get(t.address)! + BigInt(t.lamports) < RENT_EXEMPT_LAMPORTS)
        throw new Error(
          `${t.address} would end below the 0.00089088 SOL rent minimum. Send more to it.`,
        );
  } else {
    transfers = [];
    for (const address of input.wallets) {
      const value = lamports.get(address)!;
      if (value === 0n) skipped.push(address);
      else transfers.push({ address, lamports: value.toString() });
    }
    if (!transfers.length) throw new Error('These wallets hold no SOL.');
  }
  const batches = chunkTransfers(input.mode, transfers).map((part) => {
    const batch: DistributionBatch = {
      mode: input.mode,
      funder: input.funder,
      blockhash,
      transfers: part,
    };
    validateBatch(batch);
    return batch;
  });
  const total = transfers.reduce((s, t) => s + BigInt(t.lamports), 0n);
  const fees = batches.reduce((s, b) => s + batchFee(b), 0n);
  if (input.mode === 'fund') {
    const remaining = funderLamports - total - fees;
    if (remaining < RENT_EXEMPT_LAMPORTS)
      throw new Error(
        'Funder balance is too low for these amounts, network fees and its rent minimum.',
      );
  } else {
    if (funderLamports < fees)
      throw new Error('Funder needs SOL to pay the network fees.');
    if (funderLamports - fees + total < RENT_EXEMPT_LAMPORTS)
      throw new Error('Funder would end below its rent minimum.');
  }
  const prepared = batches.map((batch) => ({
    ...batch,
    message: toBase64(distributionMessage(batch)),
  }));
  for (const batch of prepared) {
    const signers = batch.mode === 'fund' ? 1 : 1 + batch.transfers.length;
    const message = distributionMessage(batch);
    const wire = toBase64(
      Uint8Array.from([signers, ...new Uint8Array(64 * signers), ...message]),
    );
    const sim = (await rpc('simulateTransaction', [
      wire,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        sigVerify: false,
        replaceRecentBlockhash: false,
      },
    ])) as { value?: { err: unknown } };
    if (!sim?.value || sim.value.err !== null)
      throw new Error('Distribution simulation failed. Nothing was signed.');
  }
  return {
    mode: input.mode,
    funder: input.funder,
    blockhash,
    lastValidBlockHeight: big(latest.value.lastValidBlockHeight).toString(),
    funderLamports: funderLamports.toString(),
    totalLamports: total.toString(),
    feeLamports: fees.toString(),
    batches: prepared,
    skipped,
  };
}

/** Verifies a fully signed batch against its terms, then sends it once. */
export async function submitDistribution(
  batch: DistributionBatch,
  transaction: string,
  rpc: Rpc,
) {
  const { signature } = verifySignedBatch(batch, transaction);
  const sent = await rpc('sendTransaction', [
    transaction,
    {
      encoding: 'base64',
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 5,
    },
  ]);
  if (sent !== signature) throw new Error('RPC returned another signature.');
  return signature;
}

export async function distributionStatuses(signatures: string[], rpc: Rpc) {
  const result = (await rpc('getSignatureStatuses', [
    signatures,
    { searchTransactionHistory: true },
  ])) as {
    value: ({ confirmationStatus?: string; err: unknown } | null)[];
  };
  if (
    !Array.isArray(result?.value) ||
    result.value.length !== signatures.length
  )
    throw new Error('Statuses unavailable.');
  return result.value.map((s) =>
    !s
      ? 'pending'
      : s.err !== null
        ? 'failed'
        : s.confirmationStatus === 'finalized' ||
            s.confirmationStatus === 'confirmed'
          ? s.confirmationStatus
          : 'pending',
  );
}
