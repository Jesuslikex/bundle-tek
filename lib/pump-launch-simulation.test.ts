import { expect, it } from 'vitest';
import {
  simulatePumpCreate,
  type PumpLaunchRpc,
  type PumpRpcAccount,
} from './pump-launch-simulation';
import { PUMP_LAUNCH_PROGRAM, PUMP_TOKEN_2022 } from './pump-launch-config';
import {
  pumpSimulationFixture as fixture,
  raw,
  SYSTEM,
} from '../test/pump-launch-simulation-fixture';
it('collects mainnet context, simulates the exact unsigned packet and reconciles fee/rent without enabling signing', async () => {
  const f = await fixture();
  const r = await simulatePumpCreate(
    f.intent,
    '5000000',
    new AbortController().signal,
    f.rpc,
  );
  expect(r).toMatchObject({
    executionAllowed: false,
    signingAllowed: false,
    completeLaunch: false,
    simulation: {
      status: 'Simulated',
      networkFeeRaw: '10000',
      payerDebitRaw: '3010000',
      feeAndRentLimitRaw: '5000000',
      unitsConsumed: '150000',
    },
  });
  expect(r.preparation.containsInitialBuy).toBe(false);
  const sim = f.calls.find((c) => c.method === 'simulateTransaction')!;
  expect(sim.params[0]).toBe(r.preparation.transaction);
  expect(sim.params[1]).toMatchObject({
    sigVerify: false,
    replaceRecentBlockhash: false,
    encoding: 'base64',
    innerInstructions: false,
    minContextSlot: 100,
  });
  expect(r.simulation.createdAccounts).toHaveLength(3);
  expect(
    f.calls.every((c) => !['sendTransaction', 'sendBundle'].includes(c.method)),
  ).toBe(true);
});
it('retains the exact token quote and zero quote custody balance in simulation', async () => {
  const f = await fixture(true);
  const r = await simulatePumpCreate(
    f.intent,
    '5000000',
    new AbortController().signal,
    f.rpc,
  );
  expect(r.preparation.quoteMint).toBe(f.f.quoteMint);
  expect(r.preparation.quote).toMatchObject({ source: 'global', decimals: 8 });
  expect(r.simulation.payerDebitRaw).toBe('4010000');
  expect(r.simulation.createdAccounts).toHaveLength(4);
});
it('captures upgradeable program deployment metadata and rejects observed upgrades', async () => {
  const f = await fixture(false, true);
  const r = await simulatePumpCreate(
    f.intent,
    '5000000',
    new AbortController().signal,
    f.rpc,
  );
  expect(r.simulation.programDeploymentHashes).toHaveLength(1);
  expect(r.simulation.programDeploymentMetadataOnly).toBe(true);
  const changed = await fixture(false, true);
  changed.state.headerChanged = true;
  await expect(
    simulatePumpCreate(
      changed.intent,
      '5000000',
      new AbortController().signal,
      changed.rpc,
    ),
  ).rejects.toThrow(/deployment changed/);
});
it('rejects non-mainnet, insufficient payer funds, existing mint and unexecutable programs before simulation', async () => {
  for (const change of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.genesis = 'devnet';
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.before.set(f.f.payer, raw(SYSTEM, new Uint8Array(), '4999999'));
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.before.set(f.f.mint, raw(SYSTEM));
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.before.set(PUMP_LAUNCH_PROGRAM, raw(SYSTEM));
    },
  ]) {
    const f = await fixture();
    change(f);
    await expect(
      simulatePumpCreate(
        f.intent,
        '5000000',
        new AbortController().signal,
        f.rpc,
      ),
    ).rejects.toThrow();
    expect(f.calls.some((c) => c.method === 'simulateTransaction')).toBe(false);
  }
});
it('requires the full fee/rent allowance and rejects fee changes, program errors and replaced blockhashes', async () => {
  for (const change of [
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.fee = '5000001';
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.simFee = '9999';
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.err = { InstructionError: [1, { Custom: 6000 }] };
    },
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.state.replacement = { blockhash: 'other' };
    },
  ]) {
    const f = await fixture();
    change(f);
    await expect(
      simulatePumpCreate(
        f.intent,
        '5000000',
        new AbortController().signal,
        f.rpc,
      ),
    ).rejects.toThrow(/Pump/);
  }
});
it('rejects altered metadata, curve quote, custody amount and payer authority', async () => {
  const mutations = [
    (
      f: Awaited<ReturnType<typeof fixture>>,
      p: Map<string, PumpRpcAccount>,
    ) => {
      const b = f.metadataMint();
      b[b.length - 5] ^= 1;
      p.set(f.f.mint, raw(PUMP_TOKEN_2022, b));
    },
    (
      f: Awaited<ReturnType<typeof fixture>>,
      p: Map<string, PumpRpcAccount>,
    ) => {
      const a = p.get(f.f.pdas.bondingCurve)!;
      if (a) {
        const b = Buffer.from(a.data[0], 'base64');
        b[83] ^= 1;
        a.data[0] = b.toString('base64');
      }
    },
    (
      f: Awaited<ReturnType<typeof fixture>>,
      p: Map<string, PumpRpcAccount>,
    ) => {
      p.set(
        f.f.pdas.associatedCurve,
        raw(PUMP_TOKEN_2022, f.custody(f.f.mint, 1n)),
      );
    },
    (
      f: Awaited<ReturnType<typeof fixture>>,
      p: Map<string, PumpRpcAccount>,
    ) => {
      p.set(f.f.payer, raw(PUMP_TOKEN_2022, new Uint8Array(), '996990000'));
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture();
    f.state.postHook = (p) => mutate(f, p);
    await expect(
      simulatePumpCreate(
        f.intent,
        '5000000',
        new AbortController().signal,
        f.rpc,
      ),
    ).rejects.toThrow();
  }
});
it('rejects non-reconciling debit, insufficient account rent and missing simulated accounts', async () => {
  const f = await fixture();
  f.state.postHook = (p) => {
    const a = p.get(f.f.payer)!;
    if (a) a.lamports = '990000000';
  };
  await expect(
    simulatePumpCreate(
      f.intent,
      '5000000',
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow(/allowance/);
  const g = await fixture();
  g.state.postHook = (p) => {
    p.set(g.f.pdas.associatedCurve, null);
  };
  await expect(
    simulatePumpCreate(
      g.intent,
      '5000000',
      new AbortController().signal,
      g.rpc,
    ),
  ).rejects.toThrow();
  const h = await fixture();
  const rpc: PumpLaunchRpc = (m, p, s) =>
    m === 'getMinimumBalanceForRentExemption'
      ? Promise.resolve('1000001')
      : h.rpc(m, p, s);
  await expect(
    simulatePumpCreate(h.intent, '5000000', new AbortController().signal, rpc),
  ).rejects.toThrow(/rent/);
});
it('rejects stale/minimum-slot violations, expired lifetime and state drift after simulation', async () => {
  const f = await fixture();
  f.state.minContextOffset = -1;
  await expect(
    simulatePumpCreate(
      f.intent,
      '5000000',
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow(/minimum context/);
  const g = await fixture();
  g.state.height = '995';
  await expect(
    simulatePumpCreate(
      g.intent,
      '5000000',
      new AbortController().signal,
      g.rpc,
    ),
  ).rejects.toThrow(/near expiry/);
  const h = await fixture();
  h.state.stableHook = (p) =>
    p.set(h.f.payer, raw(SYSTEM, new Uint8Array(), '999999999'));
  await expect(
    simulatePumpCreate(
      h.intent,
      '5000000',
      new AbortController().signal,
      h.rpc,
    ),
  ).rejects.toThrow(/changed during/);
});
it('cancels an RPC that ignores abort and sanitizes provider failures', async () => {
  const f = await fixture(),
    controller = new AbortController();
  const promise = simulatePumpCreate(
    f.intent,
    '5000000',
    controller.signal,
    async () => new Promise(() => {}),
  );
  controller.abort();
  await expect(promise).rejects.toThrow(/cancelled/);
  await expect(
    simulatePumpCreate(
      f.intent,
      '5000000',
      new AbortController().signal,
      async () => {
        throw new Error('SECRET URL provider diagnostics');
      },
    ),
  ).rejects.toThrow('Pump launch RPC read is unavailable.');
});

it('rejects an unreconciled debit inside the allowance, excessive compute and a forked blockhash', async () => {
  const f = await fixture();
  f.state.postHook = (p) =>
    p.set(f.f.payer, raw(SYSTEM, new Uint8Array(), '996989999'));
  await expect(
    simulatePumpCreate(
      f.intent,
      '5000000',
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow(/reconcile/);
  const g = await fixture();
  g.state.units = '300001';
  await expect(
    simulatePumpCreate(
      g.intent,
      '5000000',
      new AbortController().signal,
      g.rpc,
    ),
  ).rejects.toThrow(/compute/);
  const h = await fixture();
  h.state.valid = false;
  await expect(
    simulatePumpCreate(
      h.intent,
      '5000000',
      new AbortController().signal,
      h.rpc,
    ),
  ).rejects.toThrow(/expired/);
});

it('rejects changed readonly executable state even when money still reconciles', async () => {
  const f = await fixture();
  f.state.postHook = (p) => {
    const a = p.get(PUMP_LAUNCH_PROGRAM)!;
    if (a) a.data = [Buffer.from([9]).toString('base64'), 'base64'];
  };
  await expect(
    simulatePumpCreate(
      f.intent,
      '5000000',
      new AbortController().signal,
      f.rpc,
    ),
  ).rejects.toThrow(/executable/);
});
