import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import {
  verifyJitoBundleSimulationFrames,
  type JitoBundleSimulationPacket,
  type JitoSimulationAccount,
} from './jito-bundle-simulation-frames';
import { snapshotJitoEvidence } from './jito-evidence-json';
import { inspectJitoCpmmUnsignedPacket } from './jito-cpmm-unsigned-packet';
import { replayJitoCpmmSwapState } from './jito-cpmm-state-replay';
import { jitoTipLamports } from './jito-bundle';
import { PUMP_GROUP_JITO_TIP_ACCOUNTS } from './pump-group-broadcast';
import { PAIR_CLOCK } from './pair-stock-clock';
import { inspectJitoTipReceiver } from './jito-tip-account-evidence';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from './pair-rent-evidence';

const SYSTEM = '11111111111111111111111111111111';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const fail = (): never => {
  throw Error('CPMM supplied bundle settlement refused.');
};
type Raw = Parameters<typeof replayJitoCpmmSwapState>[0]['before'][number];
function uint(v: unknown) {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    return fail();
  return BigInt(v);
}
function exact(
  v: unknown,
  fields: string[],
): asserts v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== fields.length ||
    !fields.every((k) => Object.hasOwn(v, k))
  )
    return fail();
}
function raw(address: string, a: JitoSimulationAccount | null): Raw {
  if (!a) return fail();
  return {
    address,
    owner: a.owner,
    lamports: a.lamports,
    executable: a.executable,
    dataBase64: Buffer.from(a.data).toString('base64'),
  };
}

/** Supplied evidence only. No network, provider, runtime-code or same-bank approval. */
export async function replayJitoCpmmBundleSettlement(
  input: {
    swaps: Parameters<typeof inspectJitoCpmmUnsignedPacket>[0][];
    tip: { transaction: string; recipient: string; amountRaw: string };
    walletReserves: { wallet: string; reserveLamports: string }[];
    packets: JitoBundleSimulationPacket[];
    minimumSlot: number;
    simulationBankSlot: number;
    result: unknown;
    bankAccounts: { slot: number; before: Raw[]; after: Raw[] };
  },
  signal: AbortSignal,
) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  const value = snapshotJitoEvidence(input, 4 * 1024 * 1024);
  exact(value, [
    'swaps',
    'tip',
    'walletReserves',
    'packets',
    'minimumSlot',
    'simulationBankSlot',
    'result',
    'bankAccounts',
  ]);
  signal.throwIfAborted();
  if (
    !Array.isArray(value.swaps) ||
    value.swaps.length < 1 ||
    value.swaps.length > 4 ||
    !Array.isArray(value.packets) ||
    value.packets.length !== value.swaps.length + 1 ||
    !Number.isSafeInteger(value.minimumSlot) ||
    value.minimumSlot < 0 ||
    !Number.isSafeInteger(value.simulationBankSlot)
  )
    return fail();
  exact(value.tip, ['transaction', 'recipient', 'amountRaw']);
  exact(value.bankAccounts, ['slot', 'before', 'after']);
  const tipAmount = BigInt(jitoTipLamports(value.tip.amountRaw));
  if (
    !(PUMP_GROUP_JITO_TIP_ACCOUNTS as readonly string[]).includes(
      value.tip.recipient,
    ) ||
    value.bankAccounts.slot !== value.simulationBankSlot ||
    !Array.isArray(value.bankAccounts.before) ||
    !Array.isArray(value.bankAccounts.after)
  )
    return fail();
  for (const list of [value.bankAccounts.before, value.bankAccounts.after]) {
    if (
      list.length !== 2 ||
      list[0]?.address !== PAIR_CLOCK ||
      list[1]?.address !== PAIR_RENT
    )
      return fail();
  }
  if (
    JSON.stringify(value.bankAccounts.before) !==
    JSON.stringify(value.bankAccounts.after)
  )
    return fail();
  const rentRaw = value.bankAccounts.before[1];
  const minimumSystemRent = BigInt(
    pairRentMinimumRaw(
      inspectPairRentAccount({
        owner: rentRaw.owner,
        executable: rentRaw.executable,
        lamports: rentRaw.lamports,
        data: [rentRaw.dataBase64, 'base64'],
      }),
      0,
    ),
  );
  const bound: Awaited<ReturnType<typeof inspectJitoCpmmUnsignedPacket>>[] = [];
  for (let i = 0; i < value.swaps.length; i++) {
    if (
      value.packets[i]?.transaction !== value.swaps[i].transaction ||
      value.packets[i]?.loadedAddresses !== null
    )
      return fail();
    bound.push(await inspectJitoCpmmUnsignedPacket(value.swaps[i]));
  }
  const tipPacket = value.packets.at(-1)!;
  if (
    tipPacket.transaction !== value.tip.transaction ||
    tipPacket.loadedAddresses !== null ||
    bound.some((s) => s.blockhash !== bound[0].blockhash)
  )
    return fail();
  const frames = await verifyJitoBundleSimulationFrames({
    packets: value.packets,
    minimumSlot: value.minimumSlot,
    simulationBankSlot: value.simulationBankSlot,
    result: value.result,
  });
  const last = frames.frames.at(-1)!,
    payer = bound[0].payer;
  if (
    last.keys.length !== 3 ||
    last.keys[0] !== payer ||
    last.keys[1] !== value.tip.recipient ||
    last.keys[2] !== SYSTEM ||
    frames.frames.slice(0, -1).some((f) => f.keys.includes(value.tip.recipient))
  )
    return fail();
  const tipTx = getTransactionDecoder().decode(
    Buffer.from(value.tip.transaction, 'base64'),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    tipTx.messageBytes,
  );
  if (
    (message.version !== 0 && message.version !== 'legacy') ||
    message.staticAccounts.length !== 3 ||
    message.header.numSignerAccounts !== 1 ||
    message.header.numReadonlySignerAccounts !== 0 ||
    message.header.numReadonlyNonSignerAccounts !== 1 ||
    (message.version === 0 &&
      (message.addressTableLookups?.length ?? 0) !== 0) ||
    message.lifetimeToken !== bound[0].blockhash ||
    message.instructions.length !== 1
  )
    return fail();
  const signatures = Object.entries(tipTx.signatures);
  if (
    signatures.length !== 1 ||
    signatures[0][0] !== payer ||
    (signatures[0][1] && Array.from(signatures[0][1]).some((b) => b !== 0))
  )
    return fail();
  const ix = message.instructions[0],
    data = Buffer.from(ix.data ?? []);
  if (
    ix.programAddressIndex !== 2 ||
    JSON.stringify(Array.from(ix.accountIndices ?? [])) !== '[0,1]' ||
    data.length !== 12 ||
    data.readUInt32LE(0) !== 2 ||
    data.readBigUInt64LE(4) !== tipAmount
  )
    return fail();
  const tipReceiverEvidence = [];
  for (const account of [last.preAccounts[1], last.postAccounts[1]]) {
    if (!account) return fail();
    tipReceiverEvidence.push(
      await inspectJitoTipReceiver({
        address: value.tip.recipient,
        account: {
          ...account,
          data: [Buffer.from(account.data).toString('base64'), 'base64'],
        },
        rentAccount: { ...rentRaw, data: [rentRaw.dataBase64, 'base64'] },
      }),
    );
    signal.throwIfAborted();
  }
  if (
    uint(last.postAccounts[1]!.lamports) -
      uint(last.preAccounts[1]!.lamports) !==
      tipAmount ||
    uint(last.preAccounts[0]!.lamports) -
      uint(last.postAccounts[0]!.lamports) !==
      tipAmount + uint(last.feeLamports)
  )
    return fail();
  const wallets = [...new Set(bound.map((s) => s.payer))];
  if (
    !Array.isArray(value.walletReserves) ||
    value.walletReserves.length !== wallets.length
  )
    return fail();
  const reserves = new Map<string, bigint>();
  for (const [i, r] of value.walletReserves.entries()) {
    exact(r, ['wallet', 'reserveLamports']);
    if (r.wallet !== wallets[i]) return fail();
    reserves.set(r.wallet, uint(r.reserveLamports));
  }
  if (
    frames.frames.some((f) => f.keys.slice(1).some((k) => wallets.includes(k)))
  )
    return fail();
  const swaps = [];
  for (let i = 0; i < bound.length; i++) {
    signal.throwIfAborted();
    const b = bound[i],
      f = frames.frames[i];
    if (
      f.keys[0] !== b.payer ||
      uint(f.preAccounts[0]!.lamports) - uint(f.postAccounts[0]!.lamports) !==
        uint(f.feeLamports)
    )
      return fail();
    const tokenIndex = f.keys.indexOf(TOKEN);
    if (
      tokenIndex < 0 ||
      f.preAccounts[tokenIndex]?.executable !== true ||
      f.postAccounts[tokenIndex]?.executable !== true
    )
      return fail();
    const keys = [
      b.pool,
      b.source,
      b.destination,
      b.inputVault,
      b.outputVault,
      b.config,
      b.observation,
      b.inputMint,
      b.outputMint,
    ];
    const before = keys.map((k) => raw(k, f.preAccounts[f.keys.indexOf(k)]));
    const after = keys.map((k) => raw(k, f.postAccounts[f.keys.indexOf(k)]));
    swaps.push(
      await replayJitoCpmmSwapState(
        {
          packet: value.swaps[i],
          minimumSlot: value.minimumSlot,
          slot: frames.slot,
          before: [...before, ...value.bankAccounts.before],
          after: [...after, ...value.bankAccounts.after],
        },
        signal,
      ),
    );
  }
  const walletBalances = wallets.map((wallet) => {
    const used = frames.frames.filter((f) => f.keys[0] === wallet),
      first = used[0],
      final = used.at(-1)!;
    const fees = used.reduce((n, f) => n + uint(f.feeLamports), 0n),
      tip = wallet === payer ? tipAmount : 0n,
      reserve = reserves.get(wallet)!;
    const initial = uint(first.preAccounts[0]!.lamports),
      ending = uint(final.postAccounts[0]!.lamports);
    if (
      initial <
        fees +
          tip +
          (reserve > minimumSystemRent ? reserve : minimumSystemRent) ||
      ending < reserve ||
      ending < minimumSystemRent ||
      initial - ending !== fees + tip
    )
      return fail();
    return {
      wallet,
      initialLamports: initial.toString(),
      finalLamports: ending.toString(),
      networkFeeLamports: fees.toString(),
      tipLamports: tip.toString(),
      reserveLamports: reserve.toString(),
      requiredSystemRentLamports: minimumSystemRent.toString(),
    };
  });
  signal.throwIfAborted();
  return {
    format: 'jito-cpmm-supplied-bundle-replay-v1' as const,
    slot: frames.slot,
    transactionSha256s: frames.frames.map((f) => f.transactionSha256),
    swaps,
    walletBalances,
    tipLamports: tipAmount.toString(),
    tipReceiverEvidence,
    tipReceiverRentCoverageChecked: true as const,
    feeTipSettlementChecked: true as const,
    crossFrameContinuityChecked: true as const,
    fullAccountVectorsChecked: true as const,
    ordinaryAccountRentCoverageChecked: true as const,
    sourceAuthenticated: false as const,
    feeBankVerified: false as const,
    accountProvenanceVerified: false as const,
    runtimePrivilegesVerified: false as const,
    programApproved: false as const,
    economicOutputVerified: false as const,
    bankVerified: false as const,
    providerQualified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
