import { afterEach, expect, it, vi } from 'vitest';
import { jitoBundleFixture } from '../test/jito-bundle-fixture';
import { jitoDatabase } from '../test/jito-sqlite';
import { unsignedPreparationSummary } from './imported-swap-preparation-history';
const mocks = vi.hoisted(() => ({
  simulation: null as unknown,
  tip: '',
  send: vi.fn(),
  statuses: null as unknown,
  height: '0',
  tipReceipt: null as unknown,
  jitoStatus: null as unknown,
  reads: vi.fn(),
  genesis: null as string | null,
}));
vi.mock('./imported-trade-session-server', async (original) => ({
  ...(await original<object>()),
  currentTradeSession: async () => undefined,
}));
vi.mock('./imported-swap-simulation', async (original) => {
  const actual = await original<typeof import('./imported-swap-simulation')>();
  return {
    ...actual,
    simulateImportedSwap: (
      ...args: Parameters<typeof actual.simulateImportedSwap>
    ) =>
      mocks.simulation && args[2] === fetch
        ? Promise.resolve(mocks.simulation)
        : actual.simulateImportedSwap(...args),
  };
});
vi.mock('./native-withdrawal-server', async (original) => ({
  ...(await original<object>()),
  recheckNativeWithdrawal: async () => undefined,
}));
vi.mock('./jito-provider', () => ({
  getJitoTipAccounts: async () => [mocks.tip],
  jitoRpc: async (method: string, params: unknown[]) =>
    method === 'sendBundle' ? mocks.send(params) : mocks.jitoStatus,
}));
vi.mock('./wallet-balances', async (original) => {
  const actual = await original<typeof import('./wallet-balances')>();
  return {
    ...actual,
    balanceRpc: (...args: Parameters<typeof actual.balanceRpc>) => {
      if (args[4] !== fetch) return actual.balanceRpc(...args);
      mocks.reads(args[1], args[2]);
      switch (args[1]) {
        case 'getGenesisHash':
          return Promise.resolve(
            mocks.genesis ?? actual.SOLANA_MAINNET_GENESIS,
          );
        case 'getBalance':
          return Promise.resolve({ value: '1000000000' });
        case 'getSignatureStatuses':
          return Promise.resolve(mocks.statuses);
        case 'getBlockHeight':
          return Promise.resolve(mocks.height);
        case 'getTransaction':
          return Promise.resolve(mocks.tipReceipt);
        default:
          throw new Error(`Unexpected fixture read: ${args[1]}`);
      }
    },
  };
});
import {
  submitJitoBundle,
  registerJitoPacket,
  observeJitoBundle,
  readJitoBundle,
} from './jito-bundle-server';
const databases: ReturnType<typeof jitoDatabase>[] = [];
afterEach(() => {
  for (const d of databases.splice(0)) d.sqlite.close();
  mocks.simulation = null;
  mocks.tipReceipt = null;
  mocks.jitoStatus = null;
  mocks.statuses = null;
  mocks.height = '0';
  mocks.genesis = null;
  mocks.send.mockReset();
  mocks.reads.mockReset();
});
async function fixture() {
  const f = await jitoBundleFixture(),
    d = jitoDatabase(f.manifest);
  databases.push(d);
  const document = {
    ...unsignedPreparationSummary(f.swap.order, f.swap.simulation),
    session: f.review.session,
  };
  d.sqlite
    .prepare('UPDATE imported_swap_preparations SET document=?')
    .run(JSON.stringify(document));
  d.attach();
  mocks.simulation = f.swap.simulation;
  mocks.tip = f.tip.recipient;
  await registerJitoPacket(
    d.db,
    'owner',
    f.manifest.id,
    f.manifest.sha256,
    0,
    f.swap.signed.transaction,
  );
  await registerJitoPacket(
    d.db,
    'owner',
    f.manifest.id,
    f.manifest.sha256,
    1,
    f.tip.signed.transaction,
  );
  return { f, d };
}
it('retains reservations through the exact expiry margin and rechecks mainnet before releasing them', async () => {
  const { f, d } = await fixture();
  mocks.send.mockRejectedValue(Error('unknown'));
  await submitJitoBundle(
    d.db,
    'owner',
    f.manifest.id,
    f.manifest.sha256,
    AbortSignal.timeout(1000),
  );
  const maximum = [
    f.manifest.tip.lastValidBlockHeight,
    ...f.manifest.swaps.map((s) => s.lastValidBlockHeight),
  ].reduce((a, b) => (BigInt(a) > BigInt(b) ? a : b));
  mocks.statuses = { value: [null, null] };
  mocks.tipReceipt = null;
  mocks.height = String(BigInt(maximum) + 32n);
  const recover = () =>
    observeJitoBundle(
      d.db,
      'owner',
      f.manifest.id,
      AbortSignal.timeout(1000),
      async () => null,
    );
  expect((await recover()).state).toBe('submitting');
  expect(mocks.reads).toHaveBeenCalledWith('getBlockHeight', [
    { commitment: 'finalized', minContextSlot: f.manifest.tip.slot },
  ]);
  mocks.height = String(BigInt(maximum) + 33n);
  mocks.reads.mockImplementation((method) => {
    if (method === 'getTransaction') mocks.genesis = 'wrong-network';
  });
  await expect(recover()).rejects.toThrow('network changed');
  expect(
    (await readJitoBundle(d.db, 'owner', f.manifest.id)).record.state,
  ).toBe('submitting');
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
for (const mode of ['failed-envelope', 'unretained-marker'] as const)
  it(`refuses transport when the send marker has ${mode}`, async () => {
    const { f, d } = await fixture();
    const prepare = d.db.prepare.bind(d.db);
    vi.spyOn(d.db, 'prepare').mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("SET state='submitting'")) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...values) => {
          const bound = bind(...values);
          vi.spyOn(bound, 'run').mockResolvedValue({
            success: mode !== 'failed-envelope',
            meta: { changes: 1 },
          } as never);
          return bound;
        };
      }
      return statement;
    });
    await expect(
      submitJitoBundle(
        d.db,
        'owner',
        f.manifest.id,
        f.manifest.sha256,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(
      (await readJitoBundle(d.db, 'owner', f.manifest.id)).record.state,
    ).toBe('reviewed');
  });
it('sends the ordered base64 bundle once, retaining an unknown response without fallback', async () => {
  const { f, d } = await fixture();
  mocks.send.mockRejectedValue(new Error('timeout'));
  const result = await submitJitoBundle(
    d.db,
    'owner',
    f.manifest.id,
    f.manifest.sha256,
    AbortSignal.timeout(1000),
  );
  expect(result.state).toBe('submitting');
  expect(result.bundleId).toBeNull();
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith([
    [f.swap.signed.transaction, f.tip.signed.transaction],
    { encoding: 'base64' },
  ]);
  await expect(
    submitJitoBundle(
      d.db,
      'owner',
      f.manifest.id,
      f.manifest.sha256,
      AbortSignal.timeout(1000),
    ),
  ).rejects.toThrow();
  expect(mocks.send).toHaveBeenCalledTimes(1);
  expect(mocks.reads.mock.calls.some((c) => c[0] === 'sendTransaction')).toBe(
    false,
  );
});
it('records acceptance without claiming landing and verifies exact same-slot finalized outcomes', async () => {
  const { f, d } = await fixture(),
    bundleId = 'ab'.repeat(32);
  mocks.send.mockResolvedValue(bundleId);
  let result = await submitJitoBundle(
    d.db,
    'owner',
    f.manifest.id,
    f.manifest.sha256,
    AbortSignal.timeout(1000),
  );
  expect(result.state).toBe('submitted');
  mocks.statuses = {
    value: [
      { slot: '300', err: null, confirmationStatus: 'finalized' },
      { slot: '301', err: null, confirmationStatus: 'finalized' },
    ],
  };
  const recoveredReceipt = {
    projectId: f.manifest.projectId,
    preparationId: f.review.preparationId,
    document: {
      side: 'Buy',
      network: 'mainnet',
      commitment: 'finalized',
      signatureVerified: true,
      signature: f.swap.signed.signature,
      wallet: f.review.wallet,
      preparationSha256: f.review.sha256,
      slot: 300,
      mint: f.review.outputMint,
    },
  };
  const recover = vi.fn(async () => recoveredReceipt);
  result = await observeJitoBundle(
    d.db,
    'owner',
    f.manifest.id,
    AbortSignal.timeout(1000),
    recover,
  );
  expect(result.state).toBe('submitted');
  expect(recover).not.toHaveBeenCalled();
  mocks.statuses = {
    value: [
      { slot: '300', err: null, confirmationStatus: 'finalized' },
      { slot: '300', err: null, confirmationStatus: 'finalized' },
    ],
  };
  mocks.jitoStatus = {
    value: [
      {
        bundle_id: bundleId,
        transactions: [f.swap.signed.signature, f.tip.signed.signature],
        slot: 300,
        confirmation_status: 'finalized',
        err: { Ok: null },
      },
    ],
  };
  mocks.tipReceipt = { ...f.tip.receipt, slot: '300' };
  const validTip = mocks.tipReceipt;
  for (const meta of [
    {
      ...f.tip.receipt.meta,
      fee: (BigInt(f.manifest.tip.feeLamports) + 1n).toString(),
    },
    {
      ...f.tip.receipt.meta,
      postBalances: [...f.tip.receipt.meta.preBalances],
    },
  ]) {
    mocks.tipReceipt = { ...f.tip.receipt, slot: '300', meta };
    await expect(
      observeJitoBundle(
        d.db,
        'owner',
        f.manifest.id,
        AbortSignal.timeout(1000),
        recover,
      ),
    ).rejects.toThrow('settlement');
    expect(
      (await readJitoBundle(d.db, 'owner', f.manifest.id)).record,
    ).toMatchObject({ state: 'submitted', finalization: null });
  }
  mocks.tipReceipt = validTip;
  await expect(
    observeJitoBundle(
      d.db,
      'owner',
      f.manifest.id,
      AbortSignal.timeout(1000),
      async () => ({
        ...recoveredReceipt,
        document: { ...recoveredReceipt.document, slot: 301 },
      }),
    ),
  ).rejects.toThrow('Exact finalized swap receipt');
  expect(
    (await readJitoBundle(d.db, 'owner', f.manifest.id)).record,
  ).toMatchObject({ state: 'submitted', finalization: null });
  result = await observeJitoBundle(
    d.db,
    'owner',
    f.manifest.id,
    AbortSignal.timeout(1000),
    recover,
  );
  expect(result.state).toBe('finalized');
  expect(result.finalization).toMatchObject({
    slot: 300,
    bundleSha256: f.manifest.sha256,
    signatures: [f.swap.signed.signature, f.tip.signed.signature],
    tipReceipt: {
      amountRaw: f.manifest.tip.amountRaw,
      networkFeeLamports: f.tip.receipt.meta.fee,
      slot: 300,
      wallet: f.manifest.tip.wallet,
      recipient: f.manifest.tip.recipient,
    },
  });
  expect(
    (await readJitoBundle(d.db, 'owner', f.manifest.id)).record.finalization,
  ).toEqual(result.finalization);
  expect(() =>
    d.sqlite
      .prepare("UPDATE jito_bundle_finalizations SET document='{}'")
      .run(),
  ).toThrow('immutable');
  expect(() =>
    d.sqlite.prepare('DELETE FROM jito_bundle_finalizations').run(),
  ).toThrow('retained');
  expect(recover).toHaveBeenCalledExactlyOnceWith(f.review.id);
});
it('retains partial/failed outcomes and releases only after all validity windows end with no found evidence', async () => {
  const { f, d } = await fixture();
  mocks.send.mockRejectedValue(new Error('unknown'));
  await submitJitoBundle(
    d.db,
    'owner',
    f.manifest.id,
    f.manifest.sha256,
    AbortSignal.timeout(1000),
  );
  mocks.statuses = {
    value: [{ slot: '300', err: null, confirmationStatus: 'processed' }, null],
  };
  mocks.height = '999999999999';
  expect(
    (
      await observeJitoBundle(
        d.db,
        'owner',
        f.manifest.id,
        AbortSignal.timeout(1000),
        async () => true,
      )
    ).state,
  ).toBe('submitting');
  expect(
    d.sqlite.prepare('SELECT count(*) AS n FROM solana_swap_reservations').get()
      ?.n,
  ).toBe(1);
  mocks.statuses = { value: [null, null] };
  mocks.tipReceipt = null;
  expect(
    (
      await observeJitoBundle(
        d.db,
        'owner',
        f.manifest.id,
        AbortSignal.timeout(1000),
        async () => true,
      )
    ).state,
  ).toBe('expired');
  expect(
    d.sqlite.prepare('SELECT count(*) AS n FROM solana_swap_reservations').get()
      ?.n,
  ).toBe(0);
  expect(mocks.send).toHaveBeenCalledTimes(1);
});
