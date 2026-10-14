import { expect, it } from 'vitest';
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit-v1';
import { pumpLaunchGroupSettlementFixture as fixture } from '../test/pump-launch-group-settlement-fixture';
import { verifyPumpLaunchGroupAccounting } from './pump-launch-group-accounting';
import { verifyPumpLaunchGroupTrace } from './pump-launch-group-trace';
import { collectPumpLaunchGroupFunding } from './pump-holder-funding';
import {
  pumpUnsignedInteger,
  type PumpLaunchRpc,
} from './pump-launch-simulation';
import { SOLANA_MAINNET_GENESIS } from './wallet-balances';
async function setup(
  stock = false,
  token22 = false,
  developer = true,
  quoteInput = true,
) {
  const f = await fixture(stock, token22, developer, quoteInput);
  const rpc: PumpLaunchRpc = async (method, params) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getFeeForMessage')
      return {
        context: { slot: '100' },
        value: (
          BigInt(
            getCompiledTransactionMessageDecoder().decode(
              Buffer.from(params[0] as string, 'base64'),
            ).header.numSignerAccounts,
          ) * 5000n
        ).toString(),
      };
    if (method === 'getMultipleAccounts')
      return {
        context: { slot: '100' },
        value: (params[0] as string[]).map((k) =>
          structuredClone(f.before.get(k) ?? null),
        ),
      };
    if (method === 'getBlockHeight') return '900';
    if (method === 'isBlockhashValid')
      return { context: { slot: '100' }, value: true };
    throw new Error('Unexpected read');
  };
  const funding = await collectPumpLaunchGroupFunding(
    f.input,
    f.limits,
    {
      minimumSlot: 100,
      maximumSlot: 100,
      accountHashes: f.evidence.creationAccountHashes,
    },
    new AbortController().signal,
    rpc,
  );
  const evidence = {
    funding,
    response: f.response,
    minimumRentBySize: f.evidence.minimumRentBySize,
    creationAccountHashes: f.evidence.creationAccountHashes,
  };
  const run = () =>
    verifyPumpLaunchGroupAccounting(f.input, f.limits, evidence);
  return { ...f, evidence, run };
}
for (const [stock, token22, developer, quoteInput] of [
  [false, false, true, true],
  [true, false, true, true],
  [true, true, true, true],
  [false, false, false, true],
  [true, false, false, false],
])
  it(`reconciles a complete multi-packet group independently (${stock},${token22},${developer},${quoteInput})`, async () => {
    const f = await setup(stock, token22, developer, quoteInput),
      result = await f.run();
    expect(f.group.packets.length).toBeGreaterThan(1);
    expect(result).toMatchObject({
      manifestSha256: f.group.manifestSha256,
      accountingValidated: true,
      sequentialTraceValidated: true,
      perPacketConservationValidated: true,
      cumulativeCapsValidated: true,
      economicPrefixesValidated: true,
      fullGroupAccountingValidated: true,
      rpcCollectionRequired: true,
      programDeploymentReviewRequired: true,
      signingAllowed: false,
      executionAllowed: false,
      completeLaunch: false,
    });
    expect(result.wallets).toHaveLength(developer ? 18 : 17);
    expect(pumpUnsignedInteger(result.totalTokenOutputRaw)).toBeGreaterThan(0n);
  }, 15000);
const lastKeys = (f: Awaited<ReturnType<typeof setup>>) =>
  getCompiledTransactionMessageDecoder()
    .decode(
      getTransactionDecoder().decode(
        Buffer.from(f.group.packets.at(-1)!.transaction, 'base64'),
      ).messageBytes,
    )
    .staticAccounts.map(String);
it('rejects a claimed success whose final holder received no tokens', async () => {
  const f = await setup(),
    frame = f.response.value.transactionResults.at(-1)!,
    holder = f.group.packets.at(-1)!.buyerAccounts.at(-1)!;
  const account =
    frame.postExecutionAccounts[lastKeys(f).indexOf(holder.userBaseAccount)]!;
  const data = Buffer.from(account.data[0], 'base64');
  data.writeBigUInt64LE(0n, 64);
  account.data[0] = data.toString('base64');
  await expect(f.run()).rejects.toThrow();
});
it('rejects an invalid intermediate curve even when the final state is repaired', async () => {
  const f = await setup();
  const keys = (index: number) =>
    getCompiledTransactionMessageDecoder()
      .decode(
        getTransactionDecoder().decode(
          Buffer.from(f.group.packets[index].transaction, 'base64'),
        ).messageBytes,
      )
      .staticAccounts.map(String);
  const first = f.response.value.transactionResults[0];
  const second = f.response.value.transactionResults[1];
  const changed = structuredClone(
    first.postExecutionAccounts[keys(0).indexOf(f.curveKey)]!,
  );
  const bytes = Buffer.from(changed.data[0], 'base64');
  bytes[8] ^= 1;
  changed.data[0] = bytes.toString('base64');
  first.postExecutionAccounts[keys(0).indexOf(f.curveKey)] = changed;
  second.preExecutionAccounts[keys(1).indexOf(f.curveKey)] =
    structuredClone(changed);
  await expect(
    verifyPumpLaunchGroupTrace(
      f.input,
      f.limits,
      f.evidence.funding,
      f.response,
    ),
  ).resolves.toBeDefined();
  await expect(f.run()).rejects.toThrow('reserves, fees or migration');
}, 15000);
it('rejects missing network fees and per-packet SOL creation', async () => {
  const f = await setup();
  f.response.value.transactionResults.at(-1)!.fee = '1';
  await expect(f.run()).rejects.toThrow('fee or resources');
  const g = await setup(),
    frame = g.response.value.transactionResults.at(-1)!;
  const payer =
    frame.postExecutionAccounts[lastKeys(g).indexOf(g.input.create.payer)]!;
  payer.lamports = (BigInt(payer.lamports) + 1n).toString();
  await expect(g.run()).rejects.toThrow('packet SOL conservation');
});
it('rejects excess spending hidden by a later refund with unchanged final balances', async () => {
  const f = await setup();
  const keys = (index: number) =>
    getCompiledTransactionMessageDecoder()
      .decode(
        getTransactionDecoder().decode(
          Buffer.from(f.group.packets[index].transaction, 'base64'),
        ).messageBytes,
      )
      .staticAccounts.map(String);
  for (const [address, delta] of [
    [f.input.create.payer, -200000000n],
    [f.curveKey, 200000000n],
  ] as const) {
    const changed = structuredClone(
      f.response.value.transactionResults[0].postExecutionAccounts[
        keys(0).indexOf(address)
      ]!,
    );
    changed.lamports = (BigInt(changed.lamports) + delta).toString();
    f.response.value.transactionResults[0].postExecutionAccounts[
      keys(0).indexOf(address)
    ] = changed;
    f.response.value.transactionResults[1].preExecutionAccounts[
      keys(1).indexOf(address)
    ] = structuredClone(changed);
  }
  await expect(
    verifyPumpLaunchGroupTrace(
      f.input,
      f.limits,
      f.evidence.funding,
      f.response,
    ),
  ).resolves.toBeDefined();
  await expect(f.run()).rejects.toThrow('cumulative SOL debit');
}, 15000);
