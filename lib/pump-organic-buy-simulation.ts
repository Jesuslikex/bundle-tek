import bs58 from 'bs58';
import { getTransactionDecoder } from '@solana/kit-v1';
import {
  buildPumpOrganicBuyMessage,
  type PumpOrganicBuyInput,
} from './pump-organic-buy-message';
import {
  pumpRpcAccount,
  pumpAccountBytes,
  pumpUnsignedInteger,
  type PumpLaunchRpc,
  type PumpRpcAccount,
} from './pump-launch-simulation';
import { PUMP_NATIVE_QUOTE, PUMP_TOKEN_2022 } from './pump-launch-config';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import { requireConsistentSolanaSlots } from './solana-rpc';

export type PumpOrganicBuyAllowance = {
  /** Upper bound for holder SOL spent on new accounts (token ATA, volume accumulator). */
  rentAllowanceRaw: string;
};
const tokenView = (account: PumpRpcAccount, program: string) => {
  if (account === null) return null;
  if (account.executable || account.owner !== program)
    throw new Error('Organic buy token account program differs.');
  const b = pumpAccountBytes(account);
  if (b.length < 165)
    throw new Error('Organic buy token account bytes differ.');
  return {
    mint: bs58.encode(b.slice(0, 32)),
    owner: bs58.encode(b.slice(32, 64)),
    amount: new DataView(b.buffer).getBigUint64(64, true),
  };
};

/**
 * Fresh unsigned simulation of one post-create holder buy against the live
 * curve. Checks the exact token output and bounds the holder's quote and SOL
 * debit by the reviewed cap, fee and rent allowance. Never signs or sends.
 */
export async function simulatePumpOrganicBuy(
  supplied: PumpOrganicBuyInput,
  suppliedAllowance: PumpOrganicBuyAllowance,
  rpc: PumpLaunchRpc,
  signal: AbortSignal,
) {
  const allowance = structuredClone(suppliedAllowance);
  if (
    Object.keys(allowance).join(',') !== 'rentAllowanceRaw' ||
    !/^(0|[1-9]\d{0,18})$/.test(allowance.rentAllowanceRaw)
  )
    throw new Error('Review an exact rent allowance for the organic buy.');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
  let reads = 0;
  const call = async (method: string, params: unknown[]) => {
    deadline.throwIfAborted();
    if (++reads > 12)
      throw new Error('Organic buy simulation RPC budget exceeded.');
    const result = await rpc(method, params, deadline);
    deadline.throwIfAborted();
    return result;
  };
  const packet = await buildPumpOrganicBuyMessage(supplied);
  const native = packet.quoteMint === PUMP_NATIVE_QUOTE;
  const tx = getTransactionDecoder().decode(
    Buffer.from(packet.transaction, 'base64'),
  );
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Organic buy simulation requires Solana mainnet.');
  const keys = native
    ? [packet.holder, packet.userBaseAccount]
    : [packet.holder, packet.userBaseAccount, packet.userQuoteAccount];
  const slots: number[] = [];
  const observe = (value: unknown) => {
    const slot = Number(pumpUnsignedInteger(value));
    if (
      !Number.isSafeInteger(slot) ||
      (slots.length && slot < Math.max(...slots))
    )
      throw new Error('Organic buy simulation RPC ignored its context slot.');
    slots.push(slot);
    requireConsistentSolanaSlots(slots);
    return slot;
  };
  const minimum = () => (slots.length ? Math.max(...slots) : 0);
  const feeResult = (await call('getFeeForMessage', [
    Buffer.from(tx.messageBytes).toString('base64'),
    { commitment: 'confirmed' },
  ])) as { context?: { slot?: unknown }; value?: unknown };
  observe(feeResult.context?.slot);
  const fee = pumpUnsignedInteger(feeResult.value);
  if (!fee) throw new Error('Organic buy network fee is unavailable.');
  let pair:
    | {
        before: PumpRpcAccount[];
        after: PumpRpcAccount[];
        units: bigint;
        slot: number;
      }
    | undefined;
  for (let attempt = 0; attempt < 3 && !pair; attempt++) {
    const source = (await call('getMultipleAccounts', [
      keys,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: minimum(),
      },
    ])) as { context?: { slot?: unknown }; value?: unknown[] };
    const sourceSlot = observe(source.context?.slot);
    if (!Array.isArray(source.value) || source.value.length !== keys.length)
      throw new Error('Organic buy source mapping differs.');
    const result = (await call('simulateTransaction', [
      packet.transaction,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        sigVerify: false,
        replaceRecentBlockhash: false,
        minContextSlot: minimum(),
        accounts: { encoding: 'base64', addresses: keys },
        innerInstructions: false,
      },
    ])) as {
      context?: { slot?: unknown };
      value?: {
        err?: unknown;
        accounts?: unknown[];
        replacementBlockhash?: unknown;
        unitsConsumed?: unknown;
      };
    };
    const simulated = observe(result.context?.slot);
    if (!result.value || result.value.err !== null)
      throw new Error(
        'Organic holder buy simulation failed against the live curve. Nothing was approved.',
      );
    if (simulated !== sourceSlot) continue;
    if (
      result.value.replacementBlockhash != null ||
      !Array.isArray(result.value.accounts) ||
      result.value.accounts.length !== keys.length
    )
      throw new Error('Organic buy simulation lifetime or mapping differs.');
    const units = pumpUnsignedInteger(result.value.unitsConsumed);
    if (!units || units > 400_000n)
      throw new Error('Organic buy simulation exceeded its compute limit.');
    pair = {
      before: source.value.map(pumpRpcAccount),
      after: result.value.accounts.map(pumpRpcAccount),
      units,
      slot: simulated,
    };
  }
  if (!pair)
    throw new Error(
      'Organic buy simulation could not match a bank snapshot after three attempts.',
    );
  const [holderBefore, baseBefore, quoteBefore] = pair.before;
  const [holderAfter, baseAfter, quoteAfter] = pair.after;
  if (!holderBefore || !holderAfter)
    throw new Error('Organic buy holder wallet is unfunded.');
  const baseOld = tokenView(baseBefore, PUMP_TOKEN_2022),
    baseNew = tokenView(baseAfter, PUMP_TOKEN_2022);
  if (
    !baseNew ||
    baseNew.mint !== packet.mint ||
    baseNew.owner !== packet.holder ||
    (baseOld &&
      (baseOld.mint !== packet.mint || baseOld.owner !== packet.holder))
  )
    throw new Error('Organic buy base custody identity differs.');
  const received = baseNew.amount - (baseOld?.amount ?? 0n);
  if (received !== BigInt(packet.tokenAmountRaw))
    throw new Error(
      'Simulated organic buy output differs from its exact target.',
    );
  const solDebit = BigInt(holderBefore.lamports) - BigInt(holderAfter.lamports);
  const cap = BigInt(packet.maximumQuoteCostRaw),
    rent = BigInt(allowance.rentAllowanceRaw);
  let quoteSpent: bigint;
  if (native) {
    quoteSpent = solDebit - fee;
    if (solDebit > cap + fee + rent)
      throw new Error(
        'Simulated organic buy SOL debit exceeds its reviewed cap.',
      );
  } else {
    const program = packet.quoteTokenProgram;
    const old = tokenView(quoteBefore, program),
      next = tokenView(quoteAfter, program);
    if (
      !old ||
      !next ||
      old.mint !== packet.quoteMint ||
      next.mint !== packet.quoteMint ||
      old.owner !== packet.holder ||
      next.owner !== packet.holder
    )
      throw new Error('Organic buy quote custody identity differs.');
    quoteSpent = old.amount - next.amount;
    if (quoteSpent < 0n || quoteSpent > cap)
      throw new Error('Simulated organic buy quote spend exceeds its cap.');
    if (solDebit > fee + rent)
      throw new Error('Simulated organic buy SOL debit exceeds fee and rent.');
  }
  return {
    format: 'pump-organic-buy-simulation-v1' as const,
    packetSha256: packet.packetSha256,
    holder: packet.holder,
    slot: pair.slot,
    unitsConsumed: pair.units.toString(),
    networkFeeRaw: fee.toString(),
    tokenOutputRaw: received.toString(),
    quoteSpentRaw: quoteSpent.toString(),
    solDebitRaw: solDebit.toString(),
    maximumQuoteCostRaw: packet.maximumQuoteCostRaw,
    /** The live curve can still move before this buy lands; only the on-chain cap binds. */
    settlementValidated: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
