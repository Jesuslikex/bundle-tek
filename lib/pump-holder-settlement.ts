import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import {
  buildPumpCreateHolderMessage,
  type PumpHolderBuy,
} from './pump-holder-message';
import type { PumpHolderAllowances } from './pump-holder-funding';
import {
  pumpAccountBytes,
  pumpRpcAccount,
  pumpSystemAccount,
  pumpUnsignedInteger,
  verifyPumpTokenCustody,
  type PumpRpcAccount,
} from './pump-launch-simulation';
import {
  decodePumpLaunchConfig,
  PUMP_LAUNCH_PROGRAM,
  PUMP_NATIVE_QUOTE,
  PUMP_TOKEN_2022,
} from './pump-launch-config';
import {
  decodePumpInitialBuyState,
  pumpBuyFeeRates,
  pumpInitialBuyPrice,
} from './pump-initial-buy-state';
import { pumpExactQuoteTarget } from './pump-holder-pricing';

type Input = Parameters<typeof buildPumpCreateHolderMessage>[0];
export type PumpHolderSettlementEvidence = {
  /** Exact compiled account order; these are account objects, not client-provided balances. */
  addresses: string[];
  before: unknown[];
  after: unknown[];
  networkFeeRaw: string;
  minimumRentBySize: Record<string, string>;
  creationAccountHashes: {
    address: string;
    beforeSha256: string;
    simulatedSha256: string;
  }[];
};
const SYSTEM = '11111111111111111111111111111111';
const hash = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
const sol = (account: PumpRpcAccount) =>
  account ? pumpUnsignedInteger(account.lamports) : 0n;
const amount = (account: PumpRpcAccount) => {
  if (!account || pumpAccountBytes(account).length < 165)
    throw new Error('Holder token custody is unavailable.');
  return new DataView(pumpAccountBytes(account).buffer).getBigUint64(64, true);
};
const sameTokenExceptAmount = (
  before: PumpRpcAccount,
  after: PumpRpcAccount,
) => {
  if (
    !before ||
    !after ||
    before.owner !== after.owner ||
    before.executable !== after.executable ||
    before.lamports !== after.lamports
  )
    throw new Error('Holder quote custody state changed.');
  const a = pumpAccountBytes(before),
    b = pumpAccountBytes(after);
  a.fill(0, 64, 72);
  b.fill(0, 64, 72);
  if (a.length !== b.length || a.some((byte, i) => byte !== b[i]))
    throw new Error('Holder quote custody authority or extension changed.');
};
const feeFor = (principal: bigint, bps: bigint) =>
  (principal * bps + 9999n) / 10000n;

/** Pure accounting verifier. RPC origin, freshness, resources and deployment checks are separate mandatory gates. */
export async function verifyPumpHolderSettlement(
  supplied: Input,
  suppliedLimits: PumpHolderAllowances,
  suppliedEvidence: PumpHolderSettlementEvidence,
) {
  const input = structuredClone(supplied),
    limits = structuredClone(suppliedLimits),
    evidence = structuredClone(suppliedEvidence),
    packet = await buildPumpCreateHolderMessage(input),
    tx = getTransactionDecoder().decode(
      Buffer.from(packet.transaction, 'base64'),
    ),
    message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes),
    keys = message.staticAccounts.map(String);
  if (
    JSON.stringify(keys) !== JSON.stringify(evidence.addresses) ||
    evidence.before.length !== keys.length ||
    evidence.after.length !== keys.length
  )
    throw new Error('Complete holder settlement account mapping differs.');
  if (
    limits.holders.length !== input.holders.length ||
    limits.developerMaximumQuoteCostRaw !==
      (input.developer?.maximumQuoteCostRaw ?? null)
  )
    throw new Error('Holder settlement allowance scope differs.');
  const deployerAllowance = pumpUnsignedInteger(
    limits.deployerFeeAndRentLimitRaw,
  );
  if (!deployerAllowance || deployerAllowance > 1000000000n)
    throw new Error('Holder deployer fee/rent allowance differs.');
  for (const [i, holder] of input.holders.entries()) {
    const limit = limits.holders[i];
    if (
      limit.address !== holder.address ||
      limit.maximumQuoteCostRaw !==
        (holder.kind === 'exact-base-output'
          ? holder.maximumQuoteCostRaw
          : null) ||
      limit.minimumTokenOutputRaw !==
        (holder.kind === 'exact-quote-input'
          ? holder.minimumTokenOutputRaw
          : null) ||
      (holder.kind === 'none'
        ? limit.feeAndRentLimitRaw !== '0'
        : pumpUnsignedInteger(limit.feeAndRentLimitRaw) === 0n ||
          pumpUnsignedInteger(limit.feeAndRentLimitRaw) > 1000000000n)
    )
      throw new Error('Holder settlement limits differ from the saved slots.');
  }
  const before = evidence.before.map(pumpRpcAccount),
    after = evidence.after.map(pumpRpcAccount),
    at = (key: string, values = after) => {
      const i = keys.indexOf(key);
      if (i < 0) throw new Error('Holder settlement account is missing.');
      return values[i];
    },
    native = input.create.quoteMint === PUMP_NATIVE_QUOTE,
    fee = pumpUnsignedInteger(evidence.networkFeeRaw);
  if (!fee || at(input.create.mint, before))
    throw new Error('Holder creation or network fee differs.');
  for (const [i] of keys.entries()) {
    const writable =
      i <
        message.header.numSignerAccounts -
          message.header.numReadonlySignerAccounts ||
      (i >= message.header.numSignerAccounts &&
        i < keys.length - message.header.numReadonlyNonSignerAccounts);
    if (
      (!writable || before[i]?.executable) &&
      (await hash(before[i])) !== (await hash(after[i]))
    )
      throw new Error(
        'Holder settlement changed a readonly or executable account.',
      );
  }
  const creationHashes = new Map(
    evidence.creationAccountHashes.map((item) => [item.address, item]),
  );
  for (const config of [
    input.create.global,
    input.create.quoteControl,
    input.create.quoteMintAccount,
  ]) {
    if (!config) continue;
    const source = at(config.address, before);
    if (
      !source ||
      source.owner !== config.owner ||
      source.executable !== config.executable ||
      Buffer.from(pumpAccountBytes(source)).toString('base64') !==
        Buffer.from(config.data).toString('base64')
    )
      throw new Error(
        'Holder packet configuration differs from its observed source.',
      );
  }
  for (const key of [
    input.create.mint,
    input.create.payer,
    input.create.global.address,
  ])
    if (!creationHashes.has(key))
      throw new Error('Holder settlement creation evidence is incomplete.');
  for (const item of creationHashes.values()) {
    if (item.address === 'ComputeBudget111111111111111111111111111111')
      continue;
    if ((await hash(at(item.address, before))) !== item.beforeSha256)
      throw new Error(
        'Holder settlement source differs from creation simulation.',
      );
  }
  if (
    (await hash(at(input.create.mint))) !==
    creationHashes.get(input.create.mint)!.simulatedSha256
  )
    throw new Error('Holder buys changed mint metadata, supply or authority.');
  const first = packet.instructions.find(
    (i) => i.programAddress === PUMP_LAUNCH_PROGRAM && i.data?.length === 25,
  )!;
  const curveKey = String(first.accounts![5].address),
    curveBase = String(first.accounts![6].address),
    curveQuote = String(first.accounts![7].address),
    feeKey = String(first.accounts![12].address),
    feeAccount = at(feeKey, before);
  if (
    !feeAccount ||
    feeAccount.executable ||
    feeAccount.owner !== 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'
  )
    throw new Error('Holder fee configuration owner differs.');
  const feeConfig = decodePumpInitialBuyState(
      'FeeConfig',
      pumpAccountBytes(feeAccount),
    ),
    global = decodePumpLaunchConfig('Global', input.create.global.data),
    curveAccount = at(curveKey);
  if (
    !curveAccount ||
    curveAccount.executable ||
    curveAccount.owner !== PUMP_LAUNCH_PROGRAM ||
    at(curveKey, before)
  )
    throw new Error('Holder curve identity differs.');
  const curve = decodePumpLaunchConfig(
      'BondingCurve',
      pumpAccountBytes(curveAccount),
    ),
    buybackKeys = new Map(
      packet.buyerAccounts.map((b) => [b.buybackAccount, b.buybackRecipient]),
    );
  let buyback = 0n;
  const quoteCredits = new Map<string, bigint>();
  for (const [key, owner] of buybackKeys) {
    const pre = at(key, before),
      post = at(key);
    if (native) {
      if (!pumpSystemAccount(pre) || !pumpSystemAccount(post))
        throw new Error('Holder buyback SOL authority differs.');
    } else {
      verifyPumpTokenCustody(post, {
        program: packet.quote.tokenProgram,
        mint: input.create.quoteMint,
        owner,
        amount: amount(post),
      });
      if (pre) {
        verifyPumpTokenCustody(pre, {
          program: packet.quote.tokenProgram,
          mint: input.create.quoteMint,
          owner,
          amount: amount(pre),
        });
        sameTokenExceptAmount(pre, post);
      }
    }
    const credit = native
      ? sol(post) - sol(pre)
      : amount(post) - (pre ? amount(pre) : 0n);
    if (credit < 0n) throw new Error('Holder buyback custody lost funds.');
    buyback += credit;
    if (native) quoteCredits.set(key, credit);
  }
  const bigintField = (name: string) => {
    const value = curve[name];
    if (typeof value !== 'bigint' || value < 0n)
      throw new Error('Holder curve field differs.');
    return value;
  };
  const observedPrincipal = bigintField('real_quote_reserves'),
    observedCreator = bigintField('creator_fee'),
    retainedProtocol = bigintField('protocol_fees');
  if (native)
    quoteCredits.set(
      curveKey,
      observedPrincipal + observedCreator + retainedProtocol,
    );
  // Each setup is charged to its pinned instruction payer. Shared buyback ATA rent is paid by the first buyer.
  const rentPayers = new Map<string, string>([
    [input.create.mint, input.create.payer],
    [curveKey, input.create.payer],
    [curveBase, input.create.payer],
    ...(!native ? [[curveQuote, input.create.payer] as [string, string]] : []),
  ]);
  for (const buyer of packet.buyerAccounts) {
    rentPayers.set(buyer.userBaseAccount, buyer.payer);
    rentPayers.set(buyer.volumeAccount, buyer.payer);
    if (!native && !rentPayers.has(buyer.buybackAccount))
      rentPayers.set(buyer.buybackAccount, buyer.payer);
  }
  const walletKeys = new Set([
      input.create.payer,
      ...packet.buyerAccounts.map((b) => b.payer),
    ]),
    rentByPayer = new Map<string, bigint>(),
    rentAccounts = [];
  for (const [i, key] of keys.entries()) {
    if (walletKeys.has(key)) continue;
    const pre = before[i],
      post = after[i],
      change = sol(post) - sol(pre) - (quoteCredits.get(key) ?? 0n),
      payer = rentPayers.get(key);
    if (change < 0n || (!payer && change !== 0n))
      throw new Error('Holder settlement has unexplained SOL movements.');
    if (payer) {
      if (!post || post.executable || !pumpAccountBytes(post).length)
        throw new Error('Holder rent account differs.');
      const size = pumpAccountBytes(post).length,
        minimum = pumpUnsignedInteger(evidence.minimumRentBySize[String(size)]);
      if (!minimum || sol(post) - (quoteCredits.get(key) ?? 0n) < minimum)
        throw new Error('Holder rent exemption differs.');
      rentByPayer.set(payer, (rentByPayer.get(payer) ?? 0n) + change);
      rentAccounts.push({
        address: key,
        payer,
        space: size,
        minimumRentRaw: minimum.toString(),
        fundingRaw: change.toString(),
      });
    }
  }
  const trades: PumpHolderBuy[] = [
    ...(input.developer
      ? [
          {
            address: input.create.payer,
            kind: 'exact-base-output' as const,
            ...input.developer,
          },
        ]
      : []),
    ...input.holders,
  ];
  const buyers = new Map<string, (typeof packet.buyerAccounts)[number]>(
    packet.buyerAccounts.map((b) => [b.payer, b]),
  );
  let vt = BigInt(packet.quote.initialVirtualTokenReservesRaw),
    vq = BigInt(packet.quote.initialVirtualQuoteReservesRaw),
    real = global.initial_real_token_reserves as bigint,
    totalTokens = 0n,
    totalPrincipal = 0n,
    totalProtocol = 0n,
    totalCreator = 0n,
    totalQuote = 0n;
  const rows = [];
  for (const trade of trades) {
    if (trade.kind === 'none') continue;
    const buyer = buyers.get(trade.address)!;
    const preWallet = at(trade.address, before),
      postWallet = at(trade.address);
    if (
      !pumpSystemAccount(preWallet) ||
      !pumpSystemAccount(postWallet) ||
      at(buyer.userBaseAccount, before)
    )
      throw new Error('Holder wallet or destination authority differs.');
    const output = amount(at(buyer.userBaseAccount));
    verifyPumpTokenCustody(at(buyer.userBaseAccount), {
      program: PUMP_TOKEN_2022,
      mint: input.create.mint,
      owner: trade.address,
      amount: output,
    });
    const rent = rentByPayer.get(trade.address) ?? 0n,
      network = trade.address === input.create.payer ? fee : 0n,
      feeRent = rent + network,
      debit = sol(preWallet) - sol(postWallet),
      limit =
        trade.address === input.create.payer
          ? limits.deployerFeeAndRentLimitRaw
          : limits.holders.find((l) => l.address === trade.address)!
              .feeAndRentLimitRaw;
    if (
      feeRent > pumpUnsignedInteger(limit) ||
      pumpUnsignedInteger(limit) > 1000000000n
    )
      throw new Error('Holder fee/rent debit exceeds its reviewed allowance.');
    let spending = debit - feeRent;
    if (!native) {
      const sourceBefore = at(buyer.userQuoteAccount, before),
        sourceAfter = at(buyer.userQuoteAccount);
      spending = amount(sourceBefore) - amount(sourceAfter);
      for (const source of [sourceBefore, sourceAfter])
        verifyPumpTokenCustody(source, {
          program: packet.quote.tokenProgram,
          mint: input.create.quoteMint,
          owner: trade.address,
          amount: amount(source),
        });
      sameTokenExceptAmount(sourceBefore, sourceAfter);
      if (debit !== feeRent)
        throw new Error(
          'Stock holder SOL debit differs from its fee/rent funding.',
        );
    } else if (
      (await hash(at(buyer.userQuoteAccount, before))) !==
      (await hash(at(buyer.userQuoteAccount)))
    )
      throw new Error('Holder buy changed unused wrapped SOL custody.');
    const cap = pumpUnsignedInteger(
      trade.kind === 'exact-base-output'
        ? trade.maximumQuoteCostRaw
        : trade.quoteAmountRaw,
    );
    if (spending <= 0n || spending > cap)
      throw new Error('Holder observed quote debit exceeds its reviewed cap.');
    const rates = pumpBuyFeeRates({
      quoteMint: input.create.quoteMint,
      virtualTokensRaw: vt.toString(),
      virtualQuoteRaw: vq.toString(),
      feeConfig,
    });
    let principal: bigint, protocol: bigint, creator: bigint;
    if (trade.kind === 'exact-base-output') {
      const price = pumpInitialBuyPrice({
        quoteMint: input.create.quoteMint,
        virtualTokensRaw: vt.toString(),
        virtualQuoteRaw: vq.toString(),
        tokenAmountRaw: trade.tokenAmountRaw,
        feeConfig,
      });
      principal = BigInt(price.principalRaw);
      protocol = BigInt(price.protocolFeeRaw);
      creator = BigInt(price.creatorFeeRaw);
      if (
        output !== BigInt(trade.tokenAmountRaw) ||
        spending !== BigInt(price.totalQuoteCostRaw)
      )
        throw new Error(
          'Holder exact-output settlement differs from sequential pricing.',
        );
    } else {
      // Recover actual principal from the observed debit and independently rounded fees, not the SDK's projected reserve update.
      let lo = 1n,
        hi = spending;
      while (lo < hi) {
        const middle = (lo + hi) / 2n;
        if (
          middle +
            feeFor(middle, rates.protocolFeeBps) +
            feeFor(middle, rates.creatorFeeBps) <
          spending
        )
          lo = middle + 1n;
        else hi = middle;
      }
      principal = lo;
      protocol = feeFor(lo, rates.protocolFeeBps);
      creator = feeFor(lo, rates.creatorFeeBps);
      const expected = pumpExactQuoteTarget({
        quoteMint: input.create.quoteMint,
        feeConfig,
        curve: {
          virtualTokensRaw: vt.toString(),
          virtualQuoteRaw: vq.toString(),
          realTokensRaw: real.toString(),
        },
        quoteAmountRaw: trade.quoteAmountRaw,
        minimumTokenOutputRaw: trade.minimumTokenOutputRaw,
      });
      if (
        principal <= 1n ||
        principal + protocol + creator !== spending ||
        output !== BigInt(expected.tokenAmountRaw) ||
        output !== ((principal - 1n) * vt) / (vq + principal - 1n)
      )
        throw new Error(
          'Holder quote-input observed principal, rounded fees or output differs.',
        );
    }
    if (!output || output >= real || output >= vt)
      throw new Error(
        'Holder buy exhausts the curve; migration is not covered.',
      );
    vt -= output;
    real -= output;
    vq += principal;
    totalTokens += output;
    totalPrincipal += principal;
    totalProtocol += protocol;
    totalCreator += creator;
    totalQuote += spending;
    const volume = (a: PumpRpcAccount) => {
      if (!a || a.executable || a.owner !== PUMP_LAUNCH_PROGRAM)
        throw new Error('Holder volume account owner differs.');
      const value = decodePumpInitialBuyState(
        'UserVolumeAccumulator',
        pumpAccountBytes(a),
      );
      if (value.user !== trade.address)
        throw new Error('Holder volume user differs.');
      return value;
    };
    const volumeBefore = at(buyer.volumeAccount, before),
      previous = volumeBefore ? volume(volumeBefore) : null,
      current = volume(at(buyer.volumeAccount));
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
        current[key] !==
        (previous?.[key] ?? (typeof current[key] === 'boolean' ? false : 0n))
      )
        throw new Error('Holder buy changed unrelated rewards or claims.');
    const volumeGain =
        (current.current_sol_volume as bigint) -
        ((previous?.current_sol_volume as bigint) ?? 0n),
      timestamp = current.last_update_timestamp as bigint;
    if (
      volumeGain < 0n ||
      volumeGain > spending ||
      timestamp < 0n ||
      timestamp < ((previous?.last_update_timestamp as bigint) ?? 0n) ||
      timestamp > BigInt(Math.floor(Date.now() / 1000) + 60)
    )
      throw new Error('Holder volume accounting differs.');
    rows.push({
      address: trade.address,
      kind: trade.kind,
      tokenAmountRaw: output.toString(),
      quoteDebitRaw: spending.toString(),
      principalRaw: principal.toString(),
      protocolFeeRaw: protocol.toString(),
      creatorFeeRaw: creator.toString(),
      solDebitRaw: debit.toString(),
      feeAndRentDebitRaw: feeRent.toString(),
    });
  }
  if (!input.developer) {
    const debit =
        sol(at(input.create.payer, before)) - sol(at(input.create.payer)),
      expected = fee + (rentByPayer.get(input.create.payer) ?? 0n);
    if (
      !pumpSystemAccount(at(input.create.payer, before)) ||
      !pumpSystemAccount(at(input.create.payer)) ||
      debit !== expected ||
      expected > pumpUnsignedInteger(limits.deployerFeeAndRentLimitRaw)
    )
      throw new Error(
        'Creation-only deployer debit differs from its holder packet allowance.',
      );
  }
  const supply = BigInt(packet.quote.tokenSupplyRaw),
    initialQuote = BigInt(packet.quote.initialVirtualQuoteReservesRaw),
    buybackBps = global.buyback_basis_points;
  if (
    curve.virtual_token_reserves !== vt ||
    curve.real_token_reserves !== real ||
    curve.virtual_quote_reserves !== vq ||
    observedPrincipal !== totalPrincipal ||
    observedCreator !== totalCreator ||
    retainedProtocol + buyback !== totalProtocol ||
    curve.token_total_supply !== supply ||
    curve.creator !== input.create.payer ||
    curve.complete !== false ||
    curve.is_mayhem_mode !== false ||
    curve.is_cashback_coin !== false ||
    curve.is_holder_reward !== false ||
    curve.creator_fee_bps !== 0n ||
    curve.can_edit_creator_fee !== false ||
    curve.depth !== 0 ||
    curve.quote_mint !== (native ? SYSTEM : input.create.quoteMint) ||
    curve.initial_virtual_quote_reserves !== initialQuote ||
    curve.post_complete_base_out !== 0n ||
    curve.post_complete_quote_in !== 0n ||
    typeof buybackBps !== 'bigint' ||
    buybackBps > 10000n ||
    (buybackBps === 0n && buyback !== 0n) ||
    (buybackBps === 10000n && buyback !== totalProtocol)
  )
    throw new Error(
      'Holder curve reserves, fees or migration state do not reconcile.',
    );
  verifyPumpTokenCustody(at(curveBase), {
    program: PUMP_TOKEN_2022,
    mint: input.create.mint,
    owner: curveKey,
    amount: supply - totalTokens,
  });
  if (native) {
    if ((await hash(at(curveQuote, before))) !== (await hash(at(curveQuote))))
      throw new Error('Holder curve changed unused wrapped SOL custody.');
  } else
    verifyPumpTokenCustody(at(curveQuote), {
      program: packet.quote.tokenProgram,
      mint: input.create.quoteMint,
      owner: curveKey,
      amount: totalPrincipal + totalCreator + retainedProtocol,
    });
  if (
    before.reduce((sum, a) => sum + sol(a), 0n) -
      after.reduce((sum, a) => sum + sol(a), 0n) !==
    fee
  )
    throw new Error(
      'Complete holder packet SOL conservation differs from its network fee.',
    );
  const mutable = new Set([
    input.create.payer,
    curveKey,
    curveBase,
    ...rentPayers.keys(),
    ...packet.buyerAccounts.flatMap((b) => [
      b.payer,
      b.userBaseAccount,
      b.volumeAccount,
      b.buybackAccount,
      ...(!native ? [b.userQuoteAccount] : []),
    ]),
  ]);
  for (const [i, key] of keys.entries()) {
    if (
      !mutable.has(key) &&
      (await hash(after[i])) !==
        (creationHashes.get(key)?.simulatedSha256 ?? (await hash(before[i])))
    )
      throw new Error(
        'Holder packet changed unrelated creation or account state.',
      );
  }
  return {
    format: 'pump-holder-settlement-accounting-v1' as const,
    packetSha256: packet.packetSha256,
    accountingValidated: true as const,
    rpcCollectionRequired: true as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
    completeLaunch: false as const,
    totalTokenOutputRaw: totalTokens.toString(),
    totalQuoteDebitRaw: totalQuote.toString(),
    principalRaw: totalPrincipal.toString(),
    protocolFeeRaw: totalProtocol.toString(),
    creatorFeeRaw: totalCreator.toString(),
    buybackFeeRaw: buyback.toString(),
    buybackSplitRoundingAttested: false as const,
    rentAccounts,
    wallets: rows,
  };
}
