import { expect, it, vi } from 'vitest';
import { warmupSessionV2AttemptFixture } from '@/test/warmup-session-v2-attempt-fixture';
import {
  prepareWalletWarmupV2Attempt as prepare,
  readWalletWarmupV2Attempt as read,
  publicWalletWarmupV2Attempt as project,
} from './wallet-warmup-session-v2-attempts';
import { WalletWarmupSessionProviderError } from './wallet-warmup-session-provider';
const signal = () => new AbortController().signal;
const refusingFactory = () => async () => {
  throw new WalletWarmupSessionProviderError('synthetic refusal');
};
it('returns a temporary clock conflict for the original saved ID without renewing its lease or calling the provider', async () => {
  const f = await warmupSessionV2AttemptFixture();
  try {
    const input = f.input(),
      callback = vi.fn(async () => {
        throw new WalletWarmupSessionProviderError('synthetic refusal');
      });
    const saved = await prepare(
      f.db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      () => callback,
    );
    const counts = await f.counts();
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(f.journal.createdAt) - 1);
    try {
      await expect(
        read(f.db, 'owner', input.id, signal()),
      ).rejects.toMatchObject({
        status: 409,
        message:
          'Saved history is ahead of this server clock. Recover the same ID shortly.',
      });
    } finally {
      now.mockRestore();
    }
    expect((await read(f.db, 'owner', input.id, signal()))?.lease).toEqual(
      saved.lease,
    );
    expect(await f.counts()).toEqual(counts);
    expect(callback).toHaveBeenCalledOnce();
  } finally {
    vi.restoreAllMocks();
    f.client.close();
  }
});
it('atomically claims one lease and cooldown, retains a sanitized refusal and never reruns that request', async () => {
  const f = await warmupSessionV2AttemptFixture();
  try {
    const callback = vi.fn(async () => {
      throw new WalletWarmupSessionProviderError('untrusted provider detail');
    });
    const factory = vi.fn(() => callback),
      input = f.input();
    const saved = await prepare(
      f.db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      factory,
    );
    expect(saved.outcome?.kind).toBe('refused');
    expect(callback).toHaveBeenCalledOnce();
    expect(await f.counts()).toEqual([1, 1, 1]);
    expect(
      (await prepare(f.db, 'owner', input, true, signal(), undefined, factory))
        .lease.id,
    ).toBe(input.id);
    expect(callback).toHaveBeenCalledOnce();
    expect(JSON.stringify(project(saved))).not.toContain(
      'untrusted provider detail',
    );
    expect(await read(f.db, 'other', input.id, signal())).toBeNull();
    expect(project(saved)).toMatchObject({
      executionAllowed: false,
      signingAllowed: false,
      automaticExecutionAllowed: false,
      instructionsVerified: false,
    });
  } finally {
    f.client.close();
  }
});
it('concurrent identical requests retain one lease and invoke the provider once', async () => {
  const f = await warmupSessionV2AttemptFixture();
  try {
    const callback = vi.fn(async () => {
        throw new WalletWarmupSessionProviderError('synthetic refusal');
      }),
      factory = () => callback,
      input = f.input();
    const results = await Promise.all([
      prepare(f.db, 'owner', input, true, signal(), 'synthetic-key', factory),
      prepare(f.db, 'owner', input, true, signal(), 'synthetic-key', factory),
    ]);
    expect(results.map((r) => r.lease.id)).toEqual([input.id, input.id]);
    expect(callback).toHaveBeenCalledOnce();
    expect(await f.counts()).toEqual([1, 1, 1]);
  } finally {
    f.client.close();
  }
});
it('concurrent different IDs cannot consume a second lease or provider call', async () => {
  const f = await warmupSessionV2AttemptFixture();
  try {
    const callback = vi.fn(async () => {
        throw new WalletWarmupSessionProviderError('synthetic refusal');
      }),
      factory = () => callback;
    const results = await Promise.allSettled([
      prepare(
        f.db,
        'owner',
        f.input(),
        true,
        signal(),
        'synthetic-key',
        factory,
      ),
      prepare(
        f.db,
        'owner',
        f.input(),
        true,
        signal(),
        'synthetic-key',
        factory,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(callback).toHaveBeenCalledOnce();
    expect(await f.counts()).toEqual([1, 1, 1]);
  } finally {
    f.client.close();
  }
});
it.each(['pause', 'stop'] as const)(
  'a %s during provider work remains available and prevents outcome publication',
  async (control) => {
    const f = await warmupSessionV2AttemptFixture();
    try {
      const saved = await prepare(
        f.db,
        'owner',
        f.input(),
        true,
        signal(),
        'synthetic-key',
        () => async () => {
          await f.append(control);
          throw new WalletWarmupSessionProviderError('synthetic refusal');
        },
      );
      expect(saved.outcome).toBeNull();
      expect(
        saved.journal.snapshot[control === 'stop' ? 'stopped' : 'paused'],
      ).toBe(true);
      expect(await f.counts()).toEqual([1, 0, 1]);
    } finally {
      f.client.close();
    }
  },
);
it.each(['plan', 'wallet', 'swap', 'execution', 'buy', 'sell'] as const)(
  'refuses changed %s state before retaining a lease',
  async (change) => {
    const f = await warmupSessionV2AttemptFixture();
    try {
      const planId = f.journal.manifest.planId,
        wallet = f.journal.manifest.wallets[0].wallet;
      if (change === 'plan')
        await f.db.prepare('UPDATE wallet_warmup_plans SET archived=1').run();
      if (change === 'wallet')
        await f.db
          .prepare('UPDATE workspace_wallets SET revision=revision+1')
          .run();
      if (change === 'swap')
        await f.db
          .prepare('INSERT INTO solana_swap_reservations VALUES(?,?,?,?)')
          .bind('owner', 'synthetic', wallet, 'unknown')
          .run();
      if (change === 'execution')
        await f.db
          .prepare('INSERT INTO solana_execution_reservations VALUES(?,?,?)')
          .bind('owner', wallet, 'unknown')
          .run();
      if (change === 'buy')
        await f.db
          .prepare(
            'INSERT INTO warmup_buy_receipts(owner_id,plan_id,id,document) VALUES(?,?,?,?)',
          )
          .bind('owner', planId, 'new-buy', '{}')
          .run();
      if (change === 'sell')
        await f.db
          .prepare(
            'INSERT INTO warmup_sell_receipts(owner_id,plan_id,id,document) VALUES(?,?,?,?)',
          )
          .bind('owner', planId, 'new-sell', '{}')
          .run();
      const factory = vi.fn(refusingFactory);
      await expect(
        prepare(
          f.db,
          'owner',
          f.input(),
          true,
          signal(),
          'synthetic-key',
          factory,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(factory).not.toHaveBeenCalled();
      expect(await f.counts()).toEqual([0, 0, 0]);
    } finally {
      f.client.close();
    }
  },
);
it('refuses direct manual preparation, intent and receipt reuse after an immutable attempt exists', async () => {
  const f = await warmupSessionV2AttemptFixture();
  try {
    const input = f.input();
    await prepare(
      f.db,
      'owner',
      input,
      true,
      signal(),
      'synthetic-key',
      refusingFactory,
    );
    const at = new Date().toISOString(),
      wallet = f.journal.manifest.wallets[0].wallet;
    await expect(
      f.db
        .prepare(
          'INSERT INTO warmup_swap_preparations VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .bind(input.id, 'owner', f.plan.id, 1, 1, wallet, 1, '{}', at)
        .run(),
    ).rejects.toThrow('not manual');
    await expect(
      f.db
        .prepare(
          'INSERT INTO warmup_signing_intents(id,owner_id,preparation_id,wallet_address,document,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(
          crypto.randomUUID(),
          'owner',
          input.id,
          wallet,
          '{}',
          'cancelled',
          at,
          at,
        )
        .run(),
    ).rejects.toThrow('signing is not enabled');
    for (const table of ['warmup_buy_receipts', 'warmup_sell_receipts'])
      await expect(
        f.db
          .prepare(
            `INSERT INTO ${table}(owner_id,plan_id,id,preparation_id,document) VALUES(?,?,?,?,?)`,
          )
          .bind('owner', f.plan.id, crypto.randomUUID(), input.id, '{}')
          .run(),
      ).rejects.toThrow('settlement is not enabled');
    await expect(
      f.db.prepare('DELETE FROM wallet_warmup_session_v2_attempts').run(),
    ).rejects.toThrow('immutable');
    await expect(
      f.db
        .prepare(
          'UPDATE wallet_warmup_session_v2_attempt_outcomes SET refusal_code=?',
        )
        .bind('evidence-refused')
        .run(),
    ).rejects.toThrow('immutable');
  } finally {
    f.client.close();
  }
});
it('an already used ordinary preparation ID cannot become a v2 request', async () => {
  const f = await warmupSessionV2AttemptFixture();
  try {
    const input = f.input(),
      wallet = f.journal.manifest.wallets[0].wallet;
    await f.db
      .prepare('INSERT INTO warmup_swap_preparations VALUES(?,?,?,?,?,?,?,?,?)')
      .bind(
        input.id,
        'owner',
        f.plan.id,
        1,
        1,
        wallet,
        1,
        '{}',
        new Date().toISOString(),
      )
      .run();
    const factory = vi.fn(refusingFactory);
    await expect(
      prepare(f.db, 'owner', input, true, signal(), 'synthetic-key', factory),
    ).rejects.toMatchObject({ status: 409 });
    expect(factory).not.toHaveBeenCalled();
    expect(await f.counts()).toEqual([0, 0, 0]);
  } finally {
    f.client.close();
  }
});
it('a busy owner gate refuses before a lease or provider request is retained', async () => {
  const f = await warmupSessionV2AttemptFixture();
  try {
    await f.db
      .prepare('INSERT INTO wallet_balance_gates VALUES(?,?)')
      .bind('owner', Date.now() + 30000)
      .run();
    const factory = vi.fn();
    await expect(
      prepare(
        f.db,
        'owner',
        f.input(),
        true,
        signal(),
        'synthetic-key',
        factory,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(factory).not.toHaveBeenCalled();
    expect(await f.counts()).toEqual([0, 0, 1]);
  } finally {
    f.client.close();
  }
});
it('a pending original lease is recoverable after cancellation, and a competing ID cannot start another provider', async () => {
  const f = await warmupSessionV2AttemptFixture();
  try {
    const controller = new AbortController(),
      factory = vi.fn(() => async () => {
        controller.abort();
        throw new Error('cancelled');
      }),
      input = f.input();
    const saved = await prepare(
      f.db,
      'owner',
      input,
      true,
      controller.signal,
      'synthetic-key',
      factory,
    );
    expect(saved.outcome).toBeNull();
    expect(await f.counts()).toEqual([1, 0, 1]);
    await expect(
      prepare(
        f.db,
        'owner',
        f.input(),
        true,
        signal(),
        'synthetic-key',
        factory,
      ),
    ).rejects.toMatchObject({ recoveryId: input.id });
    expect(factory).toHaveBeenCalledOnce();
    expect((await read(f.db, 'owner', input.id, signal()))?.lease).toEqual(
      saved.lease,
    );
    await f.append('stop');
    expect((await read(f.db, 'owner', input.id, signal()))?.lease).toEqual(
      saved.lease,
    );
  } finally {
    f.client.close();
  }
});
