import {
  address,
  blockhash,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageConfig,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  compileTransaction,
  getTransactionEncoder,
  getBase64Decoder,
} from '@solana/kit-v1';
import bs58 from 'bs58';
import { validSolanaSigningKey } from './solana-signature';
import type { PumpCreateInput } from './pump-launch-message';
import { buildPumpCreateAndBuyMessage } from './pump-initial-buy-message';

export type PumpOrganicBuyInput = {
  /** The reviewed create identity of the already-created token; its create instruction is not included. */
  create: PumpCreateInput;
  holder: string;
  tokenAmountRaw: string;
  maximumQuoteCostRaw: string;
  /** Fresh lifetime for this buy's own batch, not the create packet's. */
  blockhash: string;
  lastValidBlockHeight: bigint;
};

/**
 * One unsigned post-create holder buy, paid and signed only by the holder.
 * Reuses the reviewed create-and-buy account derivation and drops the create
 * instruction. Requires fresh simulation against the live curve before approval.
 */
export async function buildPumpOrganicBuyMessage(
  supplied: PumpOrganicBuyInput,
) {
  const allowed = [
    'create',
    'holder',
    'tokenAmountRaw',
    'maximumQuoteCostRaw',
    'blockhash',
    'lastValidBlockHeight',
  ];
  if (Object.keys(supplied).some((k) => !allowed.includes(k)))
    throw new Error('Unsupported organic buy option.');
  const input = structuredClone(supplied);
  if (!validSolanaSigningKey(bs58.decode(input.holder)))
    throw new Error('Invalid holder signing identity.');
  if (input.holder === input.create.payer || input.holder === input.create.mint)
    throw new Error('Holder must differ from the deployer and mint.');
  const built = await buildPumpCreateAndBuyMessage({
    create: { ...input.create, payer: input.holder },
    tokenAmountRaw: input.tokenAmountRaw,
    maximumQuoteCostRaw: input.maximumQuoteCostRaw,
    transactionVersion: 1,
  });
  if (built.buybackRecipient === input.holder)
    throw new Error('Buyback recipient cannot be the holder.');
  // Version 1 order: [create, createUserBase, ...createBuybackQuote, buy].
  const instructions = built.instructions.slice(1);
  const resourceLimits = {
    computeUnitLimit: 400_000,
    loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
    priorityFeeLamports: 0n,
  };
  const holder = address(input.holder);
  const message = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageConfig(
      resourceLimits,
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(input.blockhash),
          lastValidBlockHeight: input.lastValidBlockHeight,
        },
        setTransactionMessageFeePayer(
          holder,
          createTransactionMessage({ version: 1 }),
        ),
      ),
    ),
  );
  const compiled = compileTransactionMessage(message);
  if (
    compiled.header.numSignerAccounts !== 1 ||
    compiled.staticAccounts[0] !== holder
  )
    throw new Error('Organic buy must be signed by the holder alone.');
  const tx = compileTransaction(message),
    packet = Uint8Array.from(getTransactionEncoder().encode(tx));
  if (packet.length > 4096)
    throw new Error(
      `Organic buy exceeds the pinned v1 packet limit (${packet.length} bytes).`,
    );
  if (Object.values(tx.signatures).some((s) => s !== null))
    throw new Error('Organic buy packet must remain unsigned.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', packet));
  return {
    format: 'pump-organic-buy-unsigned-v1' as const,
    transactionVersion: 1 as const,
    holder: input.holder,
    mint: input.create.mint,
    quoteMint: input.create.quoteMint,
    quoteTokenProgram: String(built.quote.tokenProgram),
    tokenAmountRaw: built.tokenAmountRaw,
    maximumQuoteCostRaw: built.maximumQuoteCostRaw,
    userBaseAccount: built.userBaseAccount,
    userQuoteAccount: built.userQuoteAccount,
    buybackRecipient: built.buybackRecipient,
    requiredSigners: [input.holder],
    packetBytes: packet.length,
    transaction: getBase64Decoder().decode(packet),
    packetSha256: Array.from(digest, (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    lastValidBlockHeight: input.lastValidBlockHeight.toString(),
    instructions,
    simulationRequired: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
