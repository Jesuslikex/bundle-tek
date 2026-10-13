import bs58 from 'bs58';
import type { WarmupSigningReview } from './warmup-signing';
import {
  warmupRentChange,
  warmupAccountKeysHash,
} from './warmup-native-settlement';
import {
  getBase64Encoder,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
} from '@solana/kit';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { getSolanaRpcEndpoint } from './solana-rpc';
import { solanaTokenBalanceChanges } from './solana-token-balance-changes';
import { transactionSignature } from './tracked-wallet-transaction';
import { walletAddress } from './wallet-workspace';
import type { SavedWarmupPreparation } from './warmup-preparation-history';
import type { UnsignedSwapPreparationSummary } from './imported-swap-preparation-history';
const WRAPPED = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Incomplete receipt.');
  return value as Record<string, unknown>;
};
const uint = (value: unknown, max = (1n << 64n) - 1n) => {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(value) ||
    BigInt(value) > max
  )
    throw new Error('Invalid receipt integer.');
  return BigInt(value);
};
const list = (value: unknown) => {
  if (!Array.isArray(value) || value.length > 256)
    throw new Error('Incomplete receipt accounts.');
  return value as unknown[];
};
const hash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');

export async function decodeWarmupBuyReceipt(
  raw: unknown,
  preparation: SavedWarmupPreparation,
  signature: string,
) {
  return decodeWarmupReceipt(raw, preparation, signature, 'Buy');
}
export async function decodeWarmupReceipt(
  raw: unknown,
  preparation: { document: UnsignedSwapPreparationSummary },
  signature: string,
  side: 'Buy' | 'Sell',
  approval?: WarmupSigningReview,
) {
  signature = transactionSignature(signature);
  const saved = preparation.document;
  const wallet = walletAddress(saved.wallet, 'Solana'),
    mint = walletAddress(
      side === 'Buy' ? saved.outputMint : saved.inputMint,
      'Solana',
    );
  if (
    saved.side !== side ||
    (side === 'Buy' ? saved.inputMint : saved.outputMint) !== WRAPPED ||
    mint === WRAPPED ||
    saved.executionAllowed !== false ||
    saved.instructionsVerified !== false ||
    !/^[a-f0-9]{64}$/.test(saved.transaction.sha256)
  )
    throw new Error('Choose a saved unsigned buy.');
  const result = object(raw),
    meta = object(result.meta);
  if (
    result.version !== '0' ||
    meta.err !== null ||
    !Array.isArray(result.transaction) ||
    result.transaction.length !== 2 ||
    result.transaction[1] !== 'base64'
  )
    throw new Error('Successful v0 receipt required.');
  const encoded = result.transaction[0];
  if (
    typeof encoded !== 'string' ||
    encoded.length > 1644 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  )
    throw new Error('Invalid receipt packet.');
  const bytes = getBase64Encoder().encode(encoded);
  if (
    bytes.length > 1232 ||
    bytes.length !== saved.transaction.bytes ||
    getBase64Decoder().decode(bytes) !== encoded
  )
    throw new Error('Receipt packet does not match.');
  const tx = getTransactionDecoder().decode(bytes),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const roundtrip = getTransactionEncoder().encode(tx),
    roundtripMessage = getCompiledTransactionMessageEncoder().encode(message);
  if (
    roundtrip.length !== bytes.length ||
    roundtrip.some((b, i) => b !== bytes[i]) ||
    roundtripMessage.length !== tx.messageBytes.length ||
    roundtripMessage.some((b, i) => b !== tx.messageBytes[i]) ||
    message.version !== 0 ||
    message.header.numSignerAccounts !== 1 ||
    message.header.numReadonlySignerAccounts !== 0 ||
    message.staticAccounts[0] !== wallet ||
    Object.keys(tx.signatures).length !== 1 ||
    !message.instructions.length
  )
    throw new Error('Receipt signer or envelope mismatch.');
  const sig = Object.values(tx.signatures)[0];
  if (!sig || bs58.encode(sig) !== signature)
    throw new Error('Receipt signature mismatch.');
  const publicKey = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(bs58.decode(wallet)).buffer,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  if (
    !(await crypto.subtle.verify(
      'Ed25519',
      publicKey,
      Uint8Array.from(sig).buffer,
      Uint8Array.from(tx.messageBytes).buffer,
    ))
  )
    throw new Error('Invalid wallet signature.');
  const unsigned = getTransactionEncoder().encode({
    ...tx,
    signatures: { ...tx.signatures, [wallet]: null },
  });
  if ((await hash(Uint8Array.from(unsigned))) !== saved.transaction.sha256)
    throw new Error('Receipt is not the saved buy packet.');
  const loaded = object(meta.loadedAddresses),
    writable = list(loaded.writable).map((a) => walletAddress(a, 'Solana')),
    readonly = list(loaded.readonly).map((a) => walletAddress(a, 'Solana'));
  const lookups = message.addressTableLookups ?? [];
  if (
    writable.length !==
      lookups.reduce((n, l) => n + l.writableIndexes.length, 0) ||
    readonly.length !==
      lookups.reduce((n, l) => n + l.readonlyIndexes.length, 0)
  )
    throw new Error('Incomplete lookup accounts.');
  const keys = [...message.staticAccounts, ...writable, ...readonly];
  if (keys.length > 256 || new Set(keys).size !== keys.length)
    throw new Error('Invalid receipt account keys.');
  if (
    approval?.settlement &&
    (approval.wallet !== wallet ||
      approval.sha256 !== saved.transaction.sha256 ||
      approval.settlement.accountKeysSha256 !==
        (await warmupAccountKeysHash(keys)))
  )
    throw new Error('Receipt lookup account identities differ from approval.');
  const before = list(meta.preBalances).map((v) => uint(v)),
    after = list(meta.postBalances).map((v) => uint(v));
  if (before.length !== keys.length || after.length !== keys.length)
    throw new Error('Incomplete native balances.');
  const tokens = solanaTokenBalanceChanges(
    keys,
    wallet,
    meta.preTokenBalances,
    meta.postTokenBalances,
  );
  const matches = tokens.changes.filter((change) => change.mint === mint);
  const wrappedChanges = tokens.changes.filter(
    (change) => change.mint === WRAPPED,
  );
  const { rentChange } = warmupRentChange(
    keys,
    wallet,
    before.map(String),
    after.map(String),
    meta.preTokenBalances,
    meta.postTokenBalances,
  );
  const nativeOutput =
    after[0] -
    before[0] +
    uint(meta.fee) +
    rentChange +
    wrappedChanges.reduce((sum, change) => sum + BigInt(change.changeRaw), 0n);
  if (side === 'Buy') {
    const input = uint(saved.inAmountRaw);
    if (input === 0n || nativeOutput !== -input)
      throw new Error(
        'Buy SOL settlement differs from the reviewed exact input.',
      );
  }
  if (
    !tokens.complete ||
    matches.length !== 1 ||
    matches[0].program !== TOKEN ||
    (side === 'Buy'
      ? BigInt(matches[0].changeRaw) <= 0n ||
        BigInt(matches[0].changeRaw) > (1n << 64n) - 1n ||
        BigInt(matches[0].changeRaw) < uint(saved.minimumOutRaw)
      : -BigInt(matches[0].changeRaw) !== uint(saved.inAmountRaw) ||
        nativeOutput < uint(saved.minimumOutRaw)) ||
    tokens.changes.some(
      (change) =>
        change.mint !== mint &&
        change.mint !== WRAPPED &&
        change.changeRaw !== '0',
    )
  )
    throw new Error('Complete standard SPL token acquisition required.');
  const acquired = matches[0];
  return {
    executionAllowed: false as const,
    instructionsVerified: false as const,
    network: 'mainnet' as const,
    commitment: 'finalized' as const,
    signature,
    signatureVerified: true as const,
    wallet,
    mint,
    preparationSha256: saved.transaction.sha256,
    slot: Number(uint(result.slot, BigInt(Number.MAX_SAFE_INTEGER))),
    blockTime:
      result.blockTime === null
        ? null
        : Number(uint(result.blockTime, BigInt(Number.MAX_SAFE_INTEGER))),
    acquiredRaw: (side === 'Buy'
      ? BigInt(acquired.changeRaw)
      : -BigInt(acquired.changeRaw)
    ).toString(),
    decimals: acquired.decimals,
    tokenProgram: acquired.program,
    accounts: acquired.accounts,
    networkFeeLamports: uint(meta.fee).toString(),
    nativeChangeRaw: (after[0] - before[0]).toString(),
    rentChangeRaw: rentChange.toString(),
    nativeSettlementRaw: nativeOutput.toString(),
    limitations:
      'Finalized provider receipt with a verified wallet signature and exact saved packet match. Net token increase excludes pre-existing units. This does not verify swap instruction semantics or track later token movements, consumed lots, profit or remaining acquired units. No execution clearance.',
  };
}
export type WarmupBuyReceipt = Awaited<
  ReturnType<typeof observeWarmupBuyReceipt>
>;
export type SavedWarmupBuyReceipt = {
  remainingRaw?: string;
  id: string;
  preparationId: string;
  planId: string;
  planRevision: number;
  cycle: number;
  walletRevision: number;
  createdAt: string;
  document: WarmupBuyReceipt;
};
export async function observeWarmupBuyReceipt(
  preparation: SavedWarmupPreparation,
  signature: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  approval?: WarmupSigningReview,
) {
  return observeWarmupReceipt(
    preparation,
    signature,
    signal,
    fetcher,
    'Buy',
    approval,
  );
}
export async function observeWarmupReceipt(
  preparation: { document: UnsignedSwapPreparationSummary },
  signature: string,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  side: 'Buy' | 'Sell' = 'Buy',
  approval?: WarmupSigningReview,
) {
  signature = transactionSignature(signature);
  const endpoint = getSolanaRpcEndpoint('mainnet');
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(endpoint, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Receipt network mismatch.');
  const raw = await rpc('getTransaction', [
    signature,
    {
      encoding: 'base64',
      commitment: 'finalized',
      maxSupportedTransactionVersion: 0,
    },
  ]);
  if (raw === null) throw new Error('Finalized receipt unavailable.');
  return {
    ...(await decodeWarmupReceipt(raw, preparation, signature, side, approval)),
    observedAt: new Date().toISOString(),
    source: new URL(endpoint).hostname,
  };
}
