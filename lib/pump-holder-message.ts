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
  type Instruction,
} from '@solana/kit-v1';
import bs58 from 'bs58';
import { validSolanaSigningKey } from './solana-signature';
import {
  buildPumpCreateMessage,
  type PumpCreateInput,
} from './pump-launch-message';
import { buildPumpCreateAndBuyMessage } from './pump-initial-buy-message';
import { decodePumpLaunchConfig } from './pump-launch-config';
import quoteSchema from './pump-exact-quote-schema.json';

export type PumpHolderBuy = { address: string } & (
  | { kind: 'none' }
  | {
      kind: 'exact-base-output';
      tokenAmountRaw: string;
      maximumQuoteCostRaw: string;
    }
  | {
      kind: 'exact-quote-input';
      quoteAmountRaw: string;
      minimumTokenOutputRaw: string;
    }
);
export type PumpHolderMessageInput = {
  create: PumpCreateInput;
  developer?: { tokenAmountRaw: string; maximumQuoteCostRaw: string };
  holders: PumpHolderBuy[];
};
const positive = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error('Review positive exact holder amounts and limits.');
  return BigInt(value);
};

/** Unsigned assembly only. All-wallet funding, sequential curve/migration/fee simulation and approval are still required. */
export async function collectPumpHolderInstructionUnits(
  supplied: PumpHolderMessageInput,
  signal?: AbortSignal,
  singlePacket = false,
) {
  const input = structuredClone(supplied);
  const current = () => {
    if (signal?.aborted)
      throw new Error('Holder packet construction cancelled.');
  };
  current();
  if (
    Object.keys(input).some(
      (k) => !['create', 'developer', 'holders'].includes(k),
    ) ||
    !Array.isArray(input.holders) ||
    !input.holders.length ||
    input.holders.length > 200
  )
    throw new Error(
      'Review the complete saved holder-slot list, up to 200 slots.',
    );
  const identities = [
    input.create.payer,
    input.create.mint,
    ...input.holders.map((h) => h.address),
  ];
  if (new Set(identities).size !== identities.length)
    throw new Error('Creation and holder wallet identities must be distinct.');
  for (const key of identities)
    if (!validSolanaSigningKey(bs58.decode(key)))
      throw new Error('Invalid holder signing identity.');
  let exactBase = 0n;
  for (const holder of input.holders) {
    const expected =
      holder.kind === 'none'
        ? ['address', 'kind']
        : holder.kind === 'exact-base-output'
          ? ['address', 'kind', 'maximumQuoteCostRaw', 'tokenAmountRaw']
          : holder.kind === 'exact-quote-input'
            ? ['address', 'kind', 'minimumTokenOutputRaw', 'quoteAmountRaw']
            : [];
    if (
      !expected.length ||
      Object.keys(holder).sort().join(',') !== expected.sort().join(',')
    )
      throw new Error(
        'Holder intent must use exactly one reviewed amount denomination.',
      );
    if (holder.kind === 'exact-base-output') {
      exactBase += positive(holder.tokenAmountRaw);
      positive(holder.maximumQuoteCostRaw);
    }
    if (holder.kind === 'exact-quote-input') {
      positive(holder.quoteAmountRaw);
      exactBase += positive(holder.minimumTokenOutputRaw);
    }
  }
  if (input.developer) {
    if (
      Object.keys(input.developer).sort().join(',') !==
      'maximumQuoteCostRaw,tokenAmountRaw'
    )
      throw new Error('Unexpected developer-buy limits.');
    exactBase += positive(input.developer.tokenAmountRaw);
    positive(input.developer.maximumQuoteCostRaw);
  }
  const active = input.holders.filter((h) => h.kind !== 'none');
  if (!active.length)
    throw new Error(
      'No holder buy is requested; use the create/developer-buy flow.',
    );
  if (singlePacket && (active.length + 2) * 96 > 4096)
    throw new Error(
      'The complete holder signer list needs multiple reviewed packets; no slots were removed.',
    );
  if (singlePacket && active.length + 2 > 12)
    throw new Error(
      'Complete holder group exceeds the pinned v1 limit of 12 signers and needs multiple reviewed packets; no partial packet was returned.',
    );
  const created = await buildPumpCreateMessage(input.create);
  const global = decodePumpLaunchConfig('Global', input.create.global.data);
  if (
    typeof global.initial_real_token_reserves !== 'bigint' ||
    exactBase >= global.initial_real_token_reserves
  )
    throw new Error(
      'Combined exact-output buys must leave tokens on the curve.',
    );
  const units: { holderIndex: number | null; instructions: Instruction[] }[] = [
    { holderIndex: null, instructions: [created.instruction] },
  ];
  const buyers = [];
  if (input.developer) {
    const built = await buildPumpCreateAndBuyMessage({
      create: input.create,
      ...input.developer,
      transactionVersion: 1,
    });
    units[0].instructions.push(...built.instructions.slice(1));
    buyers.push(built);
  }
  for (const [holderIndex, holder] of input.holders.entries()) {
    current();
    if (holder.kind === 'none') continue;
    const built = await buildPumpCreateAndBuyMessage({
      create: { ...input.create, payer: holder.address },
      tokenAmountRaw:
        holder.kind === 'exact-base-output'
          ? holder.tokenAmountRaw
          : holder.minimumTokenOutputRaw,
      maximumQuoteCostRaw:
        holder.kind === 'exact-base-output'
          ? holder.maximumQuoteCostRaw
          : holder.quoteAmountRaw,
      transactionVersion: 1,
    });
    if (identities.includes(built.buybackRecipient))
      throw new Error(
        'Buyback recipient cannot be a selected trading identity.',
      );
    const setup = built.instructions.slice(1);
    if (holder.kind === 'exact-quote-input') {
      const original = setup.at(-1)!;
      if (original.accounts?.length !== quoteSchema.instruction.accounts.length)
        throw new Error('Pinned quote-buy account roles differ.');
      const data = new Uint8Array(25);
      data.set(quoteSchema.instruction.discriminator);
      const view = new DataView(data.buffer);
      view.setBigUint64(8, positive(holder.quoteAmountRaw), true);
      view.setBigUint64(16, positive(holder.minimumTokenOutputRaw), true);
      data[24] = 0;
      setup[setup.length - 1] = { ...original, data };
    }
    units.push({ holderIndex, instructions: setup });
    buyers.push(built);
  }
  current();
  return { input, created, active, units, buyers };
}

/** One complete unsigned packet. Never silently groups or removes selected wallets. */
export async function buildPumpCreateHolderMessage(
  supplied: PumpHolderMessageInput,
  signal?: AbortSignal,
) {
  const { input, created, active, units, buyers } =
    await collectPumpHolderInstructionUnits(supplied, signal, true);
  const current = () => {
    if (signal?.aborted)
      throw new Error('Holder packet construction cancelled.');
  };
  const instructions = units.flatMap((unit) => unit.instructions);
  const resourceLimits = {
    computeUnitLimit: 1400000,
    loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
    priorityFeeLamports: 0n,
  };
  const message = appendTransactionMessageInstructions(
    instructions,
    setTransactionMessageConfig(
      resourceLimits,
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(input.create.blockhash),
          lastValidBlockHeight: input.create.lastValidBlockHeight,
        },
        setTransactionMessageFeePayer(
          address(input.create.payer),
          createTransactionMessage({ version: 1 }),
        ),
      ),
    ),
  );
  const accountCount = new Set([
    input.create.payer,
    ...instructions.flatMap((i) => [
      String(i.programAddress),
      ...(i.accounts ?? []).map((a) => String(a.address)),
    ]),
  ]).size;
  if (accountCount > 64)
    throw new Error(
      `Complete holder group needs multiple reviewed packets (${accountCount} accounts; pinned compiler limit 64); no partial packet was returned.`,
    );
  const compiled = compileTransactionMessage(message);
  const required = [
    input.create.payer,
    input.create.mint,
    ...active.map((h) => h.address),
  ];
  const signers = compiled.staticAccounts
    .slice(0, compiled.header.numSignerAccounts)
    .map(String);
  if (
    signers.length !== required.length ||
    signers[0] !== input.create.payer ||
    required.some((k) => !signers.includes(k))
  )
    throw new Error('Complete holder signer set differs.');
  const tx = compileTransaction(message),
    packet = Uint8Array.from(getTransactionEncoder().encode(tx));
  if (packet.length > 4096)
    throw new Error(
      `All holder buys require multiple reviewed packets (${packet.length} bytes); no partial packet was returned.`,
    );
  if (Object.values(tx.signatures).some((s) => s !== null))
    throw new Error('Holder launch packet must remain unsigned.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', packet));
  current();
  return {
    format: 'pump-create-holders-unsigned-v1' as const,
    transactionVersion: 1 as const,
    executionAllowed: false as const,
    signingAllowed: false as const,
    simulationRequired: true as const,
    containsHolderBuys: true as const,
    completeLaunch: false as const,
    containsDeveloperBuy: !!input.developer,
    holderSlots: input.holders,
    activeHolderCount: active.length,
    requiredSigners: signers,
    quote: created.quote,
    quoteMint: input.create.quoteMint,
    resourceLimits: { ...resourceLimits, priorityFeeLamports: '0' },
    packetBytes: packet.length,
    packetLimit: 4096,
    accountCount,
    accountLimit: 64,
    transaction: getBase64Decoder().decode(packet),
    packetSha256: Array.from(digest, (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    lastValidBlockHeight: input.create.lastValidBlockHeight.toString(),
    instructions,
    migrationSimulationRequired: input.holders.some(
      (h) => h.kind === 'exact-quote-input',
    ),
    buyerAccounts: buyers.map((b) => ({
      payer: b.payer,
      userBaseAccount: b.userBaseAccount,
      userQuoteAccount: b.userQuoteAccount,
      volumeAccount: b.volumeAccount,
      buybackRecipient: b.buybackRecipient,
      buybackAccount: b.buybackAccount,
    })),
  };
}
