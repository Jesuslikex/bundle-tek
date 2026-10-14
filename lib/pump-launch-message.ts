import {
  AccountRole,
  address,
  blockhash,
  getAddressEncoder,
  getProgramDerivedAddress,
  isOffCurveAddress,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  compileTransactionMessage,
  compileTransaction,
  getTransactionEncoder,
  getBase64Decoder,
  type Instruction,
} from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import schema from './pump-launch-schema.json';
import {
  PUMP_LAUNCH_PROGRAM,
  PUMP_NATIVE_QUOTE,
  PUMP_TOKEN_2022,
  pumpListedQuote,
  type PumpLaunchAccount,
} from './pump-launch-config';

const MAYHEM = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const SYSTEM = '11111111111111111111111111111111';
const utf8 = new TextEncoder(),
  encoder = getAddressEncoder();
const hash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
export type PumpCreateInput = {
  name: string;
  symbol: string;
  uri: string;
  payer: string;
  mint: string;
  quoteMint: string;
  blockhash: string;
  lastValidBlockHeight: bigint;
  global: PumpLaunchAccount;
  quoteMintAccount?: PumpLaunchAccount;
  quoteControl?: PumpLaunchAccount;
};

export async function pumpCreateAddresses(mintValue: string) {
  const mint = address(mintValue),
    program = address(PUMP_LAUNCH_PROGRAM),
    mayhem = address(MAYHEM);
  const pda = async (
    programAddress: typeof program,
    seed: string,
    extra?: typeof mint,
  ) =>
    (
      await getProgramDerivedAddress({
        programAddress,
        seeds: [utf8.encode(seed), ...(extra ? [encoder.encode(extra)] : [])],
      })
    )[0];
  const mintAuthority = await pda(program, 'mint-authority');
  const bondingCurve = await pda(program, 'bonding-curve', mint);
  const global = await pda(program, 'global'),
    control = await pda(program, 'quote-control');
  const globalParams = await pda(mayhem, 'global-params'),
    solVault = await pda(mayhem, 'sol-vault');
  const mayhemState = await pda(mayhem, 'mayhem-state', mint),
    eventAuthority = await pda(program, '__event_authority');
  const tokenProgram = address(PUMP_TOKEN_2022);
  const [associatedCurve] = await findAssociatedTokenPda({
    mint,
    owner: bondingCurve,
    tokenProgram,
  });
  const [mayhemTokenVault] = await findAssociatedTokenPda({
    mint,
    owner: solVault,
    tokenProgram,
  });
  return {
    mintAuthority,
    bondingCurve,
    global,
    control,
    globalParams,
    solVault,
    mayhemState,
    eventAuthority,
    associatedCurve,
    mayhemTokenVault,
  };
}

/** Create-only, unsigned packet. Not an approval, simulation, buy or bundle. */
export async function buildPumpCreateMessage(supplied: PumpCreateInput) {
  const allowed = [
    'name',
    'symbol',
    'uri',
    'payer',
    'mint',
    'quoteMint',
    'blockhash',
    'lastValidBlockHeight',
    'global',
    'quoteMintAccount',
    'quoteControl',
  ];
  if (Object.keys(supplied).some((key) => !allowed.includes(key)))
    throw new Error('Unsupported Pump create option.');
  const input = structuredClone(supplied);
  const payer = address(input.payer),
    mint = address(input.mint),
    quoteMint = address(input.quoteMint);
  if (
    [payer, mint].some(
      (a) => isOffCurveAddress(a) || [SYSTEM, PUMP_NATIVE_QUOTE].includes(a),
    ) ||
    payer === mint ||
    quoteMint === mint
  )
    throw new Error(
      'Pump payer and new mint need distinct wallet-controlled signing keys.',
    );
  for (const [value, max] of [
    [input.name, 32],
    [input.symbol, 13],
    [input.uri, 200],
  ] as const)
    if (
      typeof value !== 'string' ||
      !value.trim() ||
      utf8.encode(value).length > max ||
      value
        .split('')
        .some(
          (character) =>
            character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        )
    )
      throw new Error(
        'Pump launch identity exceeds its byte limits or contains control characters.',
      );
  if (!/^[A-Z0-9]{1,13}$/.test(input.symbol))
    throw new Error(
      'Pump launch symbol must use uppercase letters or numbers.',
    );
  const metadata = new URL(input.uri);
  if (
    metadata.protocol !== 'https:' ||
    metadata.username ||
    metadata.password ||
    metadata.hash
  )
    throw new Error(
      'Review an HTTPS metadata URI before preparing a Pump launch.',
    );
  if (
    typeof input.lastValidBlockHeight !== 'bigint' ||
    input.lastValidBlockHeight <= 0n ||
    input.lastValidBlockHeight > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error('Pump blockhash lifetime differs.');
  const accounts = await pumpCreateAddresses(mint);
  const observations = [
    input.global,
    ...(quoteMint !== PUMP_NATIVE_QUOTE && input.quoteMintAccount
      ? [input.quoteMintAccount]
      : []),
    ...(quoteMint !== PUMP_NATIVE_QUOTE && input.quoteControl
      ? [input.quoteControl]
      : []),
  ];
  const slots = observations.map((a) => a.slot);
  if (
    slots.some((s) => !Number.isSafeInteger(s) || s < 0) ||
    Math.max(...slots) - Math.min(...slots) > 32
  )
    throw new Error('Read consistent Pump launch configuration slots.');
  const quote = pumpListedQuote({
    global: input.global,
    quoteMint,
    mint: input.quoteMintAccount,
    control: input.quoteControl,
    globalAddress: accounts.global,
    controlAddress: accounts.control,
  });
  const values = [
    mint,
    accounts.mintAuthority,
    accounts.bondingCurve,
    accounts.associatedCurve,
    accounts.global,
    payer,
    address(SYSTEM),
    address(PUMP_TOKEN_2022),
    address(ATA),
    address(MAYHEM),
    accounts.globalParams,
    accounts.solVault,
    accounts.mayhemState,
    accounts.mayhemTokenVault,
    accounts.eventAuthority,
    address(PUMP_LAUNCH_PROGRAM),
  ];
  const metas = schema.instruction.accounts.map((account, index) => ({
    address: values[index],
    role: account.signer
      ? account.writable
        ? AccountRole.WRITABLE_SIGNER
        : AccountRole.READONLY_SIGNER
      : account.writable
        ? AccountRole.WRITABLE
        : AccountRole.READONLY,
  }));
  if (quote.source !== 'native') {
    const [ata] = await findAssociatedTokenPda({
      mint: quoteMint,
      owner: accounts.bondingCurve,
      tokenProgram: address(quote.tokenProgram),
    });
    metas.push(
      { address: quoteMint, role: AccountRole.READONLY },
      { address: ata, role: AccountRole.WRITABLE },
      { address: address(quote.tokenProgram), role: AccountRole.READONLY },
    );
    if (quote.source === 'quote-control')
      metas.push({ address: accounts.control, role: AccountRole.READONLY });
  }
  const string = (value: string) => {
    const data = utf8.encode(value),
      bytes = new Uint8Array(4 + data.length);
    new DataView(bytes.buffer).setUint32(0, data.length, true);
    bytes.set(data, 4);
    return bytes;
  };
  // The IDL's OptionBool/OptionU64 wrappers are tuple structs, not Borsh Option.
  // Explicit false cashback, zero custom creator fee, false holder rewards.
  const parts = [
    Uint8Array.from(schema.instruction.discriminator),
    string(input.name),
    string(input.symbol),
    string(input.uri),
    Uint8Array.from(encoder.encode(payer)),
    new Uint8Array(11),
  ];
  const data = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  const create: Instruction = {
    programAddress: address(PUMP_LAUNCH_PROGRAM),
    accounts: metas,
    data,
  };
  const budgetData = new Uint8Array(5);
  budgetData[0] = 2;
  new DataView(budgetData.buffer).setUint32(1, 300000, true);
  const budget: Instruction = {
    programAddress: address('ComputeBudget111111111111111111111111111111'),
    data: budgetData,
  };
  const message = appendTransactionMessageInstructions(
    [budget, create],
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(input.blockhash),
        lastValidBlockHeight: input.lastValidBlockHeight,
      },
      setTransactionMessageFeePayer(
        payer,
        createTransactionMessage({ version: 'legacy' }),
      ),
    ),
  );
  const compiled = compileTransactionMessage(message);
  if (
    compiled.header.numSignerAccounts !== 2 ||
    compiled.staticAccounts[0] !== payer ||
    compiled.staticAccounts[1] !== mint
  )
    throw new Error('Pump create signer set differs.');
  const transaction = compileTransaction(message),
    bytes = Uint8Array.from(getTransactionEncoder().encode(transaction));
  if (
    bytes.length > 1232 ||
    Object.values(transaction.signatures).some(
      (signature) => signature !== null,
    )
  )
    throw new Error('Pump create unsigned packet envelope differs.');
  return {
    format: 'pump-create-v2-unsigned-v1' as const,
    executionAllowed: false as const,
    signingAllowed: false as const,
    simulationRequired: true as const,
    containsInitialBuy: false as const,
    mayhemMode: false as const,
    cashback: false as const,
    holderRewards: false as const,
    customCreatorFeeBps: 0 as const,
    payer,
    mint,
    creator: payer,
    name: input.name,
    symbol: input.symbol,
    metadataUri: input.uri,
    quoteMint,
    quote,
    transaction: getBase64Decoder().decode(bytes),
    packetSha256: await hash(bytes),
    packetBytes: bytes.length,
    lastValidBlockHeight: input.lastValidBlockHeight.toString(),
    configurationSlotMin: Math.min(...slots),
    configurationSlotMax: Math.max(...slots),
    configuration: await Promise.all(
      observations.map(async (a) => ({
        address: a.address,
        owner: a.owner,
        sha256: await hash(a.data),
        slot: a.slot,
      })),
    ),
    instruction: create,
  };
}
