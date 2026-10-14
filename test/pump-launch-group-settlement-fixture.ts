import { buildPumpLaunchPacketGroup } from '../lib/pump-launch-packet-group';
import {
  generateKeyPairSigner,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import { type PumpHolderBuy } from '../lib/pump-holder-message';
import {
  verifyPumpLaunchGroupSettlement,
  type PumpHolderSettlementEvidence,
} from '../lib/pump-holder-settlement';
import {
  simulatePumpCreate,
  pumpAccountBytes,
  type PumpRpcAccount,
} from '../lib/pump-launch-simulation';
import {
  PUMP_LAUNCH_PROGRAM,
  PUMP_TOKEN_2022,
} from '../lib/pump-launch-config';
import {
  pumpInitialBuySimulationFixture,
  initialBuyVolumeFixture,
} from './pump-initial-buy-simulation-fixture';
import { raw, SYSTEM } from './pump-launch-simulation-fixture';

export async function pumpLaunchGroupSettlementFixture(
  stock = false,
  token22 = false,
  developer = true,
  quoteInput = true,
  upgradeable = false,
  count = 18,
) {
  const f = await pumpInitialBuySimulationFixture(stock, token22, upgradeable);
  const intent = {
    name: f.intent.name,
    symbol: f.intent.symbol,
    uri: f.intent.uri,
    payer: f.intent.payer,
    mint: f.intent.mint,
    quoteMint: f.intent.quoteMint,
  };
  const creation = await simulatePumpCreate(
    intent,
    '10000000',
    new AbortController().signal,
    f.rpc,
  );
  const create = { ...intent, ...creation.context };
  const holderSigners = await Promise.all(
    Array.from({ length: count }, () => generateKeyPairSigner()),
  );
  const holders: PumpHolderBuy[] = [
    {
      address: holderSigners[0].address,
      kind: 'exact-base-output',
      tokenAmountRaw: '2000000000000',
      maximumQuoteCostRaw: '100000000',
    },
    quoteInput
      ? {
          address: holderSigners[1].address,
          kind: 'exact-quote-input',
          quoteAmountRaw: '1000000',
          minimumTokenOutputRaw: '1000000',
        }
      : {
          address: holderSigners[1].address,
          kind: 'exact-base-output',
          tokenAmountRaw: '1000000000000',
          maximumQuoteCostRaw: '100000000',
        },
    { address: holderSigners[2].address, kind: 'none' },
  ];
  for (let i = 3; i < count; i++)
    holders.push(
      quoteInput && i % 2 === 1
        ? {
            address: holderSigners[i].address,
            kind: 'exact-quote-input',
            quoteAmountRaw: '1000000',
            minimumTokenOutputRaw: '1000000',
          }
        : {
            address: holderSigners[i].address,
            kind: 'exact-base-output',
            tokenAmountRaw: '1000000',
            maximumQuoteCostRaw: '100000000',
          },
    );
  const input = {
      create,
      holders,
      ...(developer
        ? {
            developer: {
              tokenAmountRaw: '1000000000000',
              maximumQuoteCostRaw: '100000000',
            },
          }
        : {}),
    },
    group = await buildPumpLaunchPacketGroup(input),
    packet = {
      quote: group.quote,
      instructions: group.packets.flatMap((p) => p.instructions),
      buyerAccounts: group.packets.flatMap((p) => p.buyerAccounts),
      packetSha256: group.manifestSha256,
    },
    keys = [
      ...new Set(
        group.packets.flatMap((p) =>
          getCompiledTransactionMessageDecoder()
            .decode(
              getTransactionDecoder().decode(
                Buffer.from(p.transaction, 'base64'),
              ).messageBytes,
            )
            .staticAccounts.map(String),
        ),
      ),
    ],
    networkFee = group.packets.reduce(
      (sum, p) => sum + BigInt(p.requiredSigners.length) * 5000n,
      0n,
    ),
    before = new Map(f.before),
    post = new Map<string, PumpRpcAccount>(before),
    curveKey = f.f.pdas.bondingCurve,
    curveBase = f.f.pdas.associatedCurve,
    curveQuote = String(packet.instructions.at(-1)!.accounts![7].address);
  const limits = {
    deployerFeeAndRentLimitRaw: '10000000',
    developerMaximumQuoteCostRaw: developer ? '100000000' : null,
    holders: holders.map((h) => ({
      address: h.address,
      feeAndRentLimitRaw: h.kind === 'none' ? '0' : '10000000',
      maximumQuoteCostRaw:
        h.kind === 'exact-base-output' ? h.maximumQuoteCostRaw : null,
      minimumTokenOutputRaw:
        h.kind === 'exact-quote-input' ? h.minimumTokenOutputRaw : null,
    })),
  };
  const trades: PumpHolderBuy[] = [
    ...(developer
      ? [
          {
            address: create.payer,
            kind: 'exact-base-output' as const,
            ...input.developer!,
          },
        ]
      : []),
    ...holders.filter((h) => h.kind !== 'none'),
  ];
  const rents = new Map([[create.payer, stock ? 4000000n : 3000000n]]),
    costs = new Map<string, bigint>();
  let vt = 1073000000000000n,
    vq = stock ? 100000000n : 30000000000n,
    real = 793100000000000n,
    principalTotal = 0n,
    creatorTotal = 0n,
    protocolTotal = 0n,
    outputTotal = 0n;
  const ceil = (value: bigint, bps: bigint) => (value * bps + 9999n) / 10000n;
  const capture = () => ({
    post: structuredClone(post),
    rents: new Map(rents),
    costs: new Map(costs),
    vt,
    vq,
    real,
    principalTotal,
    creatorTotal,
    protocolTotal,
    outputTotal,
  });
  const captures: ReturnType<typeof capture>[] = [capture()];
  for (const [i, trade] of trades.entries()) {
    const buyer = packet.buyerAccounts.find((b) => b.payer === trade.address)!;
    let principal: bigint, output: bigint;
    // Independent fixed fixture rates and arithmetic, not the production pricing projection.
    if (trade.kind === 'exact-base-output') {
      output = BigInt(trade.tokenAmountRaw);
      principal = (vq * output) / (vt - output) + 1n;
    } else if (trade.kind === 'exact-quote-input') {
      const budget = BigInt(trade.quoteAmountRaw);
      principal = (budget * 10000n) / 10125n;
      const excess =
        principal + ceil(principal, 95n) + ceil(principal, 30n) - budget;
      if (excess > 0n) principal -= excess;
      output = ((principal - 1n) * vt) / (vq + principal - 1n);
    } else throw new Error('Unexpected inactive fixture trade');
    const protocol = ceil(principal, 95n),
      creator = ceil(principal, 30n),
      cost = principal + protocol + creator;
    costs.set(trade.address, cost);
    rents.set(
      trade.address,
      (rents.get(trade.address) ?? 0n) +
        2000000n +
        (stock && i === 0 ? 1000000n : 0n),
    );
    if (trade.address !== create.payer)
      before.set(trade.address, raw(SYSTEM, new Uint8Array(), '1000000000'));
    post.set(
      buyer.userBaseAccount,
      raw(PUMP_TOKEN_2022, f.token(create.mint, trade.address, output, true)),
    );
    post.set(
      buyer.volumeAccount,
      raw(PUMP_LAUNCH_PROGRAM, initialBuyVolumeFixture(trade.address)),
    );
    if (stock) {
      before.set(
        buyer.userQuoteAccount,
        raw(
          packet.quote.tokenProgram,
          f.token(create.quoteMint, trade.address, 200000000n, token22),
        ),
      );
      post.set(
        buyer.userQuoteAccount,
        raw(
          packet.quote.tokenProgram,
          f.token(create.quoteMint, trade.address, 200000000n - cost, token22),
        ),
      );
    }
    vt -= output;
    vq += principal;
    real -= output;
    principalTotal += principal;
    creatorTotal += creator;
    protocolTotal += protocol;
    outputTotal += output;
    captures.push(capture());
  }
  const finish = (saved: ReturnType<typeof capture>, fee: bigint) => {
    const {
      rents,
      costs,
      vt,
      vq,
      real,
      principalTotal,
      creatorTotal,
      protocolTotal,
      outputTotal,
    } = saved;
    const post = new Map(before);
    for (const [key, value] of saved.post) post.set(key, value);
    const buyback = protocolTotal / 2n,
      recipient = packet.buyerAccounts[0];
    post.set(create.mint, raw(PUMP_TOKEN_2022, f.metadataMint()));
    const curveFields = {
      virtual_token_reserves: vt,
      virtual_quote_reserves: vq,
      real_token_reserves: real,
      real_quote_reserves: principalTotal,
      token_total_supply: 1000000000000000n,
      creator: create.payer,
      quote_mint: stock ? create.quoteMint : SYSTEM,
      initial_virtual_quote_reserves: stock ? 100000000n : 30000000000n,
      creator_fee: creatorTotal,
      protocol_fees: protocolTotal - buyback,
    };
    post.set(
      curveKey,
      raw(
        PUMP_LAUNCH_PROGRAM,
        f.f.config('BondingCurve', curveFields),
        (
          1000000n +
          (stock ? 0n : principalTotal + creatorTotal + protocolTotal - buyback)
        ).toString(),
      ),
    );
    post.set(
      curveBase,
      raw(
        PUMP_TOKEN_2022,
        f.token(create.mint, curveKey, 1000000000000000n - outputTotal, true),
      ),
    );
    if (stock) {
      post.set(
        curveQuote,
        raw(
          packet.quote.tokenProgram,
          f.token(
            create.quoteMint,
            curveKey,
            principalTotal + creatorTotal + protocolTotal - buyback,
            token22,
          ),
        ),
      );
      post.set(
        recipient.buybackAccount,
        raw(
          packet.quote.tokenProgram,
          f.token(
            create.quoteMint,
            recipient.buybackRecipient,
            buyback,
            token22,
          ),
        ),
      );
    } else
      post.set(
        recipient.buybackAccount,
        raw(SYSTEM, new Uint8Array(), (1000000n + buyback).toString()),
      );
    for (const [payer, rent] of rents)
      post.set(
        payer,
        raw(
          SYSTEM,
          new Uint8Array(),
          (
            1000000000n -
            rent -
            (payer === create.payer ? fee : 0n) -
            (stock ? 0n : (costs.get(payer) ?? 0n))
          ).toString(),
        ),
      );

    return post;
  };
  const finalPost = finish(captures.at(-1)!, networkFee);
  const evidence: PumpHolderSettlementEvidence = {
    addresses: keys,
    before: structuredClone(keys.map((k) => before.get(k) ?? null)),
    after: structuredClone(keys.map((k) => finalPost.get(k) ?? null)),
    networkFeeRaw: networkFee.toString(),
    minimumRentBySize: Object.fromEntries(
      [...finalPost.values()]
        .filter((a) => a && pumpAccountBytes(a).length)
        .map((a) => [pumpAccountBytes(a!).length, '1000000']),
    ),
    creationAccountHashes: creation.simulation.accountHashes,
  };
  const change = (
    key: string,
    mutate: (a: NonNullable<PumpRpcAccount>) => void,
  ) => mutate(evidence.after[keys.indexOf(key)] as NonNullable<PumpRpcAccount>);
  const run = () => verifyPumpLaunchGroupSettlement(input, limits, evidence);
  let tradeCount = 0,
    fees = 0n;
  let previous = before;
  const transactionResults = group.packets.map((p) => {
    tradeCount += p.buyerAccounts.length;
    const fee = BigInt(p.requiredSigners.length) * 5000n;
    fees += fee;
    const next = finish(captures[tradeCount], fees),
      addresses = getCompiledTransactionMessageDecoder()
        .decode(
          getTransactionDecoder().decode(Buffer.from(p.transaction, 'base64'))
            .messageBytes,
        )
        .staticAccounts.map(String);
    const result = {
      err: null,
      replacementBlockhash: null,
      fee: fee.toString(),
      unitsConsumed: '100000',
      loadedAccountsDataSize: '4096',
      preExecutionAccounts: structuredClone(
        addresses.map((k) => previous.get(k) ?? null),
      ),
      postExecutionAccounts: structuredClone(
        addresses.map((k) => next.get(k) ?? null),
      ),
    };
    previous = next;
    return result;
  });
  const response = {
    context: { slot: '100' },
    value: { summary: 'succeeded', transactionResults },
  };
  return {
    f,
    holderSigners,
    creation,
    input,
    limits,
    packet,
    group,
    response,
    before,
    evidence,
    curveKey,
    curveBase,
    change,
    run,
  };
}
