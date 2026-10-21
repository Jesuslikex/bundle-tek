import { it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  warmupSessionV2JournalFixture,
  v2JournalSignal as signal,
} from '@/test/warmup-session-v2-journal-fixture';
import { canonicalPumpHolderJson as canonical } from './pump-holder-review';
import {
  appendWalletWarmupV2Journal,
  readWalletWarmupV2Journal,
} from './wallet-warmup-session-v2-journal';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
// Capacity replay fixture is seeded BEFORE 0133 triggers are installed. This is
// not evidence for 65k API writes or funded execution. Final Stop uses all real
// production triggers and the same bounded reader/complete hash replay.
it.skipIf(process.env.BUNDLE_WARMUP_CAPACITY_QA !== '1')(
  'replays the full 65,535-event prefix and appends the reserved final Stop',
  async () => {
    let journalId = '',
      lastHash = '',
      bytes = 0;
    const f = await warmupSessionV2JournalFixture(
      async (db, client, consent) => {
        journalId = crypto.randomUUID();
        const at = consent.createdAt;
        lastHash = sha(
          canonical([
            'wallet-warmup-session-journal-v2',
            journalId,
            consent.id,
            consent.termsSha256,
            at,
          ]),
        );
        await db
          .prepare(
            'INSERT INTO wallet_warmup_session_journals_v2 VALUES(?,?,?,?,?,?,?)',
          )
          .bind(
            'owner',
            journalId,
            consent.id,
            consent.terms.reviewId,
            consent.termsSha256,
            lastHash,
            at,
          )
          .run();
        for (let first = 1; first <= 65535; first += 256) {
          const statements = [];
          for (
            let version = first;
            version <= Math.min(65535, first + 255);
            version++
          ) {
            const id = crypto.randomUUID(),
              document = canonical({
                format: 'wallet-warmup-session-event-v2',
                eventId: id,
                version,
                previousSha256: lastHash,
                at,
                operation: version % 2 ? 'pause' : 'resume',
              });
            const next = sha(document);
            bytes += Buffer.byteLength(document);
            statements.push({
              sql: 'INSERT INTO wallet_warmup_session_journal_events_v2 VALUES(?,?,?,?,?,?,?,?)',
              args: [
                'owner',
                journalId,
                id,
                version,
                lastHash,
                document,
                next,
                at,
              ],
            });
            lastHash = next;
          }
          await client.batch(statements, 'write');
        }
        await db
          .prepare(
            'INSERT INTO wallet_warmup_session_journal_heads_v2 VALUES(?,?,?,?,?,?)',
          )
          .bind('owner', journalId, 65535, lastHash, bytes, at)
          .run();
      },
    );
    try {
      expect(f.journal.version).toBe(65535);
      expect(f.journal.documentBytes).toBe(bytes);
      const stopped = await appendWalletWarmupV2Journal(
        f.db,
        'owner',
        {
          id: crypto.randomUUID(),
          journalId,
          version: 65535,
          headSha256: lastHash,
          control: 'stop',
        },
        signal(),
      );
      expect(stopped.version).toBe(65536);
      expect(stopped.snapshot.phase).toBe('stopped');
      expect(
        (await readWalletWarmupV2Journal(f.db, 'owner', journalId, signal()))
          ?.headSha256,
      ).toBe(stopped.headSha256);
    } finally {
      f.client.close();
    }
  },
  120000,
);
