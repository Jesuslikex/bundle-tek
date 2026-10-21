import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { warmupSessionProviderFixture } from '@/test/warmup-session-provider-fixture';
import {
  warmupSessionV2JournalFixture,
  anotherV2Journal,
  anotherLegacyJournal,
  v2JournalSignal as signal,
} from '@/test/warmup-session-v2-journal-fixture';
import {
  readWalletWarmupV2Journal,
  retainWalletWarmupV2Journal,
  appendWalletWarmupV2Journal,
  publicWalletWarmupV2Journal,
  warmupV2JournalControlFits as fits,
} from './wallet-warmup-session-v2-journal';
import { appendWalletWarmupSessionJournal } from './wallet-warmup-session-journal-storage';
import { prepareWalletWarmupSessionAction } from './wallet-warmup-session-preparation';
describe('versioned warmup saved session history', () => {
  it.each(['submitted', 'unknown'])(
    'preserves an unresolved legacy %s hold after Stop',
    async (operation) => {
      const f = await warmupSessionProviderFixture('0.01', false);
      try {
        for (const name of [
          '0132_wallet_warmup_session_v2_consents',
          '0133_wallet_warmup_session_v2_journals',
        ])
          for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8')
            .split('--> statement-breakpoint')
            .map((s) => s.trim())
            .filter(Boolean))
            await f.db.prepare(sql).run();
        if (operation === 'unknown')
          await f.append(
            'unknown',
            JSON.parse(f.journal.sourceDocument).review.actions[0].id,
          );
        const peer = await anotherV2Journal(f);
        await f.append('stop');
        await expect(
          appendWalletWarmupV2Journal(
            f.db,
            'owner',
            {
              id: crypto.randomUUID(),
              journalId: peer.id,
              version: 0,
              headSha256: peer.headSha256,
              control: 'begin-review',
            },
            signal(),
          ),
        ).rejects.toThrow('could not be confirmed');
      } finally {
        f.client.close();
      }
    },
  );
  it('reports a retryable clock disagreement without treating saved history as corrupt or extending it', async () => {
    const f = await warmupSessionV2JournalFixture();
    try {
      await expect(
        readWalletWarmupV2Journal(
          f.db,
          'owner',
          f.journal.id,
          signal(),
          Date.parse(f.journal.createdAt) - 1,
        ),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        (await readWalletWarmupV2Journal(f.db, 'owner', f.journal.id, signal()))
          ?.version,
      ).toBe(0);
    } finally {
      f.client.close();
    }
  });
  it('excludes a new legacy review until the overlapping v2 review is stopped', async () => {
    const f = await warmupSessionV2JournalFixture();
    try {
      const legacy = await anotherLegacyJournal(f);
      await f.append('begin-review');
      const input = {
        id: crypto.randomUUID(),
        journalId: legacy.id,
        expectedVersion: legacy.version,
        expectedHeadSha256: legacy.headSha256,
        command: {
          operation: 'begin-review',
          actionId: JSON.parse(legacy.sourceDocument).review.actions[0].id,
        },
      };
      await expect(
        appendWalletWarmupSessionJournal(f.db, 'owner', input, signal()),
      ).rejects.toThrow();
      await f.append('stop');
      expect(
        (await appendWalletWarmupSessionJournal(f.db, 'owner', input, signal()))
          .version,
      ).toBe(1);
    } finally {
      f.client.close();
    }
  });
  it('keeps an admitted legacy packet excluded after Stop even before submitted is recorded', async () => {
    const f = await warmupSessionProviderFixture();
    try {
      for (const name of [
        '0132_wallet_warmup_session_v2_consents',
        '0133_wallet_warmup_session_v2_journals',
      ])
        for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8')
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean))
          await f.db.prepare(sql).run();
      const peer = await anotherV2Journal(f);
      await prepareWalletWarmupSessionAction(
        f.db,
        'owner',
        {
          id: crypto.randomUUID(),
          journalId: f.journal.id,
          version: f.journal.version,
          headSha256: f.journal.headSha256,
        },
        signal(),
        async () => ({
          summary: structuredClone(f.packets.buy.preparation.document),
          transaction: f.packets.buy.approval.transaction,
        }),
        f.clock,
      );
      await f.append('stop');
      await expect(
        appendWalletWarmupV2Journal(
          f.db,
          'owner',
          {
            id: crypto.randomUUID(),
            journalId: peer.id,
            version: 0,
            headSha256: peer.headSha256,
            control: 'begin-review',
          },
          signal(),
        ),
      ).rejects.toThrow('could not be confirmed');
    } finally {
      f.client.close();
    }
  });
  it('excludes a live legacy review without blocking passive v2 history, and releases unsigned review on Stop', async () => {
    const f = await warmupSessionProviderFixture();
    try {
      for (const name of [
        '0132_wallet_warmup_session_v2_consents',
        '0133_wallet_warmup_session_v2_journals',
      ])
        for (const sql of readFileSync(`drizzle/${name}.sql`, 'utf8')
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean))
          await f.db.prepare(sql).run();
      const peer = await anotherV2Journal(f);
      const input = {
        id: crypto.randomUUID(),
        journalId: peer.id,
        version: peer.version,
        headSha256: peer.headSha256,
        control: 'begin-review',
      };
      await expect(
        appendWalletWarmupV2Journal(f.db, 'owner', input, signal()),
      ).rejects.toThrow('could not be confirmed');
      await f.append('stop');
      expect(
        (await appendWalletWarmupV2Journal(f.db, 'owner', input, signal()))
          .snapshot.phase,
      ).toBe('reviewing');
    } finally {
      f.client.close();
    }
  });
  it.each([false, true])(
    'recovers one committed event after lost reply (cancel=%s), without another insert',
    async (cancel) => {
      const f = await warmupSessionV2JournalFixture();
      try {
        const controller = new AbortController(),
          input = {
            id: crypto.randomUUID(),
            journalId: f.journal.id,
            version: 0,
            headSha256: f.journal.headSha256,
            control: 'pause',
          };
        let inserts = 0;
        const wrapped = {
          batch: f.db.batch.bind(f.db),
          prepare(sql: string) {
            const original = f.db.prepare(sql);
            if (
              !sql.startsWith(
                'INSERT INTO wallet_warmup_session_journal_events_v2',
              )
            )
              return original;
            return {
              bind(...args: unknown[]) {
                const bound = original.bind(...args);
                return {
                  async run() {
                    inserts++;
                    await bound.run();
                    if (cancel) controller.abort();
                    throw Error('Lost reply');
                  },
                };
              },
            };
          },
        } as D1Database;
        if (cancel)
          await expect(
            appendWalletWarmupV2Journal(
              wrapped,
              'owner',
              input,
              controller.signal,
            ),
          ).rejects.toThrow();
        else
          expect(
            (
              await appendWalletWarmupV2Journal(
                wrapped,
                'owner',
                input,
                controller.signal,
              )
            ).version,
          ).toBe(1);
        expect(
          (await appendWalletWarmupV2Journal(wrapped, 'owner', input, signal()))
            .version,
        ).toBe(1);
        expect(inserts).toBe(1);
      } finally {
        f.client.close();
      }
    },
  );
  it('allows passive peer history but excludes overlapping live reviews until Stop', async () => {
    const f = await warmupSessionV2JournalFixture();
    try {
      const peer = await anotherV2Journal(f);
      await f.append('begin-review');
      const input = {
        id: crypto.randomUUID(),
        journalId: peer.id,
        version: peer.version,
        headSha256: peer.headSha256,
        control: 'begin-review',
      };
      await expect(
        appendWalletWarmupV2Journal(f.db, 'owner', input, signal()),
      ).rejects.toThrow('could not be confirmed');
      await f.append('pause');
      await expect(
        appendWalletWarmupV2Journal(f.db, 'owner', input, signal()),
      ).rejects.toThrow('could not be confirmed');
      await f.append('stop');
      expect(
        (await appendWalletWarmupV2Journal(f.db, 'owner', input, signal()))
          .snapshot.phase,
      ).toBe('reviewing');
    } finally {
      f.client.close();
    }
  });
  it.each(['solana_swap_reservations', 'solana_execution_reservations'])(
    'blocks begin-review for %s and still allows Stop',
    async (table) => {
      const f = await warmupSessionV2JournalFixture();
      try {
        const wallet = f.journal.manifest.wallets[0].wallet;
        if (table === 'solana_swap_reservations')
          await f.db
            .prepare('INSERT INTO solana_swap_reservations VALUES(?,?,?,?)')
            .bind('owner', 'test-intent', wallet, 'unknown')
            .run();
        else
          await f.db
            .prepare('INSERT INTO solana_execution_reservations VALUES(?,?,?)')
            .bind('owner', wallet, 'unknown')
            .run();
        await expect(f.append('begin-review')).rejects.toThrow(
          'could not be confirmed',
        );
        expect((await f.append('stop')).journal.snapshot.phase).toBe('stopped');
      } finally {
        f.client.close();
      }
    },
  );
  it('retains Stop and recovery after the approved finish without renewing it', async () => {
    const f = await warmupSessionV2JournalFixture();
    try {
      const at = Date.parse(f.consent.terms.sessionExpiresAt) + 1;
      const journal = await readWalletWarmupV2Journal(
        f.db,
        'owner',
        f.journal.id,
        signal(),
        at,
      );
      expect(journal?.snapshot.phase).toBe('expired');
      const command = {
        id: crypto.randomUUID(),
        journalId: f.journal.id,
        version: 0,
        headSha256: f.journal.headSha256,
        control: 'begin-review',
      };
      await expect(
        appendWalletWarmupV2Journal(f.db, 'owner', command, signal(), () => at),
      ).rejects.toThrow('unavailable');
      const stopped = await appendWalletWarmupV2Journal(
        f.db,
        'owner',
        { ...command, control: 'stop' },
        signal(),
        () => at,
      );
      expect(stopped.snapshot.phase).toBe('stopped');
      expect(stopped.consent.terms.sessionExpiresAt).toBe(
        f.consent.terms.sessionExpiresAt,
      );
    } finally {
      f.client.close();
    }
  });
  it('records passive history and replays exact controls without advancing or granting authority', async () => {
    const f = await warmupSessionV2JournalFixture();
    try {
      expect(f.journal.version).toBe(0);
      expect(f.journal.snapshot.completedActions).toBe(0);
      await f.append('begin-review');
      await f.append('pause');
      await f.append('resume');
      const { input } = await f.append('stop');
      const saved = await readWalletWarmupV2Journal(
        f.db,
        'owner',
        f.journal.id,
        signal(),
      );
      expect(saved?.snapshot.phase).toBe('stopped');
      expect(saved?.version).toBe(4);
      const dto = publicWalletWarmupV2Journal(saved!, input.id);
      expect(dto.commandReceipt?.operation).toBe('stop');
      expect(dto.qualificationAvailable).toBe(false);
      expect(dto.signingAllowed).toBe(false);
      expect(dto).not.toHaveProperty('events');
      expect(dto).not.toHaveProperty('consent');
      expect(dto).not.toHaveProperty('manifest');
      expect(saved?.snapshot.pendingReview).not.toBeNull();
      await expect(f.append('resume')).rejects.toThrow('unavailable');
    } finally {
      f.client.close();
    }
  });
  it('requires explicit record request and scopes saved history to its owner', async () => {
    const f = await warmupSessionV2JournalFixture();
    try {
      await expect(
        retainWalletWarmupV2Journal(
          f.db,
          'owner',
          f.rootInput,
          false,
          signal(),
        ),
      ).rejects.toThrow('explicit');
      expect(
        await readWalletWarmupV2Journal(
          f.db,
          'someone_else',
          f.journal.id,
          signal(),
        ),
      ).toBeNull();
      expect(
        (
          await retainWalletWarmupV2Journal(
            f.db,
            'owner',
            f.rootInput,
            true,
            signal(),
          )
        ).id,
      ).toBe(f.journal.id);
      await expect(
        retainWalletWarmupV2Journal(
          f.db,
          'owner',
          { ...f.rootInput, id: crypto.randomUUID() },
          true,
          signal(),
        ),
      ).rejects.toMatchObject({ recoveryId: f.journal.id });
    } finally {
      f.client.close();
    }
  });
  it('recovers an original event after subsequent controls and refuses a changed binding', async () => {
    const f = await warmupSessionV2JournalFixture();
    try {
      const { input } = await f.append('begin-review');
      await f.append('pause');
      expect(
        (await appendWalletWarmupV2Journal(f.db, 'owner', input, signal()))
          .version,
      ).toBe(2);
      await expect(
        appendWalletWarmupV2Journal(
          f.db,
          'owner',
          { ...input, control: 'stop' },
          signal(),
        ),
      ).rejects.toThrow();
      await expect(f.append('begin-review')).rejects.toThrow('unavailable');
    } finally {
      f.client.close();
    }
  });
  it('preserves history and Stop after source drift but refuses a fresh review', async () => {
    const f = await warmupSessionV2JournalFixture();
    try {
      await f.db.prepare('UPDATE wallet_warmup_plans SET archived=1').run();
      expect(
        await readWalletWarmupV2Journal(f.db, 'owner', f.journal.id, signal()),
      ).not.toBeNull();
      await expect(f.append('begin-review')).rejects.toThrow(
        'could not be confirmed',
      );
      expect((await f.append('stop')).journal.snapshot.stopped).toBe(true);
    } finally {
      f.client.close();
    }
  });
  it('rejects stale heads and manual event/head deletion or replacement', async () => {
    const f = await warmupSessionV2JournalFixture();
    try {
      const version = f.journal.version,
        headSha256 = f.journal.headSha256;
      await f.append('pause');
      await expect(
        appendWalletWarmupV2Journal(
          f.db,
          'owner',
          {
            id: crypto.randomUUID(),
            journalId: f.journal.id,
            version,
            headSha256,
            control: 'stop',
          },
          signal(),
        ),
      ).rejects.toThrow('head changed');
      for (const table of [
        'wallet_warmup_session_journals_v2',
        'wallet_warmup_session_journal_events_v2',
        'wallet_warmup_session_journal_heads_v2',
      ]) {
        await expect(
          f.db.prepare(`DELETE FROM ${table}`).run(),
        ).rejects.toThrow();
      }
    } finally {
      f.client.close();
    }
  });
  it('reserves an event and byte capacity for terminal Stop', () => {
    expect(fits(65534, 0, 500, 'pause')).toBe(true);
    expect(fits(65535, 0, 500, 'pause')).toBe(false);
    expect(fits(65535, 0, 500, 'stop')).toBe(true);
    expect(fits(1, 33550336, 500, 'pause')).toBe(false);
    expect(fits(1, 33550336, 500, 'stop')).toBe(true);
    expect(fits(65536, 0, 500, 'stop')).toBe(false);
    expect(fits(1, 0, 2049, 'stop')).toBe(false);
  });
});
