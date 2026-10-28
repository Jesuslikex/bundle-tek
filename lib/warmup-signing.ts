import {
  validatedTradeSessionCapture,
  requireSessionEntryDue,
  type TradeSessionCapture,
} from './imported-trade-session';
import {
  address,
  type SignatureBytes,
  getBase64Encoder,
  getBase64Decoder,
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import type { VaultSession } from './browser-wallet-vault';
import type { SavedWarmupPreparation } from './warmup-preparation-history';
import type { SolanaSwapPreparation } from './warmup-swap-quote';
import type { ImportedSwapSimulation } from './imported-swap-simulation';
import {
  reviewWarmupSettlement,
  type WarmupSettlement,
} from './warmup-native-settlement';
import { reviewUnsignedSwapOrder } from './unsigned-swap-order';
import type { WarmupBuyLink } from './warmup-buy-link';
import type { UnsignedSwapPreparationSummary } from './imported-swap-preparation-history';
import type { ImportedAcquisitionSelection } from './imported-acquisition';
import type { ConditionalPreparation } from './conditional-preparation-server';
import {
  validatedConditionalSigning,
  requireConditionalSwapContext,
} from './conditional-signing';
export type WarmupSigningReview = {
  id: string;
  preparationId: string;
  wallet: string;
  sha256: string;
  expiresAt: string;
  network: 'mainnet';
  maximumFeeLamports: string;
  inputRaw: string;
  minimumOutputRaw: string;
  inputMint: string;
  outputMint: string;
  transaction: string;
  lastValidBlockHeight: string;
  settlement?: WarmupSettlement;
  platformFee?: { bps: number; mint: string };
  buyReceipt?: WarmupBuyLink;
  acquisition?: ImportedAcquisitionSelection;
  conditional?: ConditionalPreparation;
  session?: TradeSessionCapture;
};
export async function restoreWarmupOrder(
  saved: SavedWarmupPreparation,
  transaction: string,
): Promise<SolanaSwapPreparation> {
  return restoreSavedSwapOrder(saved, transaction);
}
export async function restoreSavedSwapOrder(
  saved: { document: UnsignedSwapPreparationSummary },
  transaction: string,
): Promise<SolanaSwapPreparation> {
  const doc = saved.document;
  const preparation = await reviewUnsignedSwapOrder(
    {
      transaction,
      transactionVersion: 0,
      taker: doc.wallet,
      gasless: false,
      lastValidBlockHeight: doc.transaction.lastValidBlockHeight,
      signatureFeeLamports: 0,
      prioritizationFeeLamports: 0,
      rentFeeLamports: 0,
    },
    doc.wallet,
  );
  if (
    preparation.sha256 !== doc.transaction.sha256 ||
    preparation.transactionBytes !== doc.transaction.bytes ||
    Date.parse(doc.expiresAt) <= Date.now()
  )
    throw new Error('Reviewed packet changed or expired.');
  return {
    executionAllowed: false,
    side: doc.side,
    inputMint: doc.inputMint,
    outputMint: doc.outputMint,
    inAmount: doc.inAmountRaw,
    outAmount: doc.quotedOutRaw,
    minimumOutAmount: doc.minimumOutRaw,
    slippageBps: doc.slippageBps,
    router: doc.router,
    ...(doc.platformFee ? { platformFee: doc.platformFee } : {}),
    source: doc.quoteSource,
    observedAt: doc.quotedAt,
    expiresAt: doc.expiresAt,
    preparation,
    limitations: doc.limitations,
  };
}
export async function requireWarmupSigningReview(
  order: SolanaSwapPreparation,
  simulation: ImportedSwapSimulation,
) {
  const review = simulation.instructionReview,
    route = simulation.routeAssessment;
  if (!simulation.succeeded)
    throw new Error(
      simulation.failureReason === 'BlockhashNotFound'
        ? 'Simulated swap blockhash is unavailable. Prepare a fresh order or configure a consistent RPC provider.'
        : 'Simulated swap failed. Prepare a fresh order.',
    );
  if (
    !['metis', 'dflow'].includes(order.router) ||
    simulation.sha256 !== order.preparation.sha256 ||
    simulation.wallet !== order.preparation.wallet ||
    !simulation.succeeded ||
    !simulation.tokensComplete ||
    (route?.status !== 'Matched fields' &&
      !(order.router === 'dflow' && simulation.succeeded)) ||
    (!route.decoded && order.router !== 'dflow') ||
    !review ||
    review.unresolvedAccountCount ||
    review.authorityActionCount
  ) {
    console.error('warmup signing gate', {
      router: order.router,
      sha: simulation.sha256 === order.preparation.sha256,
      wallet: simulation.wallet === order.preparation.wallet,
      succeeded: simulation.succeeded,
      tokensComplete: simulation.tokensComplete,
      routeStatus: route?.status,
      decoded: route?.decoded,
      review: Boolean(review),
      unresolved: review?.unresolvedAccountCount,
      authority: review?.authorityActionCount,
    });
    throw new Error(
      'Signing requires an exact supported Metis or DFlow route and complete simulation metadata.',
    );
  }
  const budgets = new Set<number>();
  let units = 200000n,
    price = 0n;
  for (const instruction of review.instructions) {
    if (
      instruction.program.address !==
      'ComputeBudget111111111111111111111111111111'
    )
      continue;
    if (instruction.accounts.length)
      throw new Error('Signing requires an account-free compute budget.');
    const bytes = Uint8Array.from(instruction.dataHex.match(/../g) ?? [], (v) =>
        parseInt(v, 16),
      ),
      view = new DataView(bytes.buffer),
      tag = bytes[0];
    if (budgets.has(tag))
      throw new Error('Signing requires unique compute budgets.');
    budgets.add(tag);
    if (tag === 2 && bytes.length === 5)
      units = BigInt(view.getUint32(1, true));
    else if (tag === 3 && bytes.length === 9)
      price = view.getBigUint64(1, true);
    else if (
      tag === 1 &&
      bytes.length === 5 &&
      view.getUint32(1, true) >= 32768 &&
      view.getUint32(1, true) <= 262144 &&
      view.getUint32(1, true) % 1024 === 0
    )
      continue;
    else if (
      tag === 4 &&
      bytes.length === 5 &&
      view.getUint32(1, true) > 0 &&
      view.getUint32(1, true) <= 67108864
    )
      continue;
    else throw new Error('Signing requires a supported compute budget.');
  }
  if (
    units < 1n ||
    units > 1400000n ||
    price > 1000000n ||
    (price > 0n && !budgets.has(2)) ||
    !/^(0|[1-9]\d{0,19})$/.test(simulation.networkFeeLamports) ||
    BigInt(simulation.networkFeeLamports) > 1000000n ||
    BigInt(simulation.networkFeeLamports) !==
      5000n + (units * price + 999999n) / 1000000n
  )
    throw new Error(
      'Network debit or compute fee differs from the signing limit.',
    );
  if (
    simulation.tokenChanges.some(
      (change) =>
        change.mint !== order.inputMint &&
        change.mint !== order.outputMint &&
        change.changeRaw !== '0',
    )
  )
    throw new Error('Unrelated token debit.');
  return reviewWarmupSettlement(order, simulation);
}
export async function requireApprovedWarmupPacket(
  review: WarmupSigningReview,
  assertCurrent: () => void,
) {
  assertCurrent();
  if (review.session) {
    validatedTradeSessionCapture(review.session, review.inputRaw);
    requireSessionEntryDue(review.session);
  }
  if (review.conditional) {
    requireConditionalSwapContext(review.conditional, {
      side:
        review.inputMint === 'So11111111111111111111111111111111111111112'
          ? 'Buy'
          : 'Sell',
      inputMint: review.inputMint,
      outputMint: review.outputMint,
      inputRaw: review.inputRaw,
    });
    validatedConditionalSigning(
      review.conditional,
      review.inputRaw,
      Date.now(),
    );
  }
  if (
    review.network !== 'mainnet' ||
    !Number.isFinite(Date.parse(review.expiresAt)) ||
    Date.parse(review.expiresAt) <= Date.now()
  )
    throw new Error('Approval expired.');
  const bytes = getBase64Encoder().encode(review.transaction),
    digest = await crypto.subtle.digest(
      'SHA-256',
      Uint8Array.from(bytes).buffer,
    );
  if (
    Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('') !== review.sha256
  )
    throw new Error('Approved packet changed.');
  const tx = getTransactionDecoder().decode(bytes),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (
    message.version !== 0 ||
    message.header.numSignerAccounts !== 1 ||
    message.staticAccounts[0] !== review.wallet ||
    Object.values(tx.signatures).some((value) => value?.some((b) => b !== 0))
  )
    throw new Error('Approved signer differs.');
  assertCurrent();
  return { bytes, tx };
}
export async function signApprovedWarmupPacket(
  session: VaultSession,
  review: WarmupSigningReview,
  assertCurrent: () => void,
  hooks?: {
    beforeSign?: () => Promise<void>;
    onSignerStart?: () => void;
    retainSigned?: (signed: {
      signature: string;
      transaction: string;
    }) => Promise<void>;
  },
) {
  const { tx } = await requireApprovedWarmupPacket(review, assertCurrent);
  const wallet = session.payload.wallets.find(
    (value) => value.family === 'solana' && value.address === review.wallet,
  );
  if (!wallet || !/^[a-f0-9]{64}$/.test(wallet.seed))
    throw new Error('Reviewed wallet is not in this vault.');
  if (hooks?.beforeSign) {
    const originalReview = JSON.stringify(review);
    await hooks.beforeSign();
    assertCurrent();
    const rechecked = await requireApprovedWarmupPacket(review, assertCurrent);
    if (
      JSON.stringify(review) !== originalReview ||
      rechecked.tx.messageBytes.length !== tx.messageBytes.length ||
      rechecked.tx.messageBytes.some(
        (byte, index) => byte !== tx.messageBytes[index],
      )
    )
      throw new Error('Approved packet changed during signer preparation.');
    assertCurrent();
    if (
      session.payload.wallets.find(
        (value) => value.family === 'solana' && value.address === review.wallet,
      ) !== wallet ||
      !/^[a-f0-9]{64}$/.test(wallet.seed)
    )
      throw new Error('Reviewed wallet is not in this vault.');
  }
  const seed = Uint8Array.from(wallet.seed.match(/../g)!, (value) =>
      parseInt(value, 16),
    ),
    pair = nacl.sign.keyPair.fromSeed(seed);
  try {
    assertCurrent();
    if (
      bs58.encode(pair.publicKey) !== review.wallet ||
      Date.parse(review.expiresAt) <= Date.now()
    )
      throw new Error('Approval changed or expired.');
    hooks?.onSignerStart?.();
    const signature = nacl.sign.detached(
      Uint8Array.from(tx.messageBytes),
      pair.secretKey,
    ) as SignatureBytes;
    const signed = getTransactionEncoder().encode({
      ...tx,
      signatures: { [address(review.wallet)]: signature },
    });
    const result = {
      signature: bs58.encode(signature),
      transaction: getBase64Decoder().decode(signed),
    };
    if (hooks?.retainSigned) {
      seed.fill(0);
      pair.secretKey.fill(0);
      await hooks.retainSigned({ ...result });
    }
    assertCurrent();
    return result;
  } finally {
    seed.fill(0);
    pair.secretKey.fill(0);
  }
}
