import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import {
  createJitoBundle,
  readJitoBundle,
  registerJitoPacket,
  submitJitoBundle,
  cancelJitoBundle,
  observeJitoBundle,
} from '@/lib/jito-bundle-server';
import { POST as recoverImportedApproval } from '../signing/route';
import { prepareJitoBundle } from '@/lib/jito-bundle-preparation';
import { JitoJsonError, readJitoJson } from '@/lib/jito-json';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review Jito bundles.' }, 401);
  const params = new URL(request.url).searchParams;
  const projectId = params.get('projectId'),
    sessionId = params.get('sessionId');
  if (
    !projectId ||
    !UUID.test(projectId) ||
    !sessionId ||
    !UUID.test(sessionId)
  )
    return json({ error: 'Choose a saved project and session.' }, 400);
  try {
    const db = getD1();
    const owned = await db
      .prepare(
        'SELECT id FROM imported_trade_sessions WHERE owner_id=? AND id=? AND project_id=?',
      )
      .bind(user.userId, sessionId, projectId)
      .first();
    if (!owned) return json({ error: 'Owned session unavailable.' }, 404);
    const { results } = await db
      .prepare(
        'SELECT id FROM jito_bundles WHERE owner_id=? AND project_id=? AND session_id=? ORDER BY created_at DESC,id DESC LIMIT 20',
      )
      .bind(user.userId, projectId, sessionId)
      .all<{ id: string }>();
    const bundles = await Promise.all(
      results.map(
        async (r) => (await readJitoBundle(db, user.userId, r.id)).record,
      ),
    );
    const { results: eligible } = await db
      .prepare(
        "SELECT i.document FROM imported_swap_signing_intents i JOIN imported_swap_preparations p ON p.owner_id=i.owner_id AND p.id=i.preparation_id WHERE i.owner_id=? AND p.project_id=? AND json_extract(i.document,'$.session.sessionId')=? AND i.state='awaiting_signature' AND i.signature IS NULL AND julianday(json_extract(i.document,'$.expiresAt'))>julianday('now') AND NOT EXISTS(SELECT 1 FROM jito_bundle_packets bp WHERE bp.owner_id=i.owner_id AND bp.intent_id=i.id) ORDER BY json_extract(i.document,'$.session.entry') LIMIT 25",
      )
      .bind(user.userId, projectId, sessionId)
      .all<{ document: string }>();
    return json({
      projectId,
      sessionId,
      bundles,
      eligible: eligible.map((r) => JSON.parse(r.document)),
    });
  } catch {
    return json({ error: 'Jito bundle history unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to use Jito bundles.' }, 401);
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return json({ error: 'Cross-origin request rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return json({ error: 'JSON required.' }, 415);
  let body: {
    action: string;
    id: string;
    sha256: string;
    packet: number;
    transaction: string;
    projectId: string;
    sessionId: string;
    sessionRevision: number;
    intentIds: string[];
    entries: number[];
    tipLamports: string;
    approved?: boolean;
  };
  try {
    body = (await readJitoJson(
      request.body,
      AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
      4096,
    )) as typeof body;
    if (
      !body ||
      ![
        'prepare',
        'create',
        'register',
        'submit',
        'recover',
        'cancel',
      ].includes(body.action)
    )
      throw new Error();
    if (body.action === 'create' || body.action === 'prepare') {
      if (
        !UUID.test(body.projectId) ||
        !UUID.test(body.sessionId) ||
        !Number.isSafeInteger(body.sessionRevision) ||
        body.sessionRevision < 1
      )
        throw new Error();
    } else if (!UUID.test(body.id)) throw new Error();
    if (
      ['register', 'submit'].includes(body.action) &&
      (!/^[a-f0-9]{64}$/.test(body.sha256) || body.approved !== true)
    )
      throw new Error();
  } catch (error) {
    if (error instanceof JitoJsonError)
      return json({ error: error.message }, error.status);
    return json({ error: 'Invalid Jito bundle request.' }, 400);
  }
  try {
    const db = getD1(),
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(55000)]);
    if (['prepare', 'create', 'submit', 'recover'].includes(body.action)) {
      const now = Date.now();
      const gate = await db
        .prepare(
          'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
        )
        .bind(user.userId, now + 15000, now)
        .run();
      if (!gate.meta.changes)
        return json(
          { error: 'Wait 15 seconds between bundle provider reviews.' },
          429,
        );
    }
    let bundle;
    switch (body.action) {
      case 'prepare':
        bundle = await prepareJitoBundle(db, user.userId, body, signal);
        break;
      case 'create':
        bundle = await createJitoBundle(db, user.userId, body, signal);
        break;
      case 'register':
        bundle = await registerJitoPacket(
          db,
          user.userId,
          body.id,
          body.sha256,
          body.packet,
          body.transaction,
        );
        break;
      case 'submit':
        bundle = await submitJitoBundle(
          db,
          user.userId,
          body.id,
          body.sha256,
          signal,
        );
        break;
      case 'cancel':
        bundle = await cancelJitoBundle(db, user.userId, body.id);
        break;
      default:
        bundle = await observeJitoBundle(
          db,
          user.userId,
          body.id,
          signal,
          async (id) => {
            const response = await recoverImportedApproval(
              new Request(new URL('../signing', request.url), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ action: 'recover', id }),
                signal,
              }),
            );
            const result = (await response.json()) as {
              state?: string;
              receipt?: unknown;
            };
            return response.ok && result.state === 'finalized'
              ? result.receipt
              : null;
          },
        );
    }
    return json({ bundle });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // Only bounded app-authored validation messages leave the server. Never provider payloads/URLs.
    const safe =
      /^(Choose |Bundle |Current complete |Sign every |Signed bundles |Only entirely |Approval belongs |Owned bundle |Project or wallet |Approved swap |Preparation changed |Tip payer |Cancel unsigned |Finalized tip |Exact finalized |Packets landed |Jito and chain |Signature recovery |Historical transaction |Registered bundle |Stored bundle |Reviewed tip)/.test(
        message,
      ) && message.length <= 250;
    return json(
      {
        error: safe
          ? message
          : 'Bundle operation did not complete. Reload retained status before retrying. Submission is never retried automatically.',
      },
      409,
    );
  }
}
