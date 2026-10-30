/** Synthetic unsigned whole-bundle economics evidence. No real account/RPC/send path. */
import {
  address,
  getBase64Decoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  type TransactionMessageBytes,
} from '@solana/kit';
import { getExtensionEncoder } from '@solana-program/token-2022';
import bs58 from 'bs58';
import { JITO_TIP_PAYMENT_OWNER } from '../lib/jito-tip-account-evidence';
import nacl from 'tweetnacl';
import { nativeWarmupFixture } from './warmup-native-fixture';
import { reviewUnsignedSwapOrder } from '../lib/unsigned-swap-order';
import { reviewSwapInstructions } from '../lib/swap-instruction-review';
import { assessJupiterRoute } from '../lib/jupiter-route-assessment';
import { assessSimulatedSwapTokens } from '../lib/simulated-swap-balances';
import {
  requireWarmupSigningReview,
  type WarmupSigningReview,
} from '../lib/warmup-signing';
import {
  inspectNativeWithdrawal,
  type NativeWithdrawalReview,
} from '../lib/native-withdrawal';
import { solanaTransferMessage } from '../lib/solana-transfer-message';
import {
  bundleFingerprint,
  requireJitoManifest,
  type JitoBundleManifest,
} from '../lib/jito-bundle';
import {
  verifyJitoBundleSimulationFrames,
  type JitoBundleSimulationPacket,
} from '../lib/jito-bundle-simulation-frames';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from '../lib/pair-rent-evidence';
import type { ImportedSwapSimulation } from '../lib/imported-swap-simulation';
const SYSTEM = '11111111111111111111111111111111';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
// Executable ownership/bytes are structural synthetic placeholders, not program qualification.
const LOADER = 'NativeLoader1111111111111111111111111111111';
const POOL = bs58.encode(new Uint8Array(32).fill(81));
const POOL_TOKEN = bs58.encode(new Uint8Array(32).fill(82));
const POOL_TOKEN_AUTHORITY = bs58.encode(new Uint8Array(32).fill(83));
const TIP_RECIPIENT = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
type RawAccount = {
  owner: string;
  executable: boolean;
  lamports: string;
  data: string[];
};
type RawFrame = {
  err: null;
  preExecutionAccounts: (RawAccount | null)[];
  postExecutionAccounts: (RawAccount | null)[];
  loadedAddresses: { writable: string[]; readonly: string[] };
  fee: string;
  unitsConsumed: number;
  loadedAccountsDataSize: string;
};
const account = (
  lamports: string,
  owner = SYSTEM,
  data = '',
  executable = false,
): RawAccount => ({ owner, executable, lamports, data: [data, 'base64'] });
const hash = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes).buffer),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');

export async function jitoSequentialEconomicsFixture(
  options: {
    side?: 'Buy' | 'Sell';
    lookup?: boolean;
    token2022?: boolean;
    keepWrapped?: boolean;
    wallets?: number;
    exposeOtherWallets?: boolean;
    includeRentSysvar?: boolean;
    /** Mathematical burn branch only; no DEX execution qualification. */
    burnInput?: boolean;
  } = {},
) {
  const side = options.side ?? 'Buy',
    wallets = options.wallets ?? 1;
  if (!Number.isInteger(wallets) || wallets < 1 || wallets > 4)
    throw Error('Synthetic fixture requires one to four wallets.');
  if (options.burnInput && side !== 'Sell')
    throw Error('Synthetic input burn requires Sell.');
  const minimumSlot = 100,
    simulationBankSlot = 101,
    projectId = crypto.randomUUID(),
    sessionId = crypto.randomUUID();
  // Derive the deterministic public roster once without producing any signatures.
  const walletRoster = Array.from({ length: wallets }, (_, index) => {
    const seed = new Uint8Array(32).fill(7 + index);
    const pair = nacl.sign.keyPair.fromSeed(seed);
    const publicAddress = bs58.encode(pair.publicKey);
    pair.secretKey.fill(0);
    seed.fill(0);
    return publicAddress;
  });
  const rentBytes = new Uint8Array(17),
    rentView = new DataView(rentBytes.buffer);
  rentView.setBigUint64(0, 3480n, true);
  rentView.setFloat64(8, 2, true);
  rentBytes[16] = 50;
  const rawRent = account(
    '1000000',
    'Sysvar1111111111111111111111111111111111111',
    Buffer.from(rentBytes).toString('base64'),
  );
  const rentProfile = inspectPairRentAccount(rawRent);
  if (
    pairRentMinimumRaw(rentProfile, 165) !== '2039280' ||
    pairRentMinimumRaw(rentProfile, 170) !== '2074080'
  )
    throw Error('Synthetic Rent profile differs from token rent evidence.');
  const rentAccounts = {
    slot: minimumSlot,
    recheckSlot: simulationBankSlot,
    before: rawRent,
    after: structuredClone(rawRent),
  };
  const sharedState = new Map<string, RawAccount | null>();
  // If an instruction references Rent, its full-frame state must match independent evidence.
  sharedState.set(PAIR_RENT, structuredClone(rawRent));
  if (options.exposeOtherWallets)
    for (const wallet of walletRoster)
      sharedState.set(wallet, account('100000000'));
  // Foreign WSOL vault is the native-side counterpart, not a nonsigner System debit.
  const poolLamports = 1000000000000n;
  const poolReserve = BigInt(pairRentMinimumRaw(rentProfile, 165));
  const nativePoolBytes = new Uint8Array(165),
    nativePoolView = new DataView(nativePoolBytes.buffer);
  nativePoolBytes.set(
    bs58.decode('So11111111111111111111111111111111111111112'),
    0,
  );
  nativePoolBytes.set(bs58.decode(POOL_TOKEN_AUTHORITY), 32);
  nativePoolView.setBigUint64(64, poolLamports - poolReserve, true);
  nativePoolBytes[108] = 1;
  nativePoolView.setUint32(109, 1, true);
  nativePoolView.setBigUint64(113, poolReserve, true);
  sharedState.set(
    POOL,
    account(
      poolLamports.toString(),
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      Buffer.from(nativePoolBytes).toString('base64'),
    ),
  );
  const observations: {
    order: Awaited<ReturnType<typeof nativeWarmupFixture>>['order'];
    simulation: ImportedSwapSimulation;
    mints: Awaited<ReturnType<typeof nativeWarmupFixture>>['mints'];
    mintAccounts: {
      slot: number;
      recheckSlot: number;
      before: unknown[];
      after: unknown[];
    };
  }[] = [];
  const reviews: WarmupSigningReview[] = [],
    packets: JitoBundleSimulationPacket[] = [],
    frames: RawFrame[] = [],
    allKeys: string[][] = [];
  const lookupAccounts: { address: string; account: RawAccount }[] = [];
  for (let walletIndex = 0; walletIndex < wallets; walletIndex++) {
    const f = await nativeWarmupFixture({
      side,
      v2: true,
      lookup: options.lookup,
      token2022: options.token2022,
      keepWrapped: options.keepWrapped,
      walletSeed: 7 + walletIndex,
      slot: minimumSlot,
    });
    if (f.wallet !== walletRoster[walletIndex])
      throw Error('Synthetic public roster differs.');
    // Supply bytes are not part of mint transfer-policy hashes. Keep ordinary mints
    // feasible for all wallet balances; the special native WSOL mint keeps supply zero.
    for (let i = 0; i < f.mints.length; i++) {
      if (
        [f.order.inputMint, f.order.outputMint][i] ===
        'So11111111111111111111111111111111111111112'
      )
        continue;
      const data = Buffer.from(f.mints[i].data[0], 'base64');
      data.writeBigUInt64LE(1000000000n, 36);
      f.mints[i].data[0] = data.toString('base64');
    }
    if (!sharedState.has(POOL_TOKEN)) {
      const data = new Uint8Array(options.token2022 ? 170 : 165);
      data.set(bs58.decode(f.mint), 0);
      data.set(bs58.decode(POOL_TOKEN_AUTHORITY), 32);
      new DataView(data.buffer).setBigUint64(64, 1000000n, true);
      data[108] = 1;
      if (options.token2022) {
        data[165] = 2;
        data.set(
          getExtensionEncoder().encode({ __kind: 'ImmutableOwner' }),
          166,
        );
      }
      sharedState.set(
        POOL_TOKEN,
        account(
          pairRentMinimumRaw(rentProfile, data.length),
          options.token2022
            ? 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
            : 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          Buffer.from(data).toString('base64'),
        ),
      );
    }
    const otherWallets = options.exposeOtherWallets
      ? walletRoster.filter((wallet) => wallet !== f.wallet)
      : [];
    const original = f.simulation.settlementEvidence;
    if (!original)
      throw Error('Synthetic original settlement evidence missing.');
    const staticKeys = f.message.staticAccounts.map(String);
    let readonlyCount = f.message.header.numReadonlyNonSignerAccounts;
    let writableStaticCount = staticKeys.length - readonlyCount;
    if (options.burnInput) {
      const mintIndex = staticKeys.indexOf(f.mint);
      if (mintIndex < writableStaticCount)
        throw Error('Synthetic input mint was not readonly.');
      staticKeys.splice(mintIndex, 1);
      staticKeys.splice(writableStaticCount, 0, f.mint);
      writableStaticCount++;
      readonlyCount--;
    }
    staticKeys.splice(
      writableStaticCount,
      0,
      POOL,
      POOL_TOKEN,
      ...otherWallets,
    );
    if (options.includeRentSysvar && !staticKeys.includes(PAIR_RENT)) {
      staticKeys.push(PAIR_RENT);
      readonlyCount++;
    }
    const loadedAddresses = {
      writable: options.lookup
        ? [f.simulation.routeAssessment.decoded!.destinationAccount]
        : [],
      readonly: [] as string[],
    };
    const keys = [...staticKeys, ...loadedAddresses.writable];
    const lookupTableAddress = bs58.encode(
      new Uint8Array(32).fill(100 + walletIndex),
    );
    let lookupObservation = f.simulation.lookupObservation;
    if (options.lookup) {
      if (!lookupObservation || f.message.addressTableLookups?.length !== 1)
        throw Error('Synthetic original ALT observation missing.');
      const data = new Uint8Array(88),
        view = new DataView(data.buffer);
      view.setUint32(0, 1, true);
      view.setBigUint64(4, (1n << 64n) - 1n, true);
      view.setBigUint64(12, 80n, true);
      data.set(bs58.decode(loadedAddresses.writable[0]), 56);
      const sha256 = await hash(data);
      if (sha256 !== lookupObservation.tables[0].sha256)
        throw Error('Synthetic original ALT bytes differ.');
      lookupAccounts.push({
        address: lookupTableAddress,
        account: account(
          pairRentMinimumRaw(rentProfile, data.length),
          'AddressLookupTab1e1111111111111111111111111',
          Buffer.from(data).toString('base64'),
        ),
      });
      lookupObservation = {
        ...lookupObservation,
        tables: [
          { address: lookupTableAddress, sha256, lastExtendedSlot: '80' },
        ],
      };
    }
    const rawInstructions = f.rawInstructions.map((i) => ({
      ...i,
      accounts:
        i.program === JUPITER
          ? [
              ...i.accounts,
              POOL,
              POOL_TOKEN,
              ...otherWallets,
              ...(options.includeRentSysvar ? [PAIR_RENT] : []),
            ]
          : [...i.accounts],
    }));
    const message = {
      ...f.message,
      addressTableLookups: options.lookup
        ? f.message.addressTableLookups!.map((table) => ({
            ...table,
            lookupTableAddress: address(lookupTableAddress),
          }))
        : [],
      header: {
        ...f.message.header,
        numReadonlyNonSignerAccounts: readonlyCount,
      },
      staticAccounts: staticKeys.map(address),
      instructions: rawInstructions.map((i) => ({
        programAddressIndex: keys.indexOf(i.program),
        accountIndices: i.accounts.map((a) => keys.indexOf(a)),
        data: i.data,
      })),
    };
    const messageBytes = getCompiledTransactionMessageEncoder().encode(
      message,
    ) as TransactionMessageBytes;
    const transaction = getBase64Decoder().decode(
      getTransactionEncoder().encode({
        messageBytes,
        signatures: { [f.wallet]: null },
      }),
    );
    const preparation = await reviewUnsignedSwapOrder(
      {
        transaction,
        taker: f.wallet,
        transactionVersion: 0,
        gasless: false,
        lastValidBlockHeight: f.order.preparation.lastValidBlockHeight,
        signatureFeeLamports: 5000,
        signatureFeePayer: f.wallet,
        prioritizationFeeLamports: 0,
        rentFeeLamports: 0,
      },
      f.wallet,
    );
    const order = { ...f.order, preparation };
    const programs = new Set([
      SYSTEM,
      'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      ...rawInstructions.map((i) => i.program),
    ]);
    const mintMap = new Map([
      [order.inputMint, f.mints[0]],
      [order.outputMint, f.mints[1]],
    ]);
    const route = f.simulation.routeAssessment.decoded!;
    const sourceDestination = [route.sourceAccount, route.destinationAccount];
    const pre: (RawAccount | null)[] = keys.map((k) => {
      if (sharedState.has(k)) return structuredClone(sharedState.get(k)!);
      if (k === f.wallet) return account(original.before[0]);
      const tokenIndex = sourceDestination.indexOf(k);
      if (tokenIndex >= 0) return structuredClone(f.first[tokenIndex]);
      if (programs.has(k)) return account('1', LOADER, '', true);
      const mint = mintMap.get(k);
      if (mint) return { ...structuredClone(mint), lamports: '1461600' };
      return account('1');
    });
    const post = structuredClone(pre);
    post[0] = account(original.after[0]);
    for (let i = 0; i < 2; i++)
      post[keys.indexOf(sourceDestination[i])] = structuredClone(f.last[i]);
    const poolTokenIndex = keys.indexOf(POOL_TOKEN);
    const poolTokenBytes = Buffer.from(post[poolTokenIndex]!.data[0], 'base64');
    poolTokenBytes.writeBigUInt64LE(
      poolTokenBytes.readBigUInt64LE(64) +
        (side === 'Buy' ? -1000n : options.burnInput ? 0n : 1000n),
      64,
    );
    post[poolTokenIndex]!.data[0] = poolTokenBytes.toString('base64');
    if (options.burnInput) {
      const mintIndex = keys.indexOf(f.mint),
        mintBytes = Buffer.from(post[mintIndex]!.data[0], 'base64');
      mintBytes.writeBigUInt64LE(mintBytes.readBigUInt64LE(36) - 1000n, 36);
      post[mintIndex]!.data[0] = mintBytes.toString('base64');
    }
    const poolIndex = keys.indexOf(POOL),
      fee = BigInt(f.simulation.networkFeeLamports);
    const sum = (a: (RawAccount | null)[]) =>
      a.reduce(
        (n, row, i) => (i === poolIndex ? n : n + BigInt(row?.lamports ?? '0')),
        0n,
      );
    const delta = sum(pre) - sum(post) - fee;
    post[poolIndex] = {
      ...post[poolIndex]!,
      lamports: (BigInt(pre[poolIndex]!.lamports) + delta).toString(),
    };
    const nativePoolPost = Buffer.from(post[poolIndex]!.data[0], 'base64');
    nativePoolPost.writeBigUInt64LE(
      BigInt(post[poolIndex]!.lamports) - poolReserve,
      64,
    );
    post[poolIndex]!.data[0] = nativePoolPost.toString('base64');
    const remapTokens = (raw: unknown) => {
      if (!Array.isArray(raw)) throw Error('Synthetic token evidence missing.');
      return raw.map((row: Record<string, unknown>) => ({
        ...structuredClone(row),
        accountIndex: String(
          keys.indexOf(original.keys[Number(row.accountIndex)]),
        ),
      }));
    };
    const preTokens = remapTokens(original.preTokens),
      postTokens = remapTokens(original.postTokens);
    const instructionReview = reviewSwapInstructions(message, loadedAddresses);
    const routeAssessment = assessJupiterRoute(instructionReview, order);
    const tokens = assessSimulatedSwapTokens(
      order,
      message.staticAccounts,
      message.addressTableLookups ?? [],
      {
        loadedAddresses,
        preTokenBalances: preTokens,
        postTokenBalances: postTokens,
      },
    );
    const simulation: ImportedSwapSimulation = {
      ...f.simulation,
      sha256: preparation.sha256,
      lookupObservation,
      instructionReview,
      routeAssessment,
      ...tokens,
      settlementEvidence: {
        ...original,
        keys,
        before: pre.map((a) => a?.lamports ?? '0'),
        after: post.map((a) => a?.lamports ?? '0'),
        preTokens,
        postTokens,
        postAccounts: structuredClone(f.last),
      },
    };
    const settlement = await requireWarmupSigningReview(order, simulation);
    const review: WarmupSigningReview = {
      id: crypto.randomUUID(),
      preparationId: crypto.randomUUID(),
      wallet: f.wallet,
      sha256: preparation.sha256,
      expiresAt: order.expiresAt,
      network: 'mainnet',
      maximumFeeLamports: simulation.networkFeeLamports,
      inputRaw: order.inAmount,
      minimumOutputRaw: order.minimumOutAmount,
      inputMint: order.inputMint,
      outputMint: order.outputMint,
      transaction,
      lastValidBlockHeight: preparation.lastValidBlockHeight,
      settlement,
      session: {
        format: 'trade-session-entry-v1',
        sessionId,
        sessionRevision: 1,
        entry: walletIndex + 1,
        termsSha256: 'ab'.repeat(32),
        unitsRaw: order.inAmount,
      },
    };
    reviews.push(review);
    packets.push({
      transaction,
      loadedAddresses: options.lookup ? loadedAddresses : null,
      maximumFeeLamports: simulation.networkFeeLamports,
      expectedFeeLamports: simulation.networkFeeLamports,
    });
    frames.push({
      err: null,
      preExecutionAccounts: pre,
      postExecutionAccounts: post,
      loadedAddresses,
      fee: simulation.networkFeeLamports,
      unitsConsumed: Number(simulation.unitsConsumed),
      loadedAccountsDataSize: String(
        pre.reduce(
          (n, a) => n + (a ? Buffer.from(a.data[0], 'base64').length : 0),
          0,
        ),
      ),
    });
    observations.push({
      order,
      simulation,
      mints: structuredClone(f.mints),
      mintAccounts: {
        slot: minimumSlot,
        recheckSlot: simulationBankSlot,
        before: structuredClone(f.mints),
        after: structuredClone(f.mints),
      },
    });
    allKeys.push(keys);
    keys.forEach((k, i) => sharedState.set(k, structuredClone(post[i])));
  }
  const payer = reviews[0].wallet,
    amountRaw = '1000',
    feeLamports = '5000',
    blockhash = bs58.encode(new Uint8Array(32).fill(33));
  const tipMessage = solanaTransferMessage(
    payer,
    TIP_RECIPIENT,
    blockhash,
    BigInt(amountRaw),
  ) as unknown as TransactionMessageBytes;
  const tipTransaction = getBase64Decoder().decode(
    getTransactionEncoder().encode({
      messageBytes: tipMessage,
      signatures: { [payer]: null },
    }),
  );
  const now = new Date().toISOString(),
    expiresAt = new Date(
      Math.min(...reviews.map((r) => Date.parse(r.expiresAt))),
    ).toISOString();
  const tipReview: NativeWithdrawalReview = {
    id: crypto.randomUUID(),
    network: 'mainnet',
    wallet: payer,
    walletRevision: 1,
    recipient: TIP_RECIPIENT,
    amountRaw,
    amount: '0.000001',
    feeLamports,
    reserveLamports: '890880',
    maximumDebitRaw: '6000',
    blockhash,
    lastValidBlockHeight: '999999999',
    slot: minimumSlot,
    transaction: tipTransaction,
    sha256: await hash(Buffer.from(tipTransaction, 'base64')),
    preparedAt: now,
    expiresAt,
    source: 'Synthetic unsigned fixture only.',
  };
  await inspectNativeWithdrawal(tipReview, tipTransaction, false);
  const tipKeys = getCompiledTransactionMessageDecoder()
    .decode(tipMessage)
    .staticAccounts.map(String);
  const tipPre = tipKeys.map((k) =>
    sharedState.has(k)
      ? structuredClone(sharedState.get(k)!)
      : k === TIP_RECIPIENT
        ? account('1000000', JITO_TIP_PAYMENT_OWNER, 'ySH0dOBEYSg=')
        : account('1', LOADER, '', true),
  );
  const tipPost = structuredClone(tipPre);
  tipPost[0] = {
    ...tipPost[0]!,
    lamports: (BigInt(tipPost[0]!.lamports) - 6000n).toString(),
  };
  tipPost[1] = {
    ...tipPost[1]!,
    lamports: (BigInt(tipPost[1]!.lamports) + 1000n).toString(),
  };
  frames.push({
    err: null,
    preExecutionAccounts: tipPre,
    postExecutionAccounts: tipPost,
    loadedAddresses: { writable: [], readonly: [] },
    fee: feeLamports,
    unitsConsumed: 150,
    loadedAccountsDataSize: '0',
  });
  packets.push({
    transaction: tipTransaction,
    loadedAddresses: null,
    maximumFeeLamports: feeLamports,
    expectedFeeLamports: feeLamports,
  });
  allKeys.push(tipKeys);
  const terms = {
    format: 'jito-atomic-bundle-v1' as const,
    id: crypto.randomUUID(),
    projectId,
    sessionId,
    sessionRevision: 1,
    createdAt: now,
    expiresAt,
    swaps: reviews,
    tip: tipReview,
  };
  const manifest: JitoBundleManifest = {
    ...terms,
    sha256: await bundleFingerprint(terms),
  };
  await requireJitoManifest(manifest);
  const result = {
    context: { slot: simulationBankSlot },
    value: { summary: 'succeeded', transactionResults: frames },
  };
  // Fail fixture construction rather than handing parent tests subtly inconsistent full frames.
  await verifyJitoBundleSimulationFrames({
    packets,
    minimumSlot,
    simulationBankSlot,
    result,
  });
  return {
    manifest,
    observations,
    packets,
    result,
    minimumSlot,
    simulationBankSlot,
    rentAccounts,
    expectedFees: packets.map((p) => p.expectedFeeLamports),
    pool: POOL,
    poolToken: POOL_TOKEN,
    poolTokenAuthority: POOL_TOKEN_AUTHORITY,
    tipRecipient: TIP_RECIPIENT,
    walletRoster,
    lookupAccounts,
    keys: allKeys,
  };
}
