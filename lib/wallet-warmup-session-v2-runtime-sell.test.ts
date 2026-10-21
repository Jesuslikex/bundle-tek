import { expect, it } from 'vitest';
import { warmupRuntimeSellFixture } from '@/test/warmup-session-v2-runtime-sell-fixture';
import {
  prepareWalletWarmupV2RuntimeAttempt as prepare,
  readWalletWarmupV2ReadAttempt as read,
} from './wallet-warmup-session-v2-attempts';
const signal = () => new AbortController().signal;
it('refuses inventory that predates the recorded finalized partial sale', async () => {
  const f = await warmupRuntimeSellFixture({ remainingRaw: '25' });
  try {
    expect(f.latestReceiptSlot).toBeGreaterThan(f.packets.buyDocument.slot);
    f.state.baseline = f.packets.buyDocument.slot + 1;
    f.state.inventorySlot = f.state.baseline;
    f.state.mintSlot = f.state.baseline + 1;
    f.raw.state.slot = f.state.baseline + 3;
    const saved = await prepare(
      f.db,
      'owner',
      f.selection(),
      true,
      signal(),
      'synthetic-key',
      f.factory,
    );
    expect(saved.outcome?.kind).toBe('refused');
    expect(saved.outcome?.refusal_code).toBe('evidence-refused');
    const calls = f.inventoryFetch.mock.calls.map(([, init]) =>
      JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
    );
    expect(calls.find((c) => c.method === 'getSlot')?.params).toEqual([
      { commitment: 'confirmed', minContextSlot: f.latestReceiptSlot },
    ]);
    expect(calls.some((c) => c.method === 'getTokenAccountsByOwner')).toBe(
      false,
    );
    expect(f.raw.prepare).not.toHaveBeenCalled();
  } finally {
    f.client.close();
  }
});
it('rejects a valid-looking injected inventory report that drops the receipt floor', async () => {
  const f = await warmupRuntimeSellFixture({ remainingRaw: '25' });
  try {
    f.state.returnedSlot = f.latestReceiptSlot - 1;
    const saved = await prepare(
      f.db,
      'owner',
      f.selection(),
      true,
      signal(),
      'synthetic-key',
      f.factory,
    );
    expect(saved.outcome?.refusal_code).toBe('evidence-refused');
    expect(f.inventoryFetch).toHaveBeenCalledTimes(5);
    expect(f.raw.prepare).not.toHaveBeenCalled();
  } finally {
    f.client.close();
  }
});
it('composes a retained buy, real inventory observer, exact Sell runtime and saved-only recovery', async () => {
  const f = await warmupRuntimeSellFixture();
  try {
    const input = f.selection(),
      saved = await prepare(
        f.db,
        'owner',
        input,
        true,
        signal(),
        'synthetic-key',
        f.factory,
      );
    expect(saved.outcome?.kind).toBe('prepared');
    expect(saved.summary?.side).toBe('Sell');
    expect(saved.summary?.inAmountRaw).toBe('101');
    expect(saved.summary?.buyReceipt).toMatchObject({
      receiptId: f.packets.buy.receiptId,
      acquiredRaw: '101',
      remainingRaw: '101',
    });
    expect(saved.summary?.inventory).toMatchObject({
      requestedRaw: '101',
      amountCovered: true,
      unfrozenRaw: '101',
    });
    expect(f.inventoryFetch).toHaveBeenCalledTimes(5);
    expect(f.raw.prepare).toHaveBeenCalledOnce();
    expect(
      f.raw.rpc.mock.calls.filter(
        ([method]) => method === 'simulateTransaction',
      ),
    ).toHaveLength(1);
    const first = await read(f.db, 'owner', input.id, signal());
    expect(first?.mode).toBe('runtime');
    await f.control('stop');
    expect(await read(f.db, 'owner', input.id, signal())).toEqual(first);
    await prepare(f.db, 'owner', input, true, signal(), undefined, f.factory);
    expect(f.factory).toHaveBeenCalledOnce();
    expect(f.inventoryFetch).toHaveBeenCalledTimes(5);
    expect(await read(f.db, 'other', input.id, signal())).toBeNull();
  } finally {
    f.client.close();
  }
});
it.each(['25', '1'])(
  'uses only the retained remaining %s units without consuming the lot during a read',
  async (remainingRaw) => {
    const f = await warmupRuntimeSellFixture({ remainingRaw });
    try {
      const saved = await prepare(
        f.db,
        'owner',
        f.selection(),
        true,
        signal(),
        'synthetic-key',
        f.factory,
      );
      expect(saved.outcome?.kind).toBe('prepared');
      expect(saved.summary?.buyReceipt).toMatchObject({
        acquiredRaw: '101',
        remainingRaw,
      });
      expect(saved.summary?.inAmountRaw).toBe(remainingRaw);
      expect(
        (await f.db
          .prepare('SELECT remaining_raw FROM warmup_buy_receipts WHERE id=?')
          .bind(f.packets.buy.receiptId)
          .first<{ remaining_raw: string }>())!.remaining_raw,
      ).toBe(remainingRaw);
      expect(f.raw.prepare).toHaveBeenCalledOnce();
    } finally {
      f.client.close();
    }
  },
);
it('preserves exact SOL and rent accounting when a funded wrapped-SOL account closes', async () => {
  const f = await warmupRuntimeSellFixture({ existing: true });
  try {
    const saved = await prepare(
      f.db,
      'owner',
      f.selection(),
      true,
      signal(),
      'synthetic-key',
      f.factory,
    );
    expect(saved.outcome?.kind).toBe('prepared');
    expect(saved.summary?.simulation.networkFeeLamports).toBe('5000');
    expect(saved.summary?.simulation.nativeChangeRaw).toBe(
      (2000000n + 2039280n - 5000n).toString(),
    );
    expect(saved.fee?.boundLamports).toBe('5000');
  } finally {
    f.client.close();
  }
});
it.each([
  'frozen',
  'insufficient',
  'decimals',
  'before-buy',
  'mint-floor',
  'span',
  'clock',
  'native-close',
] as const)(
  'refuses %s without relaxing inventory or runtime rules',
  async (reason) => {
    const f = await warmupRuntimeSellFixture({
      keepWrapped: reason === 'native-close',
    });
    try {
      if (reason === 'frozen') f.state.frozen = true;
      if (reason === 'insufficient') f.state.raw = '100';
      if (reason === 'decimals') f.state.decimals = 5;
      if (reason === 'before-buy') {
        f.state.baseline = f.packets.buyDocument.slot - 1;
        f.state.inventorySlot = f.state.baseline;
        f.state.mintSlot = f.state.baseline;
      }
      if (reason === 'mint-floor') f.state.mintSlot = f.state.inventorySlot - 1;
      if (reason === 'span') f.raw.state.slot = f.state.inventorySlot + 33;
      if (reason === 'clock') f.raw.state.clockDelta = 1;
      const input = f.selection(),
        saved = await prepare(
          f.db,
          'owner',
          input,
          true,
          signal(),
          'synthetic-key',
          f.factory,
        );
      expect(saved.outcome?.kind).toBe('refused');
      expect(saved.outcome?.refusal_code).toBe(
        ['frozen', 'insufficient'].includes(reason)
          ? 'provider-refused'
          : 'evidence-refused',
      );
      expect(
        (await f.db
          .prepare(
            'SELECT count(*) AS n FROM wallet_warmup_session_v2_runtime_observations',
          )
          .first<{ n: number }>())!.n,
      ).toBe(0);
      if (reason !== 'native-close')
        expect(f.raw.prepare).not.toHaveBeenCalled();
      expect(
        f.raw.rpc.mock.calls.filter(
          ([method]) => method === 'simulateTransaction',
        ),
      ).toHaveLength(0);
      await prepare(f.db, 'owner', input, true, signal(), undefined, f.factory);
      expect(f.factory).toHaveBeenCalledOnce();
    } finally {
      f.client.close();
    }
  },
);
it('retains an actual inventory HTTP429 as a provider limit and never retries that ID', async () => {
  const f = await warmupRuntimeSellFixture();
  try {
    f.state.limited = true;
    const input = f.selection(),
      saved = await prepare(
        f.db,
        'owner',
        input,
        true,
        signal(),
        'synthetic-key',
        f.factory,
      );
    expect(saved.outcome?.kind).toBe('refused');
    expect(saved.outcome?.refusal_code).toBe('provider-limited');
    expect(f.inventoryFetch).toHaveBeenCalledOnce();
    expect(f.raw.prepare).not.toHaveBeenCalled();
    await prepare(f.db, 'owner', input, true, signal(), undefined, f.factory);
    expect(f.inventoryFetch).toHaveBeenCalledOnce();
    await expect(
      prepare(
        f.db,
        'owner',
        f.selection(),
        true,
        signal(),
        'synthetic-key',
        f.factory,
      ),
    ).rejects.toMatchObject({ status: 409 });
  } finally {
    f.client.close();
  }
});
it.each(['stop', 'consume'] as const)(
  'refuses publication after %s changes the source during inventory reads',
  async (change) => {
    const f = await warmupRuntimeSellFixture();
    try {
      const input = f.selection();
      f.state.afterInventory = async () => {
        if (change === 'stop') await f.control('stop');
        else
          await f.db
            .prepare(
              'UPDATE warmup_buy_receipts SET remaining_raw=? WHERE id=?',
            )
            .bind('100', f.packets.buy.receiptId)
            .run();
      };
      const saved = await prepare(
        f.db,
        'owner',
        input,
        true,
        signal(),
        'synthetic-key',
        f.factory,
      );
      expect(saved.outcome).toBeNull();
      expect(f.raw.prepare).not.toHaveBeenCalled();
      await prepare(f.db, 'owner', input, true, signal(), undefined, f.factory);
      expect(f.factory).toHaveBeenCalledOnce();
      expect(f.inventoryFetch).toHaveBeenCalledTimes(5);
    } finally {
      f.client.close();
    }
  },
);
