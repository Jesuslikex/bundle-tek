import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  address,
  getProgramDerivedAddress,
  getCompiledTransactionMessageEncoder,
  getTransactionEncoder,
  getBase64Decoder,
  type TransactionMessageBytes,
  type SignatureBytes,
} from '@solana/kit';
import { routeMessage } from './jupiter-route-fixture';
import { reviewUnsignedSwapOrder } from '../lib/unsigned-swap-order';
import { simulateImportedSwap } from '../lib/imported-swap-simulation';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import {
  WARMUP_TOKEN as TOKEN,
  WARMUP_NATIVE as NATIVE,
} from '../lib/warmup-native-settlement';
import schema from '../lib/jupiter-route-schema.json';
import type { SolanaSwapPreparation } from '../lib/warmup-swap-quote';
const SYSTEM = '11111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const JUPITER = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const RENT = 2039280n;
const wire = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const key = (n: number) => bs58.encode(new Uint8Array(32).fill(n));
export async function nativeWarmupFixture(
  options: {
    side?: 'Buy' | 'Sell';
    seed?: boolean;
    lookup?: boolean;
    existing?: boolean;
    shared?: boolean;
    v2?: boolean;
    fee?: number;
    venue?: string;
    keepWrapped?: boolean;
    slot?: number;
    initializer?: 1 | 16 | 18;
    seedRentOnly?: boolean;
  } = {},
) {
  const origin = options.slot ?? 100;
  const side = options.side ?? 'Buy',
    seeded = options.seed === true,
    existing = options.existing === true;
  const pair = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)),
    wallet = bs58.encode(pair.publicKey),
    mint = key(3);
  const [nativeAta] = await getProgramDerivedAddress({
    programAddress: address(ATA),
    seeds: [bs58.decode(wallet), bs58.decode(TOKEN), bs58.decode(NATIVE)],
  });
  const [tokenAta] = await getProgramDerivedAddress({
    programAddress: address(ATA),
    seeds: [bs58.decode(wallet), bs58.decode(TOKEN), bs58.decode(mint)],
  });
  const seed = new TextEncoder().encode('warmup-test');
  const temporary = bs58.encode(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        Uint8Array.from([
          ...bs58.decode(wallet),
          ...seed,
          ...bs58.decode(TOKEN),
        ]).buffer,
      ),
    ),
  );
  const wrapped = seeded ? temporary : nativeAta,
    source = side === 'Buy' ? wrapped : tokenAta,
    destination = side === 'Buy' ? tokenAta : wrapped;
  const closes = !options.keepWrapped;
  const rawInstructions: {
    program: string;
    accounts: string[];
    data: Uint8Array;
  }[] = [];
  const add = (
    program: string,
    accounts: string[],
    data: number[] | Uint8Array,
  ) => rawInstructions.push({ program, accounts, data: Uint8Array.from(data) });
  if (seeded) {
    const bytes = new Uint8Array(44 + seed.length + 48),
      view = new DataView(bytes.buffer),
      offset = 44 + seed.length;
    view.setUint32(0, 3, true);
    bytes.set(bs58.decode(wallet), 4);
    view.setBigUint64(36, BigInt(seed.length), true);
    bytes.set(seed, 44);
    view.setBigUint64(
      offset,
      RENT + (side === 'Buy' && !options.seedRentOnly ? 1000000n : 0n),
      true,
    );
    view.setBigUint64(offset + 8, 165n, true);
    bytes.set(bs58.decode(TOKEN), offset + 16);
    add(SYSTEM, [wallet, wrapped, wallet], bytes);
    const initializer = options.initializer ?? 18;
    add(
      TOKEN,
      initializer === 18
        ? [wrapped, NATIVE]
        : initializer === 16
          ? [wrapped, NATIVE, 'SysvarRent111111111111111111111111111111111']
          : [
              wrapped,
              NATIVE,
              wallet,
              'SysvarRent111111111111111111111111111111111',
            ],
      initializer === 1 ? [1] : [initializer, ...bs58.decode(wallet)],
    );
    if (options.seedRentOnly && side === 'Buy') {
      const data = new Uint8Array(12),
        view = new DataView(data.buffer);
      view.setUint32(0, 2, true);
      view.setBigUint64(4, 1000000n, true);
      add(SYSTEM, [wallet, wrapped], data);
      add(TOKEN, [wrapped], [17]);
    }
  } else {
    add(ATA, [wallet, wrapped, wallet, NATIVE, SYSTEM, TOKEN], [1]);
    if (side === 'Buy' && !existing) {
      const data = new Uint8Array(12),
        view = new DataView(data.buffer);
      view.setUint32(0, 2, true);
      view.setBigUint64(4, 1000000n, true);
      add(SYSTEM, [wallet, wrapped], data);
      add(TOKEN, [wrapped], [17]);
    }
  }
  if (side === 'Buy')
    add(ATA, [wallet, tokenAta, wallet, mint, SYSTEM, TOKEN], [1]);
  const variant = schema.variants.findIndex(
    (v) =>
      v.name ===
      (options.venue ?? (side === 'Buy' ? 'PumpSwapBuy' : 'PumpSwapSell')),
  );
  const route = routeMessage({
    shared: options.shared,
    v2: options.v2,
    fee: options.fee,
    variant,
    amount: side === 'Buy' ? 1000000n : 1000n,
    output: side === 'Buy' ? 1000n : 1000000n,
  }).instructions[0].data!;
  add(
    JUPITER,
    options.v2
      ? options.shared === false
        ? [
            wallet,
            source,
            destination,
            side === 'Buy' ? NATIVE : mint,
            side === 'Buy' ? mint : NATIVE,
            TOKEN,
            TOKEN,
            JUPITER,
            'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',
            JUPITER,
          ]
        : [
            JUPITER,
            wallet,
            source,
            source,
            destination,
            destination,
            side === 'Buy' ? NATIVE : mint,
            side === 'Buy' ? mint : NATIVE,
            TOKEN,
            TOKEN,
            'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',
            JUPITER,
          ]
      : options.shared === false
        ? [
            TOKEN,
            wallet,
            source,
            destination,
            JUPITER,
            side === 'Buy' ? mint : NATIVE,
            JUPITER,
            'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',
            JUPITER,
          ]
        : [
            TOKEN,
            JUPITER,
            wallet,
            source,
            source,
            destination,
            destination,
            side === 'Buy' ? NATIVE : mint,
            side === 'Buy' ? mint : NATIVE,
            JUPITER,
            TOKEN,
            'D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf',
            JUPITER,
          ],
    Uint8Array.from(route),
  );
  if (closes) add(TOKEN, [wrapped, wallet, wallet], [9]);
  const writable = [wallet, source, destination];
  const readonly = [
    ...new Set(
      rawInstructions
        .flatMap((i) => [i.program, ...i.accounts])
        .filter((k) => !writable.includes(k)),
    ),
  ];
  const staticKeys = [
      ...writable.filter((k) => !options.lookup || k !== destination),
      ...readonly,
    ],
    keys = [...staticKeys, ...(options.lookup ? [destination] : [])];
  const message = {
    ...routeMessage(),
    staticAccounts: staticKeys.map(address),
    header: {
      numSignerAccounts: 1,
      numReadonlySignerAccounts: 0,
      numReadonlyNonSignerAccounts: readonly.length,
    },
    instructions: rawInstructions.map((i) => ({
      programAddressIndex: keys.indexOf(i.program),
      accountIndices: i.accounts.map((a) => keys.indexOf(a)),
      data: i.data,
    })),
    addressTableLookups: options.lookup
      ? [
          {
            lookupTableAddress: address(key(9)),
            writableIndexes: [0],
            readonlyIndexes: [],
          },
        ]
      : [],
  };
  const messageBytes = getCompiledTransactionMessageEncoder().encode(
      message,
    ) as TransactionMessageBytes,
    unsigned = getTransactionEncoder().encode({
      messageBytes,
      signatures: { [wallet]: null },
    }),
    transaction = getBase64Decoder().decode(unsigned);
  const preparation = await reviewUnsignedSwapOrder(
    {
      transaction,
      taker: wallet,
      transactionVersion: 0,
      gasless: false,
      lastValidBlockHeight: '999999999',
      signatureFeeLamports: 5000,
      signatureFeePayer: wallet,
      prioritizationFeeLamports: 0,
      rentFeeLamports: 0,
    },
    wallet,
  );
  const order: SolanaSwapPreparation = {
    executionAllowed: false,
    side,
    inputMint: side === 'Buy' ? NATIVE : mint,
    outputMint: side === 'Buy' ? mint : NATIVE,
    inAmount: side === 'Buy' ? '1000000' : '1000',
    outAmount: side === 'Buy' ? '1000' : '1000000',
    minimumOutAmount: side === 'Buy' ? '995' : '995000',
    slippageBps: 50,
    router: 'metis',
    ...(options.fee ? { platformFee: { bps: options.fee, mint: NATIVE } } : {}),
    source: 'fixture',
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30000).toISOString(),
    preparation,
    limitations: 'Controlled fixture only.',
  };
  const tokenAccount = (tokenMint: string, amount: bigint) => {
    const bytes = new Uint8Array(165),
      view = new DataView(bytes.buffer);
    bytes.set(bs58.decode(tokenMint), 0);
    bytes.set(bs58.decode(wallet), 32);
    view.setBigUint64(64, amount, true);
    bytes[108] = 1;
    if (tokenMint === NATIVE) {
      view.setUint32(109, 1, true);
      view.setBigUint64(113, RENT, true);
    }
    return {
      owner: TOKEN,
      executable: false,
      lamports: (RENT + (tokenMint === NATIVE ? amount : 0n)).toString(),
      data: [wire(bytes), 'base64'],
    };
  };
  const beforeWrapped = existing && !seeded ? 1000000n : 0n;
  const nativeExists = existing && !seeded;
  const first = [
    side === 'Buy'
      ? nativeExists
        ? tokenAccount(NATIVE, beforeWrapped)
        : null
      : tokenAccount(mint, 1000n),
    side === 'Buy'
      ? null
      : nativeExists
        ? tokenAccount(NATIVE, beforeWrapped)
        : null,
  ];
  const nativeAfter =
    side === 'Buy'
      ? beforeWrapped + (!existing || seeded ? 1000000n : 0n) - 1000000n
      : beforeWrapped + 1000000n;
  const last = [
    side === 'Buy'
      ? closes
        ? null
        : tokenAccount(NATIVE, nativeAfter)
      : tokenAccount(mint, 0n),
    side === 'Buy'
      ? tokenAccount(mint, 1000n)
      : closes
        ? null
        : tokenAccount(NATIVE, nativeAfter),
  ];
  const before = keys.map(() => '0'),
    after = keys.map(() => '0');
  before[0] = '100000000';
  const accountIndex = [keys.indexOf(source), keys.indexOf(destination)];
  for (let n = 0; n < 2; n++) {
    before[accountIndex[n]] = first[n]?.lamports ?? '0';
    after[accountIndex[n]] = last[n]?.lamports ?? '0';
  }
  const rentDelta =
    BigInt(after[accountIndex[0]]) +
    BigInt(after[accountIndex[1]]) -
    BigInt(before[accountIndex[0]]) -
    BigInt(before[accountIndex[1]]);
  // Trading transfers in/out of non-wallet pool accounts are supplied by controlled metadata.
  after[0] = (
    100000000n -
    5000n -
    rentDelta +
    (side === 'Buy' ? -1000000n : 1000000n)
  ).toString();
  const balances = (accounts: typeof first) =>
    accounts.flatMap((a, n) =>
      a
        ? [
            {
              accountIndex: String(accountIndex[n]),
              mint: n === 0 ? order.inputMint : order.outputMint,
              owner: wallet,
              programId: TOKEN,
              uiTokenAmount: {
                amount: (n === 0
                  ? side === 'Buy'
                    ? accounts === first
                      ? beforeWrapped
                      : nativeAfter
                    : accounts === first
                      ? 1000n
                      : 0n
                  : side === 'Buy'
                    ? 1000n
                    : accounts === first
                      ? beforeWrapped
                      : nativeAfter
                ).toString(),
                decimals:
                  n === 0
                    ? side === 'Buy'
                      ? '9'
                      : '6'
                    : side === 'Buy'
                      ? '6'
                      : '9',
              },
            },
          ]
        : [],
    );
  const preTokens = balances(first),
    postTokens = balances(last);
  const lookupBytes = new Uint8Array(88),
    lookupView = new DataView(lookupBytes.buffer);
  lookupView.setUint32(0, 1, true);
  lookupView.setBigUint64(4, (1n << 64n) - 1n, true);
  lookupView.setBigUint64(12, 80n, true);
  lookupBytes.set(bs58.decode(destination), 56);
  const lookupAccount = {
    owner: 'AddressLookupTab1e1111111111111111111111111',
    executable: false,
    data: [wire(lookupBytes), 'base64'],
  };
  const simulationValue = {
    err: null,
    unitsConsumed: 100000,
    preBalances: before,
    postBalances: after,
    preTokenBalances: preTokens,
    postTokenBalances: postTokens,
    loadedAddresses: {
      writable: options.lookup ? [destination] : [],
      readonly: [],
    },
    accounts: last,
  };
  const fetcher = async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
    let result: unknown;
    switch (body.method) {
      case 'getGenesisHash':
        result = SOLANA_MAINNET_GENESIS;
        break;
      case 'getBlockHeight':
        result = 100;
        break;
      case 'getFeeForMessage':
        result = { context: { slot: origin }, value: 5000 };
        break;
      case 'getMinimumBalanceForRentExemption':
        result = Number(RENT);
        break;
      case 'getMultipleAccounts':
        result = {
          context: {
            slot: Math.max(origin, Number(body.params[1].minContextSlot)),
          },
          value: body.params[0][0] === key(9) ? [lookupAccount] : first,
        };
        break;
      case 'simulateTransaction':
        result = { context: { slot: origin + 1 }, value: simulationValue };
        break;
      default:
        throw new Error('Unexpected fixture RPC: ' + body.method);
    }
    return Response.json({ jsonrpc: '2.0', id: 1, result });
  };
  const simulation = await simulateImportedSwap(
    order,
    new AbortController().signal,
    fetcher as typeof fetch,
    true,
  );
  const signedBytes = getTransactionEncoder().encode({
    messageBytes,
    signatures: {
      [wallet]: nacl.sign.detached(
        Uint8Array.from(messageBytes),
        pair.secretKey,
      ) as SignatureBytes,
    },
  });
  const signed = {
    transaction: getBase64Decoder().decode(signedBytes),
    signature: bs58.encode(Uint8Array.from(signedBytes.slice(1, 65))),
  };
  const receipt = {
    version: '0',
    slot: String(origin + 200),
    blockTime: null,
    transaction: [signed.transaction, 'base64'],
    meta: { ...simulationValue, fee: '5000' },
  };
  return {
    order,
    simulation,
    keys,
    first,
    last,
    rawInstructions,
    message,
    fetcher,
    signed,
    receipt,
    wallet,
    mint,
    rent: RENT.toString(),
  };
}
