import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { walletRequest } from '@/lib/wallet-request';
import { canonicalPumpHolderJson as canonical } from '@/lib/pump-holder-review';
import {
  readWalletWarmupSessionJournal as read,
  retainWalletWarmupSessionJournal as retain,
  appendWalletWarmupSessionJournal as append,
  WalletWarmupJournalError,
} from '@/lib/wallet-warmup-session-journal-storage';
import { publicWalletWarmupSessionJournal as project } from '@/lib/wallet-warmup-session-journal-public';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const uuid = z.uuid().refine((v) => v === v.toLowerCase());
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const body = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('record'),
      id: uuid,
      consentId: uuid,
      termsSha256: hash,
      recordRequested: z.literal(true),
    })
    .strict(),
  z
    .object({
      operation: z.literal('control'),
      id: uuid,
      journalId: uuid,
      expectedVersion: z.number().int().min(0).max(4095),
      expectedHeadSha256: hash,
      control: z.enum(['begin-review', 'pause', 'resume', 'stop']),
    })
    .strict(),
]);
const cancelled = () =>
  json(
    {
      error:
        'Request cancelled. Recover the same journal and command ID before trying again.',
    },
    408,
  );
function failure(error: unknown, request: Request) {
  if (request.signal.aborted) return cancelled();
  if (error instanceof z.ZodError)
    return json({ error: 'Choose the exact saved session and command.' }, 400);
  if (error instanceof WalletWarmupJournalError)
    return json({ error: error.message }, error.status);
  return json(
    {
      error:
        'Warmup recovery unavailable. Keep the original journal and command ID; recover before another write.',
    },
    503,
  );
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user)
    return json({ error: 'Sign in to recover a warmup session.' }, 401);
  const params = new URL(request.url).searchParams;
  const byConsent = params.has('consentId');
  const id = uuid.safeParse(params.get(byConsent ? 'consentId' : 'id'));
  const eventId = params.has('eventId')
    ? uuid.safeParse(params.get('eventId'))
    : null;
  if (
    !id.success ||
    eventId?.success === false ||
    [...params.keys()].some(
      (k) => k !== 'id' && k !== 'consentId' && k !== 'eventId',
    ) ||
    params.getAll('id').length + params.getAll('consentId').length !== 1 ||
    params.getAll('eventId').length > 1
  )
    return json(
      {
        error:
          'Choose one journal or plan approval ID and optionally one command ID.',
      },
      400,
    );
  if (request.signal.aborted) return cancelled();
  try {
    const db = getD1();
    let journalId = id.data;
    if (byConsent) {
      const found = await db
        .prepare(
          'SELECT id FROM wallet_warmup_session_journals WHERE owner_id=? AND consent_id=?',
        )
        .bind(user.userId, id.data)
        .first<{ id: string }>();
      request.signal.throwIfAborted();
      if (!found)
        return json(
          { error: 'Warmup session not found for this account.' },
          404,
        );
      if (!uuid.safeParse(found.id).success)
        throw new WalletWarmupJournalError(
          'Retained warmup recovery identity is unavailable.',
          503,
        );
      journalId = found.id;
    }
    const journal = await read(db, user.userId, journalId, request.signal);
    if (journal && byConsent && journal.consentId !== id.data)
      throw new WalletWarmupJournalError(
        'Retained warmup recovery identity differs.',
        503,
      );
    if (request.signal.aborted) return cancelled();
    return journal
      ? json({ journal: project(journal, eventId?.data) })
      : json({ error: 'Warmup session not found for this account.' }, 404);
  } catch (error) {
    return failure(error, request);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to record warmup recovery.' }, 401);
  if (request.headers.get('origin') !== new URL(request.url).origin)
    return json({ error: 'Same-origin request required.' }, 403);
  if (
    request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    return json({ error: 'JSON required.' }, 415);
  if (request.signal.aborted) return cancelled();
  let input: z.infer<typeof body>;
  try {
    input = body.parse(await walletRequest(request, 2048));
  } catch (error) {
    if (request.signal.aborted) return cancelled();
    const large =
      error instanceof Error && error.message === 'Wallet request too large.';
    return json(
      {
        error: large
          ? 'Request too large.'
          : 'Choose the exact saved session and command.',
      },
      large ? 413 : 400,
    );
  }
  if (request.signal.aborted) return cancelled();
  try {
    const db = getD1();
    if (input.operation === 'record') {
      const { operation: _operation, recordRequested, ...selection } = input;
      const journal = await retain(
        db,
        user.userId,
        selection,
        recordRequested,
        request.signal,
      );
      if (request.signal.aborted) return cancelled();
      return json({ journal: project(journal) });
    }
    const { operation: _operation, control, ...selection } = input;
    const current = await read(
      db,
      user.userId,
      input.journalId,
      request.signal,
    );
    if (!current)
      return json({ error: 'Warmup session not found for this account.' }, 404);
    const prior = current.events.find((e) => e.id === input.id);
    if (
      !prior &&
      (current.snapshot.stopped ||
        (control === 'pause' && current.snapshot.paused) ||
        (control === 'resume' && !current.snapshot.paused))
    )
      throw new WalletWarmupJournalError(
        'This session cannot accept that control. Recover its current state.',
      );
    let command: { operation: typeof control; actionId?: string } = {
      operation: control,
    };
    if (control === 'begin-review') {
      if (prior) {
        const document = JSON.parse(prior.document);
        if (
          document.operation !== 'begin-review' ||
          typeof document.actionId !== 'string'
        )
          throw new WalletWarmupJournalError(
            'This command ID already belongs to another action.',
          );
        command = { operation: control, actionId: document.actionId };
      } else {
        if (current.snapshot.phase !== 'review-required')
          throw new WalletWarmupJournalError(
            'Recover pending work or wait for the next review. No signing is enabled.',
          );
        const begun = new Set(
          current.events
            .map((e) => JSON.parse(e.document))
            .filter((e) => e.operation === 'begin-review')
            .map((e) => e.actionId),
        );
        const actions = JSON.parse(current.sourceDocument).review.actions as {
          id: string;
        }[];
        const next = actions.find((a) => !begun.has(a.id));
        if (!next)
          throw new WalletWarmupJournalError(
            'No action is available for review.',
          );
        const live = await db
          .prepare(
            "SELECT document,updated_at FROM wallet_warmup_plans p WHERE owner_id=? AND id=? AND revision=? AND archived=0 AND (SELECT COUNT(*) FROM json_each(json_extract(p.document,'$.walletRevisions')) j JOIN workspace_wallets w ON w.address=json_extract(j.value,'$.address') AND w.revision=json_extract(j.value,'$.revision') WHERE w.owner_id=p.owner_id AND w.chain=json_extract(p.document,'$.chain') AND w.archived=0)=json_array_length(json_extract(p.document,'$.addresses'))",
          )
          .bind(user.userId, current.plan.id, current.plan.revision)
          .first<{ document: string; updated_at: string }>();
        request.signal.throwIfAborted();
        if (
          !live ||
          canonical(JSON.parse(live.document)) !==
            canonical(current.plan.document) ||
          live.updated_at !== current.plan.updatedAt
        )
          throw new WalletWarmupJournalError(
            'Saved plan or wallets changed. Request a fresh session review.',
          );
        command = { operation: control, actionId: next.id };
      }
    }
    const journal = await append(
      db,
      user.userId,
      { ...selection, command },
      request.signal,
    );
    if (request.signal.aborted) return cancelled();
    return json({ journal: project(journal, input.id) });
  } catch (error) {
    return failure(error, request);
  }
}
