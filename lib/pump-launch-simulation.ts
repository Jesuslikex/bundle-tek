import bs58 from 'bs58';
import {
  address,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import {
  getExtensionDecoder,
  getExtensionEncoder,
} from '@solana-program/token-2022';
import {
  buildPumpCreateMessage,
  pumpCreateAddresses,
  type PumpCreateInput,
} from './pump-launch-message';
import {
  decodePumpLaunchConfig,
  inspectPumpQuoteMint,
  PUMP_LAUNCH_PROGRAM,
  PUMP_NATIVE_QUOTE,
  PUMP_TOKEN_2022,
  type PumpLaunchAccount,
} from './pump-launch-config';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaIndexerRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';

export type PumpLaunchRpc = (
  method: string,
  params: unknown[],
  signal: AbortSignal,
) => Promise<unknown>;
export type PumpCreateIntent = Pick<
  PumpCreateInput,
  'name' | 'symbol' | 'uri' | 'payer' | 'mint' | 'quoteMint'
>;
export type PumpRpcAccount = {
  owner: string;
  executable: boolean;
  lamports: string;
  data: [string, 'base64'];
} | null;
const SYSTEM = '11111111111111111111111111111111';
const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const LOADERS = [UPGRADEABLE, 'BPFLoader2111111111111111111111111111111111'];
const uint = (v: unknown) => {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    throw new Error('Pump RPC integer is unavailable.');
  return BigInt(v);
};
const slot = (v: unknown) => {
  const n = Number(uint(v));
  if (!Number.isSafeInteger(n)) throw new Error('Pump RPC slot differs.');
  return n;
};
const bytes = (a: NonNullable<PumpRpcAccount>) =>
  Uint8Array.from(atob(a.data[0]), (c) => c.charCodeAt(0));
const digest = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
function account(value: unknown): PumpRpcAccount {
  if (value === null) return null;
  const a = value as NonNullable<PumpRpcAccount>;
  if (
    !a ||
    typeof a.executable !== 'boolean' ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[1] !== 'base64' ||
    typeof a.data[0] !== 'string' ||
    a.data[0].length > 1048576 ||
    btoa(atob(a.data[0])) !== a.data[0]
  )
    throw new Error('Pump RPC account bytes differ.');
  address(a.owner);
  uint(a.lamports);
  return {
    owner: a.owner,
    executable: a.executable,
    lamports: a.lamports,
    data: a.data,
  };
}
function system(a: PumpRpcAccount) {
  return a !== null && a.owner === SYSTEM && !a.executable && a.data[0] === '';
}
function token(
  a: PumpRpcAccount,
  expected: { program: string; mint: string; owner: string; amount: bigint },
) {
  if (!a || a.executable || a.owner !== expected.program)
    throw new Error('Simulated Pump custody program differs.');
  const b = bytes(a),
    v = new DataView(b.buffer);
  if (
    b.length < 165 ||
    bs58.encode(b.slice(0, 32)) !== expected.mint ||
    bs58.encode(b.slice(32, 64)) !== expected.owner ||
    v.getBigUint64(64, true) !== expected.amount ||
    b[108] !== 1 ||
    v.getUint32(72, true) !== 0 ||
    v.getBigUint64(121, true) !== 0n ||
    v.getUint32(109, true) !== 0 ||
    v.getUint32(129, true) !== 0
  )
    throw new Error(
      'Simulated Pump custody identity, amount or authority differs.',
    );
  if (b.length !== 165) {
    if (expected.program !== PUMP_TOKEN_2022 || b.length < 166 || b[165] !== 2)
      throw new Error('Simulated Pump custody extensions differ.');
    const kinds = new Set<string>();
    for (let offset = 166; offset < b.length;) {
      if (b.slice(offset).every((n) => n === 0)) break;
      if (offset + 4 > b.length)
        throw new Error('Truncated Pump custody extension.');
      const end = offset + 4 + v.getUint16(offset + 2, true);
      if (end > b.length) throw new Error('Truncated Pump custody extension.');
      const encoded = b.slice(offset, end),
        e = getExtensionDecoder().decode(encoded),
        canonical = getExtensionEncoder().encode(e);
      if (
        !['ImmutableOwner', 'PausableAccount', 'TransferHookAccount'].includes(
          e.__kind,
        ) ||
        kinds.has(e.__kind) ||
        (e.__kind === 'TransferHookAccount' && e.transferring) ||
        canonical.length !== encoded.length ||
        canonical.some((n, i) => n !== encoded[i])
      )
        throw new Error('Simulated Pump custody extension is unsupported.');
      kinds.add(e.__kind);
      offset = end;
    }
  }
}

/** Bounded read-only RPC collector. Passing simulation does not enable signing. */
export async function simulatePumpCreate(
  intent: PumpCreateIntent,
  feeAndRentLimitRaw: string,
  signal: AbortSignal,
  suppliedRpc?: PumpLaunchRpc,
  fetcher: typeof fetch = fetch,
  lifetime?: { blockhash: string; lastValidBlockHeight: string },
) {
  const i = structuredClone(intent),
    limit = uint(feeAndRentLimitRaw);
  if (limit === 0n)
    throw new Error('Review a positive fee and rent allowance.');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(25000)]);
  let provider = suppliedRpc;
  if (!provider) {
    const endpoint = getSolanaIndexerRpcEndpoint(),
      url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('Pump RPC configuration requires HTTPS.');
    provider = (method, params, s) =>
      balanceRpc(endpoint, method, params, s, fetcher, 2097152);
  }
  const call = (method: string, params: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const abort = () =>
        reject(new Error('Pump launch preflight was cancelled or timed out.'));
      if (deadline.aborted) {
        abort();
        return;
      }
      deadline.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => provider!(method, params, deadline))
        .then(resolve, () =>
          reject(new Error('Pump launch RPC read is unavailable.')),
        )
        .finally(() => deadline.removeEventListener('abort', abort));
    });
  if ((await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new Error('Pump launch RPC is not mainnet.');
  const latest = (await call('getLatestBlockhash', [
    { commitment: 'confirmed' },
  ])) as {
    context?: { slot?: unknown };
    value?: { blockhash?: unknown; lastValidBlockHeight?: unknown };
  };
  const slots = [slot(latest.context?.slot)],
    latestHash = lifetime?.blockhash ?? latest.value?.blockhash,
    lastValidBlockHeight = uint(
      lifetime?.lastValidBlockHeight ?? latest.value?.lastValidBlockHeight,
    );
  if (typeof latestHash !== 'string')
    throw new Error('Pump launch blockhash is unavailable.');
  const pdas = await pumpCreateAddresses(i.mint);
  const observe = (value: unknown, minimum: number) => {
    const n = slot(value);
    if (n < minimum)
      throw new Error('Pump RPC ignored its minimum context slot.');
    slots.push(n);
    requireConsistentSolanaSlots(slots);
    return n;
  };
  async function snapshot(keys: string[], minimum: number, sliced = false) {
    const result = (await call('getMultipleAccounts', [
      keys,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        minContextSlot: minimum,
        ...(sliced ? { dataSlice: { offset: 0, length: 45 } } : {}),
      },
    ])) as { context?: { slot?: unknown }; value?: unknown[] };
    const observed = observe(result.context?.slot, minimum);
    if (!Array.isArray(result.value) || result.value.length !== keys.length)
      throw new Error('Pump RPC account mapping differs.');
    return { accounts: result.value.map(account), slot: observed };
  }
  const configKeys = [
    pdas.global,
    pdas.control,
    ...(i.quoteMint === PUMP_NATIVE_QUOTE ? [] : [i.quoteMint]),
  ];
  const initial = await snapshot(configKeys, slots[0]);
  const config = (key: string, a: PumpRpcAccount): PumpLaunchAccount => {
    if (!a)
      throw new Error('Pump launch configuration or quote mint is missing.');
    return {
      address: key,
      owner: a.owner,
      executable: a.executable,
      data: bytes(a),
      slot: initial.slot,
    };
  };
  const context = {
    payer: i.payer,
    mint: i.mint,
    blockhash: latestHash,
    lastValidBlockHeight,
    global: config(pdas.global, initial.accounts[0]),
    ...(initial.accounts[1]
      ? { quoteControl: config(pdas.control, initial.accounts[1]) }
      : {}),
    ...(i.quoteMint !== PUMP_NATIVE_QUOTE
      ? { quoteMintAccount: config(i.quoteMint, initial.accounts[2]) }
      : {}),
  };
  const preparation = await buildPumpCreateMessage({ ...i, ...context });
  const tx = getTransactionDecoder().decode(
    Uint8Array.from(atob(preparation.transaction), (c) => c.charCodeAt(0)),
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (message.version !== 'legacy')
    throw new Error('Pump create message version differs.');
  const keys = message.staticAccounts.map(String),
    message64 = btoa(String.fromCharCode(...tx.messageBytes));
  const feeResult = (await call('getFeeForMessage', [
    message64,
    { commitment: 'confirmed', minContextSlot: Math.max(...slots) },
  ])) as { context?: { slot?: unknown }; value?: unknown };
  observe(feeResult.context?.slot, Math.max(...slots));
  const fee = uint(feeResult.value);
  if (fee === 0n || fee > limit)
    throw new Error('Pump network fee exceeds the reviewed allowance.');
  const beforeSnapshot = await snapshot(keys, Math.max(...slots)),
    before = beforeSnapshot.accounts;
  const at = (key: string, accounts: PumpRpcAccount[]) => {
    const index = keys.indexOf(key);
    if (index < 0) throw new Error('Pump packet account is missing.');
    return accounts[index];
  };
  const payerBefore = at(i.payer, before);
  if (!system(payerBefore) || uint(payerBefore!.lamports) < limit)
    throw new Error(
      'Pump payer needs an ordinary SOL account with its full reviewed allowance.',
    );
  for (const key of [
    i.mint,
    pdas.bondingCurve,
    pdas.associatedCurve,
    pdas.mayhemState,
    pdas.mayhemTokenVault,
    ...(i.quoteMint !== PUMP_NATIVE_QUOTE
      ? [String(preparation.instruction.accounts![17].address)]
      : []),
  ])
    if (at(key, before) !== null)
      throw new Error(
        'Pump mint or its derived launch accounts already exist.',
      );
  for (let n = 0; n < configKeys.length; n++)
    if (
      keys.includes(configKeys[n]) &&
      (await digest(at(configKeys[n], before))) !==
        (await digest(initial.accounts[n]))
    )
      throw new Error('Pump configuration changed before simulation.');
  const programKeys = [
    PUMP_LAUNCH_PROGRAM,
    ...preparation.instruction
      .accounts!.slice(6, 10)
      .map((a) => String(a.address)),
  ].filter((k) => k !== SYSTEM);
  const programDataKeys: string[] = [];
  for (const key of new Set(programKeys)) {
    const a = at(key, before);
    if (!a?.executable || !LOADERS.includes(a.owner))
      throw new Error('Pump executable program or loader differs.');
    if (a.owner === UPGRADEABLE) {
      const b = bytes(a);
      if (b.length !== 36 || new DataView(b.buffer).getUint32(0, true) !== 2)
        throw new Error('Pump program-data link differs.');
      programDataKeys.push(bs58.encode(b.slice(4)));
    }
  }
  const dataKeys = [...new Set(programDataKeys)],
    programData = dataKeys.length
      ? await snapshot(dataKeys, Math.max(...slots), true)
      : null;
  if (programData)
    for (const a of programData.accounts) {
      if (!a || a.executable || a.owner !== UPGRADEABLE)
        throw new Error('Pump program-data metadata differs.');
      const b = bytes(a),
        v = new DataView(b.buffer);
      if (
        b.length !== 45 ||
        v.getUint32(0, true) !== 3 ||
        b[12] > 1 ||
        v.getBigUint64(4, true) > BigInt(programData.slot)
      )
        throw new Error('Pump program deployment metadata differs.');
    }
  const result = (await call('simulateTransaction', [
    preparation.transaction,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      sigVerify: false,
      replaceRecentBlockhash: false,
      minContextSlot: Math.max(...slots),
      accounts: { encoding: 'base64', addresses: keys },
      innerInstructions: false,
    },
  ])) as {
    context?: { slot?: unknown };
    value?: {
      err?: unknown;
      accounts?: unknown[];
      unitsConsumed?: unknown;
      replacementBlockhash?: unknown;
      fee?: unknown;
    };
  };
  const simulationSlot = observe(result.context?.slot, Math.max(...slots)),
    sim = result.value;
  if (!sim || sim.err !== null)
    throw new Error(
      'Pump create simulation failed. No signing approval was created.',
    );
  if (
    sim.replacementBlockhash != null ||
    (sim.fee != null && uint(sim.fee) !== fee) ||
    !Array.isArray(sim.accounts) ||
    sim.accounts.length !== keys.length
  )
    throw new Error('Pump simulation packet, fee or account mapping differs.');
  const units = uint(sim.unitsConsumed);
  if (units === 0n || units > 300000n)
    throw new Error('Pump simulation compute limit differs.');
  const after = sim.accounts.map(account),
    payerAfter = at(i.payer, after);
  if (!system(payerAfter))
    throw new Error('Pump simulation changed payer authority.');
  const debit = uint(payerBefore!.lamports) - uint(payerAfter!.lamports);
  if (debit < fee || debit > limit)
    throw new Error('Pump fee and rent debit exceeds the reviewed allowance.');
  const writable = keys.map(
    (_, n) =>
      n <
        message.header.numSignerAccounts -
          message.header.numReadonlySignerAccounts ||
      (n >= message.header.numSignerAccounts &&
        n < keys.length - message.header.numReadonlyNonSignerAccounts),
  );
  for (let n = 0; n < keys.length; n++)
    if (
      (!writable[n] || before[n]?.executable) &&
      (await digest(before[n])) !== (await digest(after[n]))
    )
      throw new Error(
        'Pump simulation changed a readonly or executable account.',
      );
  const total = (accounts: PumpRpcAccount[]) =>
    accounts.reduce((n, a) => n + (a ? uint(a.lamports) : 0n), 0n);
  if (total(before) - total(after) !== fee)
    throw new Error(
      'Pump simulated SOL movements do not reconcile with its network fee.',
    );
  const mintAccount = at(i.mint, after);
  if (!mintAccount) throw new Error('Pump simulation did not create the mint.');
  const createdMint = inspectPumpQuoteMint({
    address: i.mint,
    owner: mintAccount.owner,
    executable: mintAccount.executable,
    data: bytes(mintAccount),
    slot: simulationSlot,
  });
  if (
    mintAccount.owner !== PUMP_TOKEN_2022 ||
    createdMint.decimals !== 6 ||
    createdMint.supplyRaw !== preparation.quote.tokenSupplyRaw ||
    createdMint.freezeAuthority !== null ||
    (createdMint.mintAuthority !== null &&
      createdMint.mintAuthority !== pdas.mintAuthority) ||
    createdMint.extensions.length !== 2 ||
    !createdMint.extensions.includes('MetadataPointer') ||
    !createdMint.extensions.includes('TokenMetadata')
  )
    throw new Error(
      'Pump simulated mint supply, extensions or authority differs.',
    );
  const pointer = createdMint.extensionDetails.find(
      (e) => e.__kind === 'MetadataPointer',
    ),
    metadata = createdMint.extensionDetails.find(
      (e) => e.__kind === 'TokenMetadata',
    );
  if (
    pointer?.__kind !== 'MetadataPointer' ||
    pointer.metadataAddress.__option !== 'Some' ||
    pointer.metadataAddress.value !== i.mint ||
    metadata?.__kind !== 'TokenMetadata' ||
    metadata.name !== i.name ||
    metadata.symbol !== i.symbol ||
    metadata.uri !== i.uri ||
    metadata.additionalMetadata.size !== 0
  )
    throw new Error(
      'Pump simulated token metadata differs from the reviewed release.',
    );
  const curveAccount = at(pdas.bondingCurve, after);
  if (
    !curveAccount ||
    curveAccount.owner !== PUMP_LAUNCH_PROGRAM ||
    curveAccount.executable
  )
    throw new Error('Pump simulated curve owner differs.');
  const curve = decodePumpLaunchConfig('BondingCurve', bytes(curveAccount)),
    global = decodePumpLaunchConfig('Global', context.global.data);
  if (
    curve.virtual_token_reserves !==
      BigInt(preparation.quote.initialVirtualTokenReservesRaw) ||
    curve.virtual_quote_reserves !==
      BigInt(preparation.quote.initialVirtualQuoteReservesRaw) ||
    curve.real_token_reserves !== global.initial_real_token_reserves ||
    curve.real_quote_reserves !== 0n ||
    curve.token_total_supply !== BigInt(preparation.quote.tokenSupplyRaw) ||
    curve.complete !== false ||
    curve.creator !== i.payer ||
    curve.is_mayhem_mode !== false ||
    curve.is_cashback_coin !== false ||
    curve.is_holder_reward !== false ||
    curve.creator_fee_bps !== 0n ||
    curve.creator_fee !== 0n ||
    curve.protocol_fees !== 0n ||
    curve.depth !== 0 ||
    curve.quote_mint !==
      (i.quoteMint === PUMP_NATIVE_QUOTE ? SYSTEM : i.quoteMint) ||
    curve.initial_virtual_quote_reserves !==
      BigInt(preparation.quote.initialVirtualQuoteReservesRaw) ||
    curve.post_complete_base_out !== 0n ||
    curve.post_complete_quote_in !== 0n
  )
    throw new Error(
      'Pump simulated curve identity, quote or initial reserves differ.',
    );
  token(at(pdas.associatedCurve, after), {
    program: PUMP_TOKEN_2022,
    mint: i.mint,
    owner: pdas.bondingCurve,
    amount: BigInt(preparation.quote.tokenSupplyRaw),
  });
  if (i.quoteMint !== PUMP_NATIVE_QUOTE)
    token(at(String(preparation.instruction.accounts![17].address), after), {
      program: preparation.quote.tokenProgram,
      mint: i.quoteMint,
      owner: pdas.bondingCurve,
      amount: 0n,
    });
  const rent = new Map<number, bigint>(),
    createdAccounts = [];
  for (let n = 0; n < keys.length; n++)
    if (
      after[n] &&
      !after[n]!.executable &&
      bytes(after[n]!).length &&
      writable[n]
    ) {
      const size = bytes(after[n]!).length;
      let minimum = rent.get(size);
      if (minimum === undefined) {
        minimum = uint(
          await call('getMinimumBalanceForRentExemption', [
            size,
            { commitment: 'confirmed' },
          ]),
        );
        rent.set(size, minimum);
      }
      if (minimum === 0n || uint(after[n]!.lamports) < minimum)
        throw new Error('Pump created account rent is insufficient.');
      createdAccounts.push({
        address: keys[n],
        space: size,
        minimumRentRaw: minimum.toString(),
        postLamports: after[n]!.lamports,
      });
    }
  const stable = await snapshot(keys, Math.max(...slots));
  for (let n = 0; n < keys.length; n++)
    if ((await digest(stable.accounts[n])) !== (await digest(before[n])))
      throw new Error(
        'Pump payer, mint or configuration changed during simulation.',
      );
  if (programData) {
    const check = await snapshot(dataKeys, Math.max(...slots), true);
    for (let n = 0; n < dataKeys.length; n++)
      if (
        (await digest(check.accounts[n])) !==
        (await digest(programData.accounts[n]))
      )
        throw new Error('Pump program deployment changed during simulation.');
  }
  const validity = (await call('isBlockhashValid', [
    latestHash,
    { commitment: 'confirmed', minContextSlot: Math.max(...slots) },
  ])) as { context?: { slot?: unknown }; value?: unknown };
  observe(validity.context?.slot, Math.max(...slots));
  if (
    validity.value !== true ||
    uint(await call('getBlockHeight', [{ commitment: 'confirmed' }])) + 10n >
      lastValidBlockHeight
  )
    throw new Error('Pump launch blockhash expired or is near expiry.');
  if (
    (await call('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS ||
    deadline.aborted
  )
    throw new Error('Pump simulation network or cancellation state changed.');
  const observedAt = new Date().toISOString();
  const resultReport = {
    preparation,
    context,
    executionAllowed: false as const,
    signingAllowed: false as const,
    completeLaunch: false as const,
    simulation: {
      status: 'Simulated' as const,
      slot: simulationSlot,
      observedAt,
      expiresAt: new Date(Date.parse(observedAt) + 60000).toISOString(),
      networkFeeRaw: fee.toString(),
      feeAndRentLimitRaw,
      payerDebitRaw: debit.toString(),
      unitsConsumed: units.toString(),
      createdAccounts,
      mintAuthority: createdMint.mintAuthority,
      metadataPointerAuthority: pointer.authority,
      metadataUpdateAuthority: metadata.updateAuthority,
      programDeploymentMetadataOnly: true as const,
      blockhashMustBeRechecked: true as const,
      authorityReviewRequired: true as const,
      nativeMovements: keys.flatMap((key, n) => {
        const beforeRaw = before[n]?.lamports ?? '0',
          afterRaw = after[n]?.lamports ?? '0';
        return beforeRaw === afterRaw
          ? []
          : [
              {
                address: key,
                beforeRaw,
                afterRaw,
                deltaRaw: (BigInt(afterRaw) - BigInt(beforeRaw)).toString(),
                created: before[n] === null,
                ownerBefore: before[n]?.owner ?? null,
                ownerAfter: after[n]?.owner ?? null,
              },
            ];
      }),
      accountHashes: await Promise.all(
        keys.map(async (key, n) => ({
          address: key,
          beforeSha256: await digest(before[n]),
          simulatedSha256: await digest(after[n]),
        })),
      ),
      programDeploymentHashes: await Promise.all(
        dataKeys.map(async (key, n) => ({
          address: key,
          sha256: await digest(programData!.accounts[n]),
        })),
      ),
      minimumSlot: Math.min(...slots),
      maximumSlot: Math.max(...slots),
    },
  };
  if (deadline.aborted)
    throw new Error('Pump launch preflight was cancelled or timed out.');
  return resultReport;
}
