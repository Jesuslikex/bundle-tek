import { expect, it, vi } from 'vitest';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import { pumpLaunchGroupFundingFixture } from '../test/pump-launch-group-funding-fixture';
import { raw, SYSTEM } from '../test/pump-launch-simulation-fixture';
import { PUMP_TOKEN_2022 } from './pump-launch-config';
import {
  collectPumpLaunchGroupTrace,
  verifyPumpLaunchGroupTrace,
} from './pump-launch-group-trace';
import type { PumpRpcAccount, PumpLaunchRpc } from './pump-launch-simulation';

/** Controlled continuity trace only. No BPF execution, rent or trade accounting attestation. */
async function fixture(stock = false, token22 = false, count = 18) {
  const f = await pumpLaunchGroupFundingFixture(stock, token22, count),
    funding = await f.run();
  const state = new Map<string, PumpRpcAccount>(
    structuredClone([...f.accounts]),
  );
  const results = f.group.packets.map((packet, index) => {
    const keys = getCompiledTransactionMessageDecoder()
      .decode(
        getTransactionDecoder().decode(
          Buffer.from(packet.transaction, 'base64'),
        ).messageBytes,
      )
      .staticAccounts.map(String);
    const pre = structuredClone(keys.map((key) => state.get(key) ?? null));
    const payer = structuredClone(state.get(f.input.create.payer))!;
    payer.lamports = (
      BigInt(payer.lamports) -
      BigInt(funding.packetFees[index].networkFeeRaw) -
      (index === 0 ? 1000000n : 0n)
    ).toString();
    state.set(f.input.create.payer, payer);
    if (index === 0) {
      const data = new Uint8Array(82);
      data[44] = 6;
      data[45] = 1;
      state.set(f.input.create.mint, raw(PUMP_TOKEN_2022, data, '1000000'));
    }
    return {
      err: null,
      fee: funding.packetFees[index].networkFeeRaw,
      unitsConsumed: '100000',
      loadedAccountsDataSize: '4096',
      replacementBlockhash: null,
      loadedAddresses: { readonly: [] as string[], writable: [] as string[] },
      preExecutionAccounts: pre,
      postExecutionAccounts: structuredClone(
        keys.map((key) => state.get(key) ?? null),
      ),
    };
  });
  const response = {
      context: { slot: '100' },
      value: { summary: 'succeeded', transactionResults: results },
    },
    calls: { method: string; params: unknown[] }[] = [];
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    calls.push({ method, params });
    if (method === 'simulateBundle') return structuredClone(response);
    return f.rpc(method, params, signal);
  };
  const run = (
    provider: PumpLaunchRpc = rpc,
    signal = new AbortController().signal,
  ) =>
    collectPumpLaunchGroupTrace(
      f.input,
      f.limits,
      funding,
      new Date(Date.now() + 59000).toISOString(),
      signal,
      provider,
    );
  const verify = () =>
    verifyPumpLaunchGroupTrace(f.input, f.limits, funding, response);
  return { ...f, funding, response, calls, rpc, run, verify };
}
for (const [stock, token22] of [
  [false, false],
  [true, false],
  [true, true],
])
  it(`collects one bank-bound ordered replay with preserved bytes and no execution authority (${stock},${token22})`, async () => {
    const f = await fixture(stock, token22),
      result = await f.run();
    expect(result).toMatchObject({
      manifestSha256: f.group.manifestSha256,
      sequentialTraceValidated: true,
      rpcCollectionRequired: false,
      settlementValidated: false,
      economicVerificationRequired: true,
      programDeploymentReviewRequired: true,
      signingAllowed: false,
      executionAllowed: false,
      completeLaunch: false,
      bankSlot: 100,
    });
    const sim = f.calls.filter((c) => c.method === 'simulateBundle');
    expect(sim).toHaveLength(1);
    expect(sim[0].params[0]).toEqual({
      encodedTransactions: f.group.packets.map((p) => p.transaction),
    });
    expect(sim[0].params[1]).toMatchObject({
      skipSigVerify: true,
      replaceRecentBlockhash: false,
      simulationBank: { slot: 100 },
      transactionEncoding: 'base64',
    });
    expect(
      f.calls.some((c) =>
        ['simulateTransaction', 'sendTransaction', 'sendBundle'].includes(
          c.method,
        ),
      ),
    ).toBe(false);
    expect(result.frames).toHaveLength(f.group.packets.length);
    expect(result.addresses).toEqual(fundingKeys(f.funding));
    expect(f.accounts.get(f.input.create.mint)).toBeUndefined();
    expect(f.accounts.get(f.input.create.payer)?.lamports).toBe('1000000000');
  });
const fundingKeys = (funding: { accountHashes: { address: string }[] }) =>
  funding.accountHashes.map((a) => a.address);
it('rejects independent replay when a later packet starts from the original payer balance', async () => {
  const f = await fixture(),
    message = getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(
        Buffer.from(f.group.packets[1].transaction, 'base64'),
      ).messageBytes,
    );
  const index = message.staticAccounts
    .map(String)
    .indexOf(f.input.create.payer);
  f.response.value.transactionResults[1].preExecutionAccounts[index] =
    structuredClone(f.accounts.get(f.input.create.payer)!);
  await expect(f.verify()).rejects.toThrow('carry across packet boundaries');
});
it('rejects failed, incomplete, wrong-bank, replaced-lifetime and unbounded resource traces', async () => {
  const f = await fixture(),
    original = structuredClone(f.response);
  const mutate = [
    () => {
      f.response.value.summary = 'failed';
    },
    () => {
      f.response.value.transactionResults.pop();
    },
    () => {
      f.response.context.slot = '101';
    },
    () => {
      f.response.value.transactionResults[0].fee = '1';
    },
    () => {
      f.response.value.transactionResults[0].loadedAddresses.readonly.push(
        f.input.create.mint,
      );
    },
    () => {
      f.response.value.transactionResults[0].unitsConsumed = '1400001';
    },
    () => {
      f.response.value.transactionResults[0].loadedAccountsDataSize =
        '67108865';
    },
    () => {
      f.response.value.transactionResults[0].err = { bad: true } as never;
    },
    () => {
      f.response.value.transactionResults[0].replacementBlockhash = {
        blockhash: f.input.create.blockhash,
      } as never;
    },
  ];
  for (const change of mutate) {
    Object.assign(f.response, structuredClone(original));
    change();
    await expect(f.verify()).rejects.toThrow();
  }
}, 15000);
it('rejects readonly mutations and unsafe default-account normalization', async () => {
  const f = await fixture(),
    keys = getCompiledTransactionMessageDecoder()
      .decode(
        getTransactionDecoder().decode(
          Buffer.from(f.group.packets[0].transaction, 'base64'),
        ).messageBytes,
      )
      .staticAccounts.map(String);
  const quote = keys.indexOf(f.input.create.quoteMint);
  f.response.value.transactionResults[0].postExecutionAccounts[
    quote
  ]!.lamports = '9';
  await expect(f.verify()).rejects.toThrow('readonly');
  const g = await fixture();
  for (const r of g.response.value.transactionResults) {
    r.preExecutionAccounts = r.preExecutionAccounts.map(
      (a) => a ?? raw(SYSTEM, new Uint8Array(), '0'),
    );
    r.postExecutionAccounts = r.postExecutionAccounts.map(
      (a) => a ?? raw(SYSTEM, new Uint8Array(), '0'),
    );
  }
  expect((await g.verify()).rpcCollectionRequired).toBe(true);
  const mint = keys.indexOf(f.input.create.mint);
  f.response.value.transactionResults[0].preExecutionAccounts[mint] = raw(
    PUMP_TOKEN_2022,
    new Uint8Array(),
    '0',
  );
  await expect(f.verify()).rejects.toThrow();
}, 10000);
it('rejects funding/allowance substitutions before invoking the provider', async () => {
  const f = await fixture(),
    provider = vi.fn(f.rpc);
  f.funding.manifestSha256 = 'a'.repeat(64);
  await expect(f.run(provider)).rejects.toThrow('funding context differs');
  expect(provider).not.toHaveBeenCalled();
});
it('refuses groups exceeding five packets rather than splitting or falling back', async () => {
  const f = await fixture(false, false, 100),
    provider = vi.fn(f.rpc);
  expect(f.group.packets.length).toBeGreaterThan(5);
  await expect(f.run(provider)).rejects.toThrow('five-transaction bundle');
  expect(provider).not.toHaveBeenCalled();
}, 30000);
it('rejects real source changes, original expiry and final network changes', async () => {
  const changed = await fixture();
  changed.state.hook = () => {
    changed.accounts.get(changed.input.create.payer)!.lamports = '999999999';
  };
  await expect(changed.run()).rejects.toThrow('source changed');
  const expired = await fixture();
  expired.state.height = '995';
  await expect(expired.run()).rejects.toThrow('lifetime expired');
  const network = await fixture();
  let n = 0;
  await expect(
    network.run(async (method, params, signal) =>
      method === 'getGenesisHash' && ++n === 2
        ? 'different-network'
        : network.rpc(method, params, signal),
    ),
  ).rejects.toThrow('network changed');
}, 15000);
it('retries complete mixed source rechecks and fails after three mismatches', async () => {
  const f = await fixture(false, false, 44);
  f.state.snapshots = 0;
  f.state.slotFor = (number, requested) =>
    number === 2 ? requested + 1 : requested;
  expect((await f.run()).sourceRecheckSlot).toBe(101);
  expect(f.state.snapshots).toBe(4);
  const g = await fixture(false, false, 44);
  g.state.snapshots = 0;
  g.state.slotFor = (number, requested) => requested + (number % 2);
  await expect(g.run()).rejects.toThrow('one bank');
  expect(g.state.snapshots).toBe(6);
}, 15000);
it('terminates a stalled bundle call on cancellation without requesting another simulation', async () => {
  const f = await fixture(),
    controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let count = 0;
  const pending = f.run(async (method, params, signal) => {
    if (method === 'simulateBundle') {
      count++;
      ready();
      return new Promise(() => {});
    }
    return f.rpc(method, params, signal);
  }, controller.signal);
  await started;
  controller.abort(new Error('cancel stalled replay'));
  await expect(pending).rejects.toThrow('cancel stalled replay');
  expect(count).toBe(1);
});
