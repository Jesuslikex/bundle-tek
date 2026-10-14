import bs58 from 'bs58';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import {
  simulatePumpCreate,
  pumpRpcAccount,
  pumpAccountBytes,
  pumpUnsignedInteger,
  pumpSystemAccount,
  verifyPumpTokenCustody,
  type PumpCreateIntent,
  type PumpLaunchRpc,
  type PumpRpcAccount,
} from './pump-launch-simulation';
import { buildPumpCreateAndBuyMessage } from './pump-initial-buy-message';
import {
  decodePumpInitialBuyState,
  pumpInitialBuyPrice,
} from './pump-initial-buy-state';
import {
  decodePumpLaunchConfig,
  inspectPumpQuoteMint,
  PUMP_NATIVE_QUOTE,
  PUMP_LAUNCH_PROGRAM,
  PUMP_TOKEN_2022,
} from './pump-launch-config';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaIndexerRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';

export type PumpInitialBuyIntent = PumpCreateIntent & {
  tokenAmountRaw: string;
  maximumQuoteCostRaw: string;
};
const SYSTEM = '11111111111111111111111111111111',
  UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const loaders = [UPGRADEABLE, 'BPFLoader2111111111111111111111111111111111'];
const hash = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
const lamports = (account: PumpRpcAccount) =>
  account ? pumpUnsignedInteger(account.lamports) : 0n;
const tokenAmount = (account: PumpRpcAccount) => {
  if (!account || pumpAccountBytes(account).length < 165)
    throw new Error('Initial buy token custody is unavailable.');
  const bytes = pumpAccountBytes(account);
  return new DataView(bytes.buffer).getBigUint64(64, true);
};
function sameTokenExceptAmount(before: PumpRpcAccount, after: PumpRpcAccount) {
  if (
    !before ||
    !after ||
    before.owner !== after.owner ||
    before.executable !== after.executable ||
    before.lamports !== after.lamports
  )
    throw new Error('Initial buy token custody state changed.');
  const a = pumpAccountBytes(before),
    b = pumpAccountBytes(after);
  a.fill(0, 64, 72);
  b.fill(0, 64, 72);
  if (a.length !== b.length || a.some((byte, index) => byte !== b[index]))
    throw new Error('Initial buy token authority or extension state changed.');
}

/** Two independent unsigned simulations: creation invariants, then exact atomic settlement. Never issues approval or signatures. */
export async function simulatePumpInitialBuy(
  supplied: PumpInitialBuyIntent,
  feeAndRentLimitRaw: string,
  signal: AbortSignal,
  suppliedRpc?: PumpLaunchRpc,
  fetcher: typeof fetch = fetch,
  lifetime?: { blockhash: string; lastValidBlockHeight: string },
) {
  const input = structuredClone(supplied);
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'name',
          'symbol',
          'uri',
          'payer',
          'mint',
          'quoteMint',
          'tokenAmountRaw',
          'maximumQuoteCostRaw',
        ].includes(key),
    )
  )
    throw new Error('Unsupported initial buy intent.');
  const { tokenAmountRaw, maximumQuoteCostRaw, ...intent } = input;
  const quoteLimit = pumpUnsignedInteger(maximumQuoteCostRaw),
    allowance = pumpUnsignedInteger(feeAndRentLimitRaw);
  if (quoteLimit === 0n || allowance === 0n)
    throw new Error('Review positive quote and fee/rent allowances.');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
  let reads = 0,
    provider = suppliedRpc;
  if (!provider) {
    const endpoint = getSolanaIndexerRpcEndpoint(),
      url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash)
      throw new Error('Pump initial buy RPC requires HTTPS.');
    provider = (method, params, abort) =>
      balanceRpc(endpoint, method, params, abort, fetcher, 2097152);
  }
  const methods = new Set([
    'getGenesisHash',
    'getLatestBlockhash',
    'getMultipleAccounts',
    'getFeeForMessage',
    'simulateTransaction',
    'getMinimumBalanceForRentExemption',
    'isBlockhashValid',
    'getBlockHeight',
  ]);
  const call: PumpLaunchRpc = async (method, params, requestSignal) => {
    if (!methods.has(method) || ++reads > 48)
      throw new Error('Initial buy RPC read budget exceeded.');
    return new Promise((resolve, reject) => {
      const currentSignal = AbortSignal.any([deadline, requestSignal]);
      const abort = () =>
        reject(new Error('Initial buy preflight was cancelled or timed out.'));
      if (currentSignal.aborted) {
        abort();
        return;
      }
      currentSignal.addEventListener('abort', abort, { once: true });
      Promise.resolve()
        .then(() => provider!(method, params, currentSignal))
        .then(resolve, () =>
          reject(new Error('Initial buy RPC read is unavailable.')),
        )
        .finally(() => currentSignal.removeEventListener('abort', abort));
    });
  };
  const creation = await simulatePumpCreate(
    intent,
    feeAndRentLimitRaw,
    deadline,
    call,
    fetcher,
    lifetime,
  );
  const preparation = await buildPumpCreateAndBuyMessage({
    create: { ...intent, ...creation.context },
    tokenAmountRaw,
    maximumQuoteCostRaw,
    transactionVersion: 1,
  });
  const tx = getTransactionDecoder().decode(
      Uint8Array.from(atob(preparation.transaction), (char) =>
        char.charCodeAt(0),
      ),
    ),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  if (message.version !== 1 || message.configMask !== 15)
    throw new Error('Initial buy packet version or resource config differs.');
  const keys = message.staticAccounts.map(String),
    slots = [creation.simulation.minimumSlot, creation.simulation.maximumSlot];
  function observe(value: unknown, minimum: number) {
    const slot = Number(pumpUnsignedInteger(value));
    if (!Number.isSafeInteger(slot) || slot < minimum)
      throw new Error('Initial buy RPC ignored its context slot.');
    slots.push(slot);
    requireConsistentSolanaSlots(slots);
    return slot;
  }
  const minimum = () => Math.max(...slots);
  async function snapshot(addresses: string[], sliced = false) {
    const result = (await call(
      'getMultipleAccounts',
      [
        addresses,
        {
          encoding: 'base64',
          commitment: 'confirmed',
          minContextSlot: minimum(),
          ...(sliced ? { dataSlice: { offset: 0, length: 45 } } : {}),
        },
      ],
      deadline,
    )) as { context?: { slot?: unknown }; value?: unknown[] };
    const slot = observe(result.context?.slot, minimum());
    if (
      !Array.isArray(result.value) ||
      result.value.length !== addresses.length
    )
      throw new Error('Initial buy account mapping differs.');
    return { slot, accounts: result.value.map(pumpRpcAccount) };
  }
  const feeResult = (await call(
    'getFeeForMessage',
    [
      btoa(String.fromCharCode(...tx.messageBytes)),
      { commitment: 'confirmed', minContextSlot: minimum() },
    ],
    deadline,
  )) as { context?: { slot?: unknown }; value?: unknown };
  observe(feeResult.context?.slot, minimum());
  const fee = pumpUnsignedInteger(feeResult.value);
  if (fee === 0n || fee > allowance)
    throw new Error('Initial buy network fee exceeds its allowance.');
  const before = (await snapshot(keys)).accounts;
  const at = (key: string, accounts: PumpRpcAccount[]) => {
    const index = keys.indexOf(key);
    if (index < 0) throw new Error('Initial buy packet account is missing.');
    return accounts[index];
  };
  for (const observed of creation.simulation.accountHashes.filter(
    (item) => item.address !== 'ComputeBudget111111111111111111111111111111',
  )) {
    if (
      !keys.includes(observed.address) ||
      (await hash(at(observed.address, before))) !== observed.beforeSha256
    )
      throw new Error('Creation state changed before initial buy simulation.');
  }
  const native = intent.quoteMint === PUMP_NATIVE_QUOTE,
    payerBefore = at(intent.payer, before);
  if (native) {
    const account = at(intent.quoteMint, before);
    if (!account)
      throw new Error('Initial buy native quote mint is unavailable.');
    const details = inspectPumpQuoteMint({
      address: intent.quoteMint,
      owner: account.owner,
      executable: account.executable,
      data: pumpAccountBytes(account),
      slot: minimum(),
    });
    if (
      details.tokenProgram !== preparation.quote.tokenProgram ||
      details.decimals !== 9 ||
      details.extensions.length
    )
      throw new Error('Initial buy native quote mint differs.');
  }
  if (
    !pumpSystemAccount(payerBefore) ||
    lamports(payerBefore) < allowance + (native ? quoteLimit : 0n)
  )
    throw new Error(
      'Initial buy payer needs its full quote plus fee/rent allowances.',
    );
  if (at(preparation.userBaseAccount, before) !== null)
    throw new Error('Initial buy developer base-token account already exists.');
  const feeConfigAccount = at(preparation.feeConfig, before);
  if (
    !feeConfigAccount ||
    feeConfigAccount.executable ||
    feeConfigAccount.owner !== 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'
  )
    throw new Error('Initial buy fee configuration owner differs.');
  const feeConfig = decodePumpInitialBuyState(
    'FeeConfig',
    pumpAccountBytes(feeConfigAccount),
  );
  const price = pumpInitialBuyPrice({
    quoteMint: intent.quoteMint,
    virtualTokensRaw: preparation.quote.initialVirtualTokenReservesRaw,
    virtualQuoteRaw: preparation.quote.initialVirtualQuoteReservesRaw,
    tokenAmountRaw,
    feeConfig,
  });
  const principal = BigInt(price.principalRaw),
    protocolFee = BigInt(price.protocolFeeRaw),
    creatorFee = BigInt(price.creatorFeeRaw),
    quoteCost = BigInt(price.totalQuoteCostRaw);
  if (quoteCost > quoteLimit)
    throw new Error(
      'Initial buy price and fees exceed the reviewed quote cap.',
    );
  const buy = preparation.instructions.at(-1)!,
    curveKey = String(buy.accounts![5].address),
    curveBase = String(buy.accounts![6].address),
    curveQuote = String(buy.accounts![7].address);
  if (!native) {
    const quote = at(preparation.userQuoteAccount, before);
    verifyPumpTokenCustody(quote, {
      program: preparation.quote.tokenProgram,
      mint: intent.quoteMint,
      owner: intent.payer,
      amount: tokenAmount(quote),
    });
    if (tokenAmount(quote) < quoteLimit)
      throw new Error(
        'Initial buy needs the full reviewed quote-token allowance.',
      );
  }
  const buybackBefore = at(preparation.buybackAccount, before);
  if (native && !pumpSystemAccount(buybackBefore))
    throw new Error('Initial buy native buyback recipient is unavailable.');
  if (!native && buybackBefore)
    verifyPumpTokenCustody(buybackBefore, {
      program: preparation.quote.tokenProgram,
      mint: intent.quoteMint,
      owner: preparation.buybackRecipient,
      amount: tokenAmount(buybackBefore),
    });
  const volumeBefore = at(preparation.volumeAccount, before);
  function volume(account: PumpRpcAccount) {
    if (!account || account.owner !== PUMP_LAUNCH_PROGRAM || account.executable)
      throw new Error('Initial buy volume-account owner differs.');
    const value = decodePumpInitialBuyState(
      'UserVolumeAccumulator',
      pumpAccountBytes(account),
    );
    if (value.user !== intent.payer)
      throw new Error('Initial buy volume account belongs to another user.');
    return value;
  }
  const previousVolume = volumeBefore ? volume(volumeBefore) : null;
  const writable = keys.map(
    (_, index) =>
      index <
        message.header.numSignerAccounts -
          message.header.numReadonlySignerAccounts ||
      (index >= message.header.numSignerAccounts &&
        index < keys.length - message.header.numReadonlyNonSignerAccounts),
  );
  const programKeys = [
    ...new Set([
      ...preparation.instructions.map((instruction) =>
        String(instruction.programAddress),
      ),
      ...creation.preparation.instruction
        .accounts!.slice(7, 10)
        .map((account) => String(account.address)),
      preparation.quote.tokenProgram,
    ]),
  ];
  const dataKeys: string[] = [];
  for (const key of programKeys) {
    const account = at(key, before);
    if (!account?.executable || !loaders.includes(account.owner))
      throw new Error('Initial buy executable or loader differs.');
    if (account.owner === UPGRADEABLE) {
      const data = pumpAccountBytes(account);
      if (
        data.length !== 36 ||
        new DataView(data.buffer).getUint32(0, true) !== 2
      )
        throw new Error('Initial buy deployment link differs.');
      dataKeys.push(bs58.encode(data.slice(4)));
    }
  }
  for (const item of creation.simulation.programDeploymentHashes)
    if (!dataKeys.includes(item.address))
      throw new Error('Initial buy deployment coverage differs.');
  const distinctData = [...new Set(dataKeys)],
    deployments = distinctData.length
      ? (await snapshot(distinctData, true)).accounts
      : [];
  for (const [index, account] of deployments.entries()) {
    if (!account || account.executable || account.owner !== UPGRADEABLE)
      throw new Error('Initial buy deployment metadata differs.');
    const data = pumpAccountBytes(account),
      view = new DataView(data.buffer);
    if (
      data.length !== 45 ||
      view.getUint32(0, true) !== 3 ||
      data[12] > 1 ||
      view.getBigUint64(4, true) > BigInt(minimum())
    )
      throw new Error('Initial buy deployment metadata differs.');
    const baseline = creation.simulation.programDeploymentHashes.find(
      (item) => item.address === distinctData[index],
    );
    if (baseline && (await hash(account)) !== baseline.sha256)
      throw new Error('Program changed after creation simulation.');
  }
  const result = (await call(
    'simulateTransaction',
    [
      preparation.transaction,
      {
        encoding: 'base64',
        commitment: 'confirmed',
        sigVerify: false,
        replaceRecentBlockhash: false,
        minContextSlot: minimum(),
        accounts: { encoding: 'base64', addresses: keys },
        innerInstructions: false,
      },
    ],
    deadline,
  )) as {
    context?: { slot?: unknown };
    value?: {
      err?: unknown;
      accounts?: unknown[];
      fee?: unknown;
      replacementBlockhash?: unknown;
      unitsConsumed?: unknown;
      loadedAccountsDataSize?: unknown;
    };
  };
  const simulationSlot = observe(result.context?.slot, minimum()),
    sim = result.value;
  if (!sim || sim.err !== null)
    throw new Error(
      'Atomic Pump creation and initial buy simulation failed. No approval was created.',
    );
  if (
    sim.replacementBlockhash != null ||
    (sim.fee != null && pumpUnsignedInteger(sim.fee) !== fee) ||
    !Array.isArray(sim.accounts) ||
    sim.accounts.length !== keys.length
  )
    throw new Error(
      'Initial buy simulation packet, fee or account mapping differs.',
    );
  const units = pumpUnsignedInteger(sim.unitsConsumed);
  if (
    units === 0n ||
    units > 1400000n ||
    (sim.loadedAccountsDataSize != null &&
      pumpUnsignedInteger(sim.loadedAccountsDataSize) > 67108864n)
  )
    throw new Error('Initial buy simulation resource limit differs.');
  const after = sim.accounts.map(pumpRpcAccount),
    payerAfter = at(intent.payer, after);
  if (!pumpSystemAccount(payerAfter))
    throw new Error('Initial buy changed payer authority.');
  const minted = creation.simulation.accountHashes.find(
    (item) => item.address === intent.mint,
  )!;
  if ((await hash(at(intent.mint, after))) !== minted.simulatedSha256)
    throw new Error(
      'Initial buy changed the validated mint metadata, supply or authority.',
    );
  for (let index = 0; index < keys.length; index++)
    if (
      (!writable[index] || before[index]?.executable) &&
      (await hash(before[index])) !== (await hash(after[index]))
    )
      throw new Error('Initial buy changed a readonly or executable account.');
  const global = decodePumpLaunchConfig('Global', creation.context.global.data),
    curveAccount = at(curveKey, after);
  if (
    !curveAccount ||
    curveAccount.owner !== PUMP_LAUNCH_PROGRAM ||
    curveAccount.executable
  )
    throw new Error('Initial buy curve owner differs.');
  const curve = decodePumpLaunchConfig(
    'BondingCurve',
    pumpAccountBytes(curveAccount),
  );
  const amount = BigInt(tokenAmountRaw),
    supply = BigInt(preparation.quote.tokenSupplyRaw);
  if (
    curve.virtual_token_reserves !==
      BigInt(preparation.quote.initialVirtualTokenReservesRaw) - amount ||
    curve.real_token_reserves !==
      (global.initial_real_token_reserves as bigint) - amount ||
    curve.virtual_quote_reserves !==
      BigInt(preparation.quote.initialVirtualQuoteReservesRaw) + principal ||
    curve.real_quote_reserves !== principal ||
    curve.token_total_supply !== supply ||
    curve.complete !== false ||
    curve.creator !== intent.payer ||
    curve.is_mayhem_mode !== false ||
    curve.is_cashback_coin !== false ||
    curve.is_holder_reward !== false ||
    curve.creator_fee_bps !== 0n ||
    curve.can_edit_creator_fee !== false ||
    curve.creator_fee !== creatorFee ||
    curve.depth !== 0 ||
    curve.quote_mint !== (native ? SYSTEM : intent.quoteMint) ||
    curve.initial_virtual_quote_reserves !==
      BigInt(preparation.quote.initialVirtualQuoteReservesRaw) ||
    curve.post_complete_base_out !== 0n ||
    curve.post_complete_quote_in !== 0n
  )
    throw new Error(
      'Initial buy curve identity, custody or fee reserves differ.',
    );
  verifyPumpTokenCustody(at(curveBase, after), {
    program: PUMP_TOKEN_2022,
    mint: intent.mint,
    owner: curveKey,
    amount: supply - amount,
  });
  verifyPumpTokenCustody(at(preparation.userBaseAccount, after), {
    program: PUMP_TOKEN_2022,
    mint: intent.mint,
    owner: intent.payer,
    amount,
  });
  let buybackFee: bigint;
  if (native) {
    const recipient = at(preparation.buybackAccount, after);
    if (!pumpSystemAccount(recipient))
      throw new Error('Initial buy changed native fee-recipient authority.');
    buybackFee = lamports(recipient) - lamports(buybackBefore);
    for (const key of [curveQuote, preparation.userQuoteAccount])
      if ((await hash(at(key, before))) !== (await hash(at(key, after))))
        throw new Error('Initial buy changed unused wrapped SOL custody.');
  } else {
    const recipient = at(preparation.buybackAccount, after);
    buybackFee =
      tokenAmount(recipient) -
      (buybackBefore ? tokenAmount(buybackBefore) : 0n);
    verifyPumpTokenCustody(recipient, {
      program: preparation.quote.tokenProgram,
      mint: intent.quoteMint,
      owner: preparation.buybackRecipient,
      amount: tokenAmount(recipient),
    });
    if (buybackBefore) sameTokenExceptAmount(buybackBefore, recipient);
    const payerQuote = at(preparation.userQuoteAccount, after);
    verifyPumpTokenCustody(payerQuote, {
      program: preparation.quote.tokenProgram,
      mint: intent.quoteMint,
      owner: intent.payer,
      amount: tokenAmount(at(preparation.userQuoteAccount, before)) - quoteCost,
    });
    sameTokenExceptAmount(at(preparation.userQuoteAccount, before), payerQuote);
    verifyPumpTokenCustody(at(curveQuote, after), {
      program: preparation.quote.tokenProgram,
      mint: intent.quoteMint,
      owner: curveKey,
      amount: principal + creatorFee + protocolFee - buybackFee,
    });
  }
  const buybackBps = global.buyback_basis_points;
  if (
    typeof buybackBps !== 'bigint' ||
    buybackBps > 10000n ||
    buybackFee < 0n ||
    buybackFee > protocolFee ||
    curve.protocol_fees !== protocolFee - buybackFee ||
    (buybackBps === 0n && buybackFee !== 0n) ||
    (buybackBps === 10000n && buybackFee !== protocolFee)
  )
    throw new Error(
      'Initial buy retained and paid protocol fees do not reconcile.',
    );
  // Allocation is observed and conserved; the undocumented split rounding is deliberately not attested here.
  const volumeAfter = volume(at(preparation.volumeAccount, after));
  for (const key of [
    'needs_claim',
    'total_unclaimed_tokens',
    'total_claimed_tokens',
    'has_total_claimed_tokens',
    'cashback_earned',
    'total_cashback_claimed',
    'stable_cashback_earned',
    'total_stable_cashback_claimed',
  ])
    if (
      volumeAfter[key] !==
      (previousVolume?.[key] ??
        (typeof volumeAfter[key] === 'boolean' ? false : 0n))
    )
      throw new Error(
        'Initial buy changed unrelated volume rewards or claims.',
      );
  const volumeGain =
      (volumeAfter.current_sol_volume as bigint) -
      ((previousVolume?.current_sol_volume as bigint) ?? 0n),
    timestamp = volumeAfter.last_update_timestamp as bigint;
  if (
    volumeGain < 0n ||
    volumeGain > quoteCost ||
    timestamp < 0n ||
    timestamp < ((previousVolume?.last_update_timestamp as bigint) ?? 0n) ||
    timestamp > BigInt(Math.floor(Date.now() / 1000) + 60)
  )
    throw new Error('Initial buy volume accounting differs.');
  const mutable = new Set([
    intent.payer,
    curveKey,
    curveBase,
    preparation.userBaseAccount,
    preparation.volumeAccount,
    ...(!native
      ? [curveQuote, preparation.userQuoteAccount, preparation.buybackAccount]
      : [preparation.buybackAccount]),
  ]);
  for (const item of creation.simulation.accountHashes.filter(
    (item) => item.address !== 'ComputeBudget111111111111111111111111111111',
  ))
    if (
      !mutable.has(item.address) &&
      (await hash(at(item.address, after))) !== item.simulatedSha256
    )
      throw new Error('Initial buy changed unrelated creation state.');
  const rentKeys = new Set([
    intent.mint,
    curveKey,
    curveBase,
    preparation.userBaseAccount,
    preparation.volumeAccount,
    ...(!native ? [curveQuote, preparation.buybackAccount] : []),
  ]);
  let rentFunding = 0n;
  const rentBySize = new Map<number, bigint>(),
    rentAccounts = [];
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index],
      pre = before[index],
      post = after[index];
    if (!writable[index] || key === intent.payer) continue;
    const quoteCredit = native
      ? key === curveKey
        ? principal + creatorFee + protocolFee - buybackFee
        : key === preparation.buybackAccount
          ? buybackFee
          : 0n
      : 0n;
    const change = lamports(post) - lamports(pre) - quoteCredit;
    if (change < 0n || (!rentKeys.has(key) && change !== 0n))
      throw new Error('Initial buy contains unexplained SOL movements.');
    if (rentKeys.has(key) && post) {
      const size = pumpAccountBytes(post).length;
      if (!size || post.executable)
        throw new Error('Initial buy rent account differs.');
      let minimumRent = rentBySize.get(size);
      if (minimumRent === undefined) {
        minimumRent = pumpUnsignedInteger(
          await call(
            'getMinimumBalanceForRentExemption',
            [size, { commitment: 'confirmed' }],
            deadline,
          ),
        );
        rentBySize.set(size, minimumRent);
      }
      if (minimumRent === 0n || lamports(post) - quoteCredit < minimumRent)
        throw new Error('Initial buy rent exemption differs.');
      rentFunding += change;
      rentAccounts.push({
        address: key,
        space: size,
        minimumRentRaw: minimumRent.toString(),
        fundingRaw: change.toString(),
      });
    }
  }
  const debit = lamports(payerBefore) - lamports(payerAfter),
    feeAndRent = fee + rentFunding;
  if (
    feeAndRent > allowance ||
    debit !== feeAndRent + (native ? quoteCost : 0n) ||
    before.reduce((sum, account) => sum + lamports(account), 0n) -
      after.reduce((sum, account) => sum + lamports(account), 0n) !==
      fee
  )
    throw new Error(
      'Initial buy SOL debit, quote spending and fee/rent allowance do not reconcile.',
    );
  const stable = (await snapshot(keys)).accounts;
  for (let index = 0; index < keys.length; index++)
    if ((await hash(stable[index])) !== (await hash(before[index])))
      throw new Error('Initial buy source state changed during simulation.');
  if (distinctData.length) {
    const stableData = (await snapshot(distinctData, true)).accounts;
    for (let index = 0; index < distinctData.length; index++)
      if ((await hash(stableData[index])) !== (await hash(deployments[index])))
        throw new Error('Initial buy program changed during simulation.');
  }
  const validity = (await call(
    'isBlockhashValid',
    [
      creation.context.blockhash,
      { commitment: 'confirmed', minContextSlot: minimum() },
    ],
    deadline,
  )) as { context?: { slot?: unknown }; value?: unknown };
  observe(validity.context?.slot, minimum());
  if (
    validity.value !== true ||
    pumpUnsignedInteger(
      await call('getBlockHeight', [{ commitment: 'confirmed' }], deadline),
    ) +
      10n >
      creation.context.lastValidBlockHeight
  )
    throw new Error('Initial buy blockhash expired or is near expiry.');
  if (
    (await call('getGenesisHash', [], deadline)) !== SOLANA_MAINNET_GENESIS ||
    deadline.aborted
  )
    throw new Error('Initial buy network or cancellation state changed.');
  const observedAt = new Date().toISOString();
  const report = {
    preparation,
    context: creation.context,
    executionAllowed: false as const,
    signingAllowed: false as const,
    completeLaunch: false as const,
    simulation: {
      status: 'Simulated' as const,
      slot: simulationSlot,
      observedAt,
      expiresAt: new Date(
        Math.min(
          Date.parse(creation.simulation.expiresAt),
          Date.parse(observedAt) + 60000,
        ),
      ).toISOString(),
      creationPacketSha256: creation.preparation.packetSha256,
      creationSimulationSha256: await hash(creation.simulation),
      mintAuthority: creation.simulation.mintAuthority,
      metadataPointerAuthority: creation.simulation.metadataPointerAuthority,
      metadataUpdateAuthority: creation.simulation.metadataUpdateAuthority,
      networkFeeRaw: fee.toString(),
      feeAndRentLimitRaw,
      feeAndRentDebitRaw: feeAndRent.toString(),
      payerDebitRaw: debit.toString(),
      quoteCostRaw: quoteCost.toString(),
      maximumQuoteCostRaw,
      tokenAmountRaw,
      price,
      buybackFeeRaw: buybackFee.toString(),
      retainedProtocolFeeRaw: (protocolFee - buybackFee).toString(),
      creatorFeeUnclaimedRaw: creatorFee.toString(),
      buybackSplitRoundingAttested: false as const,
      unitsConsumed: units.toString(),
      rentAccounts,
      reads,
      minimumSlot: Math.min(...slots),
      maximumSlot: Math.max(...slots),
      programDeploymentMetadataOnly: true as const,
      authorityReviewRequired: true as const,
      blockhashMustBeRechecked: true as const,
      accountHashes: await Promise.all(
        keys.map(async (address, index) => ({
          address,
          beforeSha256: await hash(before[index]),
          simulatedSha256: await hash(after[index]),
        })),
      ),
      programDeploymentHashes: await Promise.all(
        distinctData.map(async (address, index) => ({
          address,
          sha256: await hash(deployments[index]),
        })),
      ),
    },
  };
  if (deadline.aborted)
    throw new Error('Initial buy preflight was cancelled or timed out.');
  return report;
}
