import {
  AccountRole,
  address,
  blockhash,
  getAddressEncoder,
  getProgramDerivedAddress,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  compileTransaction,
  getTransactionEncoder,
  getBase64Decoder,
  createNoopSigner,
  compressTransactionMessageUsingAddressLookupTables,
  setTransactionMessageConfig,
  type Instruction,
} from '@solana/kit-v1';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
} from '@solana-program/token';
import {
  buildPumpCreateMessage,
  pumpCreateAddresses,
  type PumpCreateInput,
} from './pump-launch-message';
import {
  decodePumpLaunchConfig,
  PUMP_LAUNCH_PROGRAM,
  PUMP_TOKEN_2022,
  PUMP_NATIVE_QUOTE,
} from './pump-launch-config';
import schema from './pump-initial-buy-schema.json';
import { pumpLaunchLookupTables } from './pump-launch-lookups';
import type { PumpLaunchAccount } from './pump-launch-config';
const SYSTEM = '11111111111111111111111111111111';
const enc = getAddressEncoder(),
  utf8 = new TextEncoder();
const uint = (value: string) => {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(value) ||
    BigInt(value) > (1n << 64n) - 1n
  )
    throw new Error(
      'Initial buy amounts must be positive canonical u64 strings.',
    );
  return BigInt(value);
};
export type PumpCreateAndBuyInput = {
  create: PumpCreateInput;
  tokenAmountRaw: string;
  maximumQuoteCostRaw: string;
  buybackRecipientIndex?: number;
  lookupTables?: PumpLaunchAccount[];
  transactionVersion?: 0 | 1;
};
/** Constructs only an unsigned atomic packet. Approval requires a separate independent simulation policy. */
export async function buildPumpCreateAndBuyMessage(
  supplied: PumpCreateAndBuyInput,
) {
  if (
    Object.keys(supplied).some(
      (k) =>
        ![
          'create',
          'tokenAmountRaw',
          'maximumQuoteCostRaw',
          'buybackRecipientIndex',
          'lookupTables',
          'transactionVersion',
        ].includes(k),
    )
  )
    throw new Error('Unsupported initial buy option.');
  const input = structuredClone(supplied),
    amount = uint(input.tokenAmountRaw),
    maximum = uint(input.maximumQuoteCostRaw);
  const version = input.transactionVersion ?? 1;
  if (version !== 0 && version !== 1)
    throw new Error('Unsupported atomic launch transaction version.');
  if (version === 1 && input.lookupTables?.length)
    throw new Error(
      'Version 1 launch packets cannot use address lookup tables.',
    );
  const created = await buildPumpCreateMessage(input.create);
  const global = decodePumpLaunchConfig('Global', input.create.global.data);
  if (
    typeof global.initial_real_token_reserves !== 'bigint' ||
    amount >= global.initial_real_token_reserves
  )
    throw new Error(
      'Initial buy must leave tokens on the bonding curve; migration needs a separate reviewed path.',
    );
  const recipients = global.buyback_fee_recipients;
  const index = input.buybackRecipientIndex ?? 0;
  if (
    !Array.isArray(recipients) ||
    recipients.length !== 8 ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= 8
  )
    throw new Error('Pump buyback recipient configuration differs.');
  const recipient = address(recipients[index] as string),
    payer = address(input.create.payer),
    mint = address(input.create.mint),
    quoteMint = address(input.create.quoteMint);
  if ([SYSTEM, payer, mint].includes(recipient))
    throw new Error(
      'Pump buyback recipient is not an independent configured account.',
    );
  const quoteProgram = address(created.quote.tokenProgram),
    baseProgram = address(PUMP_TOKEN_2022);
  const pdas = await pumpCreateAddresses(mint);
  const ata = async (
    owner: ReturnType<typeof address>,
    tokenMint: ReturnType<typeof address>,
    program: ReturnType<typeof address>,
  ) =>
    (
      await findAssociatedTokenPda({
        owner,
        mint: tokenMint,
        tokenProgram: program,
      })
    )[0];
  const [userBase, userQuote, curveQuote, buyback] = await Promise.all([
    ata(payer, mint, baseProgram),
    ata(payer, quoteMint, quoteProgram),
    ata(pdas.bondingCurve, quoteMint, quoteProgram),
    quoteMint === PUMP_NATIVE_QUOTE
      ? Promise.resolve(recipient)
      : ata(recipient, quoteMint, quoteProgram),
  ]);
  const [volume] = await getProgramDerivedAddress({
    programAddress: address(PUMP_LAUNCH_PROGRAM),
    seeds: [utf8.encode('user_volume_accumulator'), enc.encode(payer)],
  });
  const [feeConfig] = await getProgramDerivedAddress({
    programAddress: address(schema.feeProgram),
    seeds: [
      utf8.encode('fee_config'),
      enc.encode(address(PUMP_LAUNCH_PROGRAM)),
    ],
  });
  if (feeConfig !== '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt')
    throw new Error('Pinned Pump fee configuration differs.');
  const values = [
    pdas.global,
    mint,
    quoteMint,
    baseProgram,
    quoteProgram,
    pdas.bondingCurve,
    pdas.associatedCurve,
    curveQuote,
    payer,
    userBase,
    userQuote,
    volume,
    feeConfig,
    buyback,
    address(SYSTEM),
    pdas.eventAuthority,
    address(PUMP_LAUNCH_PROGRAM),
  ];
  const data = new Uint8Array(25);
  data.set(schema.instruction.discriminator);
  const view = new DataView(data.buffer);
  view.setBigUint64(8, amount, true);
  view.setBigUint64(16, maximum, true);
  data[24] = 0;
  const buy: Instruction = {
    programAddress: address(PUMP_LAUNCH_PROGRAM),
    accounts: schema.instruction.accounts.map((a, n) => ({
      address: values[n],
      role:
        'signer' in a && a.signer
          ? AccountRole.WRITABLE_SIGNER
          : 'writable' in a && a.writable
            ? AccountRole.WRITABLE
            : AccountRole.READONLY,
    })),
    data,
  };
  const createUserBase = getCreateAssociatedTokenIdempotentInstruction({
    payer: createNoopSigner(payer),
    ata: userBase,
    owner: payer,
    mint,
    tokenProgram: baseProgram,
  });
  const createBuybackQuote =
    quoteMint === PUMP_NATIVE_QUOTE
      ? []
      : [
          getCreateAssociatedTokenIdempotentInstruction({
            payer: createNoopSigner(payer),
            ata: buyback,
            owner: recipient,
            mint: quoteMint,
            tokenProgram: quoteProgram,
          }),
        ];
  const budgetData = new Uint8Array(5);
  budgetData[0] = 2;
  new DataView(budgetData.buffer).setUint32(1, 1400000, true);
  const budget: Instruction = {
    programAddress: address('ComputeBudget111111111111111111111111111111'),
    data: budgetData,
  };
  const instructions =
    version === 1
      ? [created.instruction, createUserBase, ...createBuybackQuote, buy]
      : [
          budget,
          created.instruction,
          createUserBase,
          ...createBuybackQuote,
          buy,
        ];
  const lookups = await pumpLaunchLookupTables(input.lookupTables ?? [], [
    created.configurationSlotMin,
    created.configurationSlotMax,
  ]);
  const lifetime = <T extends ReturnType<typeof createTransactionMessage>>(
    initial: T,
  ) =>
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(input.create.blockhash),
        lastValidBlockHeight: input.create.lastValidBlockHeight,
      },
      setTransactionMessageFeePayer(payer, initial),
    );
  const resourceLimits = {
    computeUnitLimit: 1400000,
    loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
    priorityFeeLamports: 0n,
  };
  const message =
    version === 1
      ? appendTransactionMessageInstructions(
          instructions,
          setTransactionMessageConfig(
            resourceLimits,
            lifetime(createTransactionMessage({ version: 1 })),
          ),
        )
      : compressTransactionMessageUsingAddressLookupTables(
          appendTransactionMessageInstructions(
            instructions,
            lifetime(createTransactionMessage({ version: 0 })),
          ),
          lookups.mappings,
        );
  const compiled = compileTransactionMessage(message);
  if (
    compiled.header.numSignerAccounts !== 2 ||
    compiled.staticAccounts[0] !== payer ||
    compiled.staticAccounts[1] !== mint
  )
    throw new Error('Atomic initial buy signer set differs.');
  const transaction = compileTransaction(message),
    packet = Uint8Array.from(getTransactionEncoder().encode(transaction));
  const packetLimit = version === 1 ? 4096 : 1232;
  if (packet.length > packetLimit)
    throw new Error(
      `Atomic create and initial buy needs an admitted address table or bundle (${packet.length} bytes).`,
    );
  if (Object.values(transaction.signatures).some((s) => s !== null))
    throw new Error('Initial buy packet must remain unsigned.');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', packet));
  return {
    format: 'pump-create-buy-v3-unsigned-v1' as const,
    executionAllowed: false as const,
    signingAllowed: false as const,
    simulationRequired: true as const,
    containsInitialBuy: true as const,
    transactionVersion: version,
    packetLimit,
    resourceLimits:
      version === 1 ? { ...resourceLimits, priorityFeeLamports: '0' } : null,
    payer,
    mint,
    quoteMint,
    quote: created.quote,
    tokenAmountRaw: amount.toString(),
    maximumQuoteCostRaw: maximum.toString(),
    buybackRecipient: recipient,
    buybackAccount: buyback,
    feeConfig,
    userBaseAccount: userBase,
    userQuoteAccount: userQuote,
    volumeAccount: volume,
    transaction: getBase64Decoder().decode(packet),
    packetSha256: Array.from(digest, (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    packetBytes: packet.length,
    lastValidBlockHeight: input.create.lastValidBlockHeight.toString(),
    instructions,
    lookupTables: lookups.observations,
  };
}
