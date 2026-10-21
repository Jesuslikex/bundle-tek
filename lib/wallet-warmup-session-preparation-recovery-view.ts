import { z } from 'zod';
import {
  warmupJournalView,
  type WarmupJournalContext,
  type WarmupJournalView,
} from './wallet-warmup-session-journal-view';
import { warmupPreparationView } from './wallet-warmup-session-preparation-view';
import { warmupPreparationRequest } from './wallet-warmup-session-preparation-request';

/** Display-only historical recovery. The server verifies the full journal and prefix;
 * neither a supplied ID nor this projection is a signing/POST authorization. */
export async function warmupPreparationRecoveryView(
  value: unknown,
  expected: {
    id?: string;
    discover?: true;
    journal: WarmupJournalView;
    priorRequestId?: string;
  },
  context: WarmupJournalContext,
) {
  try {
    if ((typeof expected.id === 'string') === (expected.discover === true))
      throw Error();
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536)
      throw Error();
    const r = z
      .object({
        recovery: z
          .object({
            readOnly: z.literal(true),
            preparation: z.unknown(),
            originalJournal: z.unknown(),
            currentJournal: z.unknown(),
          })
          .strict(),
      })
      .strict()
      .parse(value).recovery;
    const original = await warmupJournalView(
      { journal: r.originalJournal },
      context,
      { id: expected.journal.id },
    );
    const current = await warmupJournalView(
      { journal: r.currentJournal },
      context,
      { id: expected.journal.id, previous: expected.journal },
    );
    if (
      original.version > current.version ||
      original.createdAt !== current.createdAt ||
      (original.version === current.version &&
        original.headSha256 !== current.headSha256)
    )
      throw Error();
    const selected =
      expected.id ??
      z
        .object({ id: z.uuid().refine((v) => v === v.toLowerCase()) })
        .loose()
        .parse(r.preparation).id;
    if (
      expected.discover &&
      (!current.snapshot.pending ||
        current.snapshot.pending.action.id !==
          original.snapshot.pending?.action.id)
    )
      throw Error();
    const identity = {
      id: selected,
      journalId: original.id,
      version: original.version,
      headSha256: original.headSha256,
    };
    const preparation = warmupPreparationView(
      { preparation: r.preparation },
      identity,
      original,
      context,
    );
    const request = await warmupPreparationRequest(
      {
        format: 'warmup-preparation-request-v3',
        id: selected,
        consentId: context.consentId,
        termsSha256: context.termsSha256,
        journal: original,
        recovered: true,
        ...(expected.priorRequestId && expected.priorRequestId !== selected
          ? { priorRequestId: expected.priorRequestId }
          : {}),
      },
      context,
    );
    return { preparation, request, current };
  } catch {
    throw Error(
      'Saved recovery context is unavailable or differs from this plan approval. Nothing was renewed or sent.',
    );
  }
}
