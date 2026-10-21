import { z } from 'zod';
import {
  warmupJournalView,
  type WarmupJournalView,
  type WarmupJournalContext,
} from './wallet-warmup-session-journal-view';

const schema = z
  .object({
    format: z.literal('warmup-preparation-request-v1'),
    id: z.uuid().refine((v) => v === v.toLowerCase()),
    consentId: z.uuid(),
    termsSha256: z.string().regex(/^[a-f0-9]{64}$/),
    journal: z.unknown(),
  })
  .strict();
export type WarmupPreparationRequest = Omit<
  z.infer<typeof schema>,
  'journal'
> & { journal: WarmupJournalView };
/** Persist the original admitted head, not just an ID: later journal heads cannot replace it. */
export async function warmupPreparationRequest(
  value: unknown,
  context: WarmupJournalContext,
): Promise<WarmupPreparationRequest> {
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 81920)
      throw Error();
    const m = schema.parse(value);
    if (
      m.consentId !== context.consentId ||
      m.termsSha256 !== context.termsSha256
    )
      throw Error();
    const journal = await warmupJournalView({ journal: m.journal }, context);
    if (
      journal.version < 1 ||
      journal.version > 4095 ||
      journal.snapshot.pending?.state !== 'reviewing' ||
      journal.snapshot.paused ||
      journal.snapshot.stopped
    )
      throw Error();
    return { ...m, journal };
  } catch {
    throw Error(
      'The original preparation reminder is unavailable. Keep its request ID and recover before another preparation.',
    );
  }
}
export function warmupPreparationIdentity(m: WarmupPreparationRequest) {
  return {
    id: m.id,
    journalId: m.journal.id,
    version: m.journal.version,
    headSha256: m.journal.headSha256,
  };
}
export function warmupPreparationRequestBody(m: WarmupPreparationRequest) {
  return { ...warmupPreparationIdentity(m), prepareRequested: true };
}
