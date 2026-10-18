import bs58 from 'bs58';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
  getBase64Decoder,
} from '@solana/kit';
import { decodePumpLaunchConfig } from './pump-launch-config';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  PAIR_RENT,
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from './pair-rent-evidence';
import {
  requireVolumeBundleConstruction,
  volumeUint,
  volumeReject,
  volumeDigest,
  VOLUME_SYSTEM,
  VOLUME_TOKEN,
  type VolumeBundleConstruction,
} from './volume-bundle-construction';
import {
  validateVolumePumpRoute,
  VOLUME_PUMP,
  VOLUME_PUMP_FEE,
  type VolumePumpRoute,
} from './volume-bundle-route';

const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR = 'Sysvar1111111111111111111111111111111111111';
type Method =
  | 'getGenesisHash'
  | 'getMultipleAccounts'
  | 'getFeeForMessage'
  | 'isBlockhashValid'
  | 'getBlockHeight'
  | 'simulateTransaction';
export type VolumeSimulationRpc = (
  method: Method,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
export type VolumeSimulationAccount = {
  owner: string;
  executable: boolean;
  lamports: string;
  data: [string, 'base64'];
};
function uint(raw: unknown) {
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0
    ? BigInt(raw)
    : volumeUint(raw);
}
function account(raw: unknown): VolumeSimulationAccount {
  const a = raw as VolumeSimulationAccount;
  if (
    !a ||
    typeof a.owner !== 'string' ||
    typeof a.executable !== 'boolean' ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string' ||
    a.data[0].length > 266668 ||
    btoa(atob(a.data[0])) !== a.data[0]
  )
    return volumeReject('Complete bounded raw accounts required.');
  if (bs58.decode(a.owner).length !== 32)
    volumeReject('Account owner differs.');
  return {
    owner: a.owner,
    executable: a.executable,
    lamports: uint(a.lamports).toString(),
    data: [a.data[0], 'base64'],
  };
}
const bytes = (a: VolumeSimulationAccount) =>
  Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
function ordinary(a: VolumeSimulationAccount) {
  if (a.owner !== VOLUME_SYSTEM || a.executable || a.data[0] !== '')
    volumeReject('Ordinary system custody required.');
}
function token(a: VolumeSimulationAccount, mint: string, owner: string) {
  const b = bytes(a),
    v = new DataView(b.buffer);
  if (
    a.owner !== VOLUME_TOKEN ||
    a.executable ||
    b.length !== 165 ||
    bs58.encode(b.slice(0, 32)) !== mint ||
    bs58.encode(b.slice(32, 64)) !== owner ||
    b[108] !== 1 ||
    v.getUint32(72, true) !== 0 ||
    v.getBigUint64(121, true) !== 0n ||
    v.getUint32(109, true) !== 0 ||
    v.getUint32(129, true) !== 0
  )
    volumeReject('Standard token identity, state or authority differs.');
  return v.getBigUint64(64, true);
}
/** Explicitly injected read/simulate transport only. No configured provider, signing, write or default client. */
export async function simulateVolumePumpBundle(
  supplied: VolumeBundleConstruction,
  suppliedRoute: VolumePumpRoute,
  rpc: VolumeSimulationRpc,
  signal: AbortSignal,
  minimumSlot: number,
  now: () => number = Date.now,
) {
  const review = await requireVolumeBundleConstruction(supplied);
  const route = await validateVolumePumpRoute(review, suppliedRoute.identities);
  if (
    JSON.stringify(route) !== JSON.stringify(suppliedRoute) ||
    !Number.isSafeInteger(minimumSlot) ||
    minimumSlot < 1
  )
    volumeReject('Route binding or context floor differs.');
  const started = now(),
    deadline = AbortSignal.any([signal, AbortSignal.timeout(20000)]);
  const current = () => {
    if (deadline.aborted || now() < started || now() - started > 20000)
      volumeReject('Unsigned simulation cancelled or expired.');
  };
  let calls = 0;
  const call = (method: Method, params: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      current();
      if (++calls > 9)
        return reject(new Error('Unsigned simulation read budget exceeded.'));
      const abort = () =>
        reject(new Error('Unsigned simulation cancelled or expired.'));
      deadline.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => {
          current();
          return rpc(method, params, deadline);
        })
        .then(
          (value) => {
            current();
            resolve(value);
          },
          () => reject(new Error('Unsigned simulation RPC unavailable.')),
        )
        .catch(reject)
        .finally(() => deadline.removeEventListener('abort', abort));
    });
  const tx = getTransactionDecoder().decode(
    Uint8Array.from(atob(review.transaction), (c) => c.charCodeAt(0)),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
      tx.messageBytes,
    ),
    keys = message.staticAccounts.map(String);
  if (keys.includes(CLOCK) || keys.includes(PAIR_RENT) || keys.length > 64)
    volumeReject('Unsupported account vector.');
  const addresses = [...keys, PAIR_RENT, CLOCK],
    slots: number[] = [];
  let floor = minimumSlot;
  const context = (raw: unknown) => {
    const n = Number(uint(raw));
    if (!Number.isSafeInteger(n) || n < floor)
      return volumeReject('RPC ignored the minimum context slot.');
    slots.push(n);
    if (Math.max(...slots) - Math.min(...slots) > 32)
      volumeReject('Unsigned simulation exceeded the 32-slot window.');
    floor = n;
    return n;
  };
  const clock = (a: VolumeSimulationAccount, slot: number) => {
    const b = bytes(a),
      v = new DataView(b.buffer);
    const age =
      b.length === 40
        ? now() - Number(v.getBigInt64(32, true)) * 1000
        : Infinity;
    if (
      a.owner !== SYSVAR ||
      a.executable ||
      b.length !== 40 ||
      v.getBigUint64(0, true) !== BigInt(slot) ||
      age < -2000 ||
      age > 30000
    )
      volumeReject('Fresh same-context Clock required.');
  };
  const vector = (raw: unknown, slot: number) => {
    if (!Array.isArray(raw) || raw.length !== addresses.length)
      return volumeReject('Complete ordered simulation accounts required.');
    const list = raw.map(account);
    if (list.reduce((sum, a) => sum + a.data[0].length, 0) > 699052)
      volumeReject('Account byte budget exceeded.');
    clock(list[list.length - 1], slot);
    return list;
  };
  const snapshot = async () => {
    const result = (await call('getMultipleAccounts', [
      addresses,
      { encoding: 'base64', commitment: 'confirmed', minContextSlot: floor },
    ])) as { context: { slot: unknown }; value: unknown };
    const slot = context(result?.context?.slot);
    return vector(result.value, slot);
  };
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    volumeReject('Unsigned simulation requires Solana mainnet identity.');
  const before = await snapshot(),
    get = (list: VolumeSimulationAccount[], key: string) =>
      list[addresses.indexOf(key)] ?? volumeReject('Missing route account.');
  const rent = inspectPairRentAccount(get(before, PAIR_RENT));
  const walletRent = BigInt(pairRentMinimumRaw(rent, 0));
  if (
    [review.input.tokenAccount, route.accounts.associated_bonding_curve].some(
      (key) =>
        BigInt(get(before, key).lamports) <
        BigInt(pairRentMinimumRaw(rent, 165)),
    )
  )
    volumeReject('Token account is not rent exempt.');
  ordinary(get(before, review.wallet));
  ordinary(get(before, review.input.tipRecipient));
  ordinary(get(before, route.identities.feeRecipient));
  if (
    token(
      get(before, review.input.tokenAccount),
      review.input.mint,
      review.wallet,
    ) !== 0n ||
    token(
      get(before, route.accounts.associated_bonding_curve),
      review.input.mint,
      route.accounts.bonding_curve,
    ) <= BigInt(review.input.tokenAmountRaw)
  )
    volumeReject(
      'Empty user inventory and non-migrating curve liquidity required.',
    );
  const mint = get(before, review.input.mint),
    mintBytes = bytes(mint),
    mintView = new DataView(mintBytes.buffer);
  if (
    mint.owner !== VOLUME_TOKEN ||
    mint.executable ||
    mintBytes.length !== 82 ||
    mintBytes[44] !== 6 ||
    mintBytes[45] !== 1 ||
    mintView.getUint32(0, true) !== 0 ||
    mintView.getUint32(46, true) !== 0
  )
    volumeReject('Immutable standard six-decimal mint required.');
  if (mintView.getBigUint64(36, true) <= BigInt(review.input.tokenAmountRaw))
    volumeReject('Mint supply is insufficient.');
  const ownedConfig = (name: 'global' | 'bonding_curve') => {
    const a = get(before, route.accounts[name]);
    if (a.owner !== VOLUME_PUMP || a.executable)
      return volumeReject('Pump state ownership differs.');
    return decodePumpLaunchConfig(
      name === 'global' ? 'Global' : 'BondingCurve',
      bytes(a),
    );
  };
  const global = ownedConfig('global'),
    curve = ownedConfig('bonding_curve');
  if (
    global.initialized !== true ||
    ![
      global.fee_recipient,
      ...(Array.isArray(global.fee_recipients) ? global.fee_recipients : []),
    ].includes(route.identities.feeRecipient) ||
    curve.creator !== route.identities.creator ||
    curve.complete !== false ||
    curve.is_mayhem_mode !== false ||
    curve.is_cashback_coin !== false ||
    curve.is_holder_reward !== false ||
    curve.quote_mint !== VOLUME_SYSTEM ||
    curve.depth !== 0 ||
    typeof curve.real_token_reserves !== 'bigint' ||
    curve.real_token_reserves <= BigInt(review.input.tokenAmountRaw)
  )
    volumeReject('Pump native state, fee recipient or curve mode differs.');
  if (curve.token_total_supply !== mintView.getBigUint64(36, true))
    volumeReject('Curve and mint supply differ.');
  for (const name of [
    'global_volume_accumulator',
    'user_volume_accumulator',
    'creator_vault',
  ]) {
    const a = get(before, route.accounts[name]);
    if (a.executable || ![VOLUME_PUMP, VOLUME_SYSTEM].includes(a.owner))
      volumeReject('Pump accumulator custody differs.');
  }
  if (
    get(before, route.accounts.fee_config).owner !== VOLUME_PUMP_FEE ||
    get(before, route.accounts.fee_config).executable
  )
    volumeReject('Fee configuration owner differs.');
  for (const p of [VOLUME_PUMP, VOLUME_PUMP_FEE, VOLUME_TOKEN, VOLUME_SYSTEM])
    if (!get(before, p).executable)
      volumeReject('Executable program account required.');
  const feeResult = (await call('getFeeForMessage', [
    getBase64Decoder().decode(tx.messageBytes),
    { commitment: 'confirmed', minContextSlot: floor },
  ])) as { context: { slot: unknown }; value: unknown };
  context(feeResult?.context?.slot);
  const fee = uint(feeResult.value);
  if (
    fee === 0n ||
    fee > BigInt(review.input.networkFeeCapLamports) ||
    BigInt(before[0].lamports) <
      BigInt(review.input.plan.rounds[review.input.round].buyLamports) +
        fee +
        BigInt(review.input.tipLamports) +
        walletRent
  )
    volumeReject('Fee allowance or peak native balance is insufficient.');
  const lifetime = async () => {
    const valid = (await call('isBlockhashValid', [
      review.input.blockhash,
      { commitment: 'confirmed', minContextSlot: floor },
    ])) as { context: { slot: unknown }; value: unknown };
    context(valid?.context?.slot);
    if (valid.value !== true) volumeReject('Original blockhash is invalid.');
    const height = uint(
      await call('getBlockHeight', [
        { commitment: 'confirmed', minContextSlot: floor },
      ]),
    );
    if (height + 32n > BigInt(review.input.lastValidBlockHeight))
      volumeReject('Original blockhash has insufficient lifetime.');
  };
  await lifetime();
  const simulation = (await call('simulateTransaction', [
    review.transaction,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      minContextSlot: floor,
      sigVerify: false,
      replaceRecentBlockhash: false,
      innerInstructions: true,
      accounts: { encoding: 'base64', addresses },
    },
  ])) as {
    context: { slot: unknown };
    value: {
      err: unknown;
      accounts: unknown;
      unitsConsumed: unknown;
      replacementBlockhash?: unknown;
      fee?: unknown;
      innerInstructions: unknown;
    };
  };
  const simSlot = context(simulation?.context?.slot),
    value = simulation?.value;
  if (!value || value.err !== null || value.replacementBlockhash != null)
    volumeReject(
      'Original unsigned packet simulation failed or replaced its blockhash.',
    );
  const units = uint(value.unitsConsumed);
  if (
    units < 1n ||
    units > 1400000n ||
    (value.fee !== undefined && uint(value.fee) !== fee)
  )
    volumeReject('Simulation resources or fee differs.');
  const after = vector(value.accounts, simSlot);
  if (
    JSON.stringify(get(before, PAIR_RENT)) !==
      JSON.stringify(get(after, PAIR_RENT)) ||
    BigInt(after[0].lamports) < walletRent
  )
    volumeReject(
      'Simulation changed rent evidence or drained the wallet rent floor.',
    );
  const mutable = new Set([
    review.wallet,
    route.accounts.bonding_curve,
    route.accounts.fee_recipient,
    route.accounts.creator_vault,
    route.accounts.associated_bonding_curve,
    review.input.tokenAccount,
    route.accounts.user_volume_accumulator,
    route.accounts.global_volume_accumulator,
    review.input.tipRecipient,
  ]);
  for (let i = 0; i < keys.length; i++) {
    if (
      before[i].owner !== after[i].owner ||
      before[i].executable !== after[i].executable ||
      (!mutable.has(keys[i]) &&
        JSON.stringify(before[i]) !== JSON.stringify(after[i]))
    )
      volumeReject('Simulation changed custody or protected account bytes.');
  }
  ordinary(after[0]);
  ordinary(get(after, review.input.tipRecipient));
  for (const key of [
    review.input.tokenAccount,
    route.accounts.associated_bonding_curve,
  ])
    if (JSON.stringify(get(before, key)) !== JSON.stringify(get(after, key)))
      volumeReject('Simulation changed token inventory, authority or rent.');
  const nextCurve = decodePumpLaunchConfig(
    'BondingCurve',
    bytes(get(after, route.accounts.bonding_curve)),
  );
  for (const name of Object.keys(curve))
    if (
      ![
        'virtual_quote_reserves',
        'real_quote_reserves',
        'creator_fee',
        'protocol_fees',
      ].includes(name) &&
      nextCurve[name] !== curve[name]
    )
      volumeReject(
        'Simulation changed curve identity, mode or token reserves.',
      );
  const tip = BigInt(review.input.tipLamports),
    delta = BigInt(after[0].lamports) - BigInt(before[0].lamports);
  if (
    BigInt(get(after, review.input.tipRecipient).lamports) -
      BigInt(get(before, review.input.tipRecipient).lamports) !==
      tip ||
    -delta > BigInt(review.input.maximumLossLamports) ||
    after
      .slice(0, addresses.length - 1)
      .reduce(
        (sum, a, i) => sum + BigInt(a.lamports) - BigInt(before[i].lamports),
        0n,
      ) !== -fee
  )
    volumeReject('Simulation tip, loss or native conservation differs.');
  const nativeAllowed = new Set([
    review.wallet,
    review.input.tipRecipient,
    route.accounts.bonding_curve,
    route.accounts.fee_recipient,
    route.accounts.creator_vault,
  ]);
  if (
    keys.some(
      (key, i) =>
        !nativeAllowed.has(key) && before[i].lamports !== after[i].lamports,
    )
  )
    volumeReject('Unexpected native account movement.');
  const transfers = reviewVolumePumpInner(
    review,
    route,
    keys,
    value.innerInstructions,
  );
  const sell = delta + transfers.buyLamports + fee + tip;
  if (
    transfers.buyLamports >
      BigInt(review.input.plan.rounds[review.input.round].buyLamports) ||
    sell < BigInt(review.input.minimumSellLamports)
  )
    volumeReject('Simulated buy budget or sell proceeds differs.');
  const final = await snapshot();
  if (
    before
      .slice(0, keys.length)
      .some((a, i) => JSON.stringify(a) !== JSON.stringify(final[i]))
  )
    volumeReject('Live pre-state changed during unsigned simulation.');
  // Nine-call budget: genesis, two snapshots, fee, two validity+height checks, one simulation.
  await lifetime();
  current();
  const result = {
    format: 'volume-pump-unsigned-simulation-v1' as const,
    constructionSha256: review.sha256,
    routeSha256: route.sha256,
    packetSha256: review.packetSha256,
    slotMin: Math.min(...slots),
    slotMax: Math.max(...slots),
    observedAt: new Date(now()).toISOString(),
    unitsConsumed: units.toString(),
    feeLamports: fee.toString(),
    tipLamports: tip.toString(),
    buyLamports: transfers.buyLamports.toString(),
    sellLamports: sell.toString(),
    netLamports: delta.toString(),
    preStateSha256: await volumeDigest(before),
    simulatedStateSha256: await volumeDigest(after),
    originalBlockhashRetained: true as const,
    simulationChecksPassed: true as const,
    programCodeAdmissionRequired: true as const,
    trustedTransportRequired: true as const,
    durableTransitionRequired: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
  const sha256 = await volumeDigest(result);
  current();
  return { ...result, sha256 };
}

/** Raw CPI evidence supplements account bytes; logs and caller-provided net deltas are never used. */
function reviewVolumePumpInner(
  review: VolumeBundleConstruction,
  route: VolumePumpRoute,
  keys: string[],
  raw: unknown,
) {
  const groups = raw as {
    index: number;
    instructions: {
      programIdIndex: number;
      accounts: number[];
      data: string;
    }[];
  }[];
  if (
    !Array.isArray(groups) ||
    groups.length !== 2 ||
    groups[0].index !== 0 ||
    groups[1].index !== 1
  )
    return volumeReject(
      'Complete ordered buy and sell inner instructions required.',
    );
  let buyLamports = 0n;
  for (const group of groups) {
    if (!Array.isArray(group.instructions) || group.instructions.length > 128)
      volumeReject('Inner instruction count exceeds policy.');
    let tokenTransfers = 0;
    for (const ix of group.instructions) {
      if (
        !Number.isSafeInteger(ix.programIdIndex) ||
        !keys[ix.programIdIndex] ||
        !Array.isArray(ix.accounts) ||
        ix.accounts.length > 64 ||
        ix.accounts.some((i) => !Number.isSafeInteger(i) || !keys[i]) ||
        typeof ix.data !== 'string' ||
        ix.data.length > 4096
      )
        volumeReject('Raw inner instruction differs.');
      const program = keys[ix.programIdIndex],
        accounts = ix.accounts.map((i) => keys[i]);
      if (
        ![VOLUME_PUMP, VOLUME_PUMP_FEE, VOLUME_TOKEN, VOLUME_SYSTEM].includes(
          program,
        ) ||
        accounts.includes(review.input.tipRecipient)
      )
        volumeReject('Unexpected CPI program or tip access.');
      const b = bs58.decode(ix.data),
        v = new DataView(b.buffer, b.byteOffset, b.length);
      if (program === VOLUME_TOKEN) {
        const checked = b[0] === 12 && b.length === 10 && accounts.length === 4;
        if (
          !checked &&
          !(b[0] === 3 && b.length === 9 && accounts.length === 3)
        )
          volumeReject('Only exact token transfers are admitted.');
        const source =
          group.index === 0
            ? route.accounts.associated_bonding_curve
            : review.input.tokenAccount;
        const destination =
          group.index === 0
            ? review.input.tokenAccount
            : route.accounts.associated_bonding_curve;
        const authority =
          group.index === 0 ? route.accounts.bonding_curve : review.wallet;
        if (
          accounts[0] !== source ||
          accounts[checked ? 2 : 1] !== destination ||
          accounts[checked ? 3 : 2] !== authority ||
          v.getBigUint64(1, true) !== BigInt(review.input.tokenAmountRaw) ||
          (checked && (accounts[1] !== review.input.mint || b[9] !== 6))
        )
          volumeReject(
            'Token source, destination, amount or authority differs.',
          );
        tokenTransfers++;
      }
      if (program === VOLUME_SYSTEM) {
        if (
          group.index !== 0 ||
          b.length !== 12 ||
          v.getUint32(0, true) !== 2 ||
          accounts.length !== 2 ||
          accounts[0] !== review.wallet ||
          ![
            route.accounts.bonding_curve,
            route.accounts.fee_recipient,
            route.accounts.creator_vault,
          ].includes(accounts[1])
        )
          volumeReject('Unexpected native transfer or account operation.');
        buyLamports += v.getBigUint64(4, true);
      }
    }
    if (tokenTransfers !== 1)
      volumeReject('Exactly one token movement per leg required.');
  }
  if (buyLamports <= 0n) volumeReject('Missing native buy payments.');
  return { buyLamports };
}
