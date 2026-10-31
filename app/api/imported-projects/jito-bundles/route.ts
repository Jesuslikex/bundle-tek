import { checkJitoBundleSequential } from '@/lib/jito-sequential-check-server';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { UUID } from '@/lib/wallet-operation';
import {
  createJitoBundle,
  readJitoBundle,
  submitJitoBundle,
  cancelJitoBundle,
  observeJitoBundleWithObservation,
} from '@/lib/jito-bundle-server';
import {
  beginJitoSignAttempt,
  listJitoSignAttempts,
  readJitoSignAttempt,
  registerJitoSignAttempt,
} from '@/lib/jito-sign-attempt-server';
import { POST as recoverImportedApproval } from '../signing/route';
import { prepareJitoBundle } from '@/lib/jito-bundle-preparation';
import { JitoJsonError, readJitoJson } from '@/lib/jito-json';
import { JITO_RUNTIME_SIGNING_ENABLED } from '@/lib/jito-cpmm-unsigned-review';
import {
  JITO_OWNER_SCOPE_HEADER,
  jitoOwnerScope,
} from '@/lib/jito-owner-scope';
export const dynamic = 'force-dynamic';
const json = (value: unknown, status = 200, ownerScope?: string) =>
  Response.json(value, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(ownerScope ? { [JITO_OWNER_SCOPE_HEADER]: ownerScope } : {}),
    },
  });
async function scopeFor(request: Request, ownerId: string) {
  const scope = await jitoOwnerScope(ownerId);
  const expected = request.headers.get(JITO_OWNER_SCOPE_HEADER);
  return { scope, matches: expected === null || expected === scope };
}
export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to review Jito bundles.' }, 401);
  let scoped: Awaited<ReturnType<typeof scopeFor>>;
  try {
    scoped = await scopeFor(request, user.userId);
  } catch {
    return json({ error: 'Jito account scope unavailable.' }, 503);
  }
  const reply = (value: unknown, status = 200) =>
    json(value, status, scoped.scope);
  if (!scoped.matches)
    return reply(
      { error: 'Signed-in account changed. Reload bundle history.' },
      409,
    );
  const params = new URL(request.url).searchParams;
  const projectId = params.get('projectId'),
    sessionId = params.get('sessionId'),
    bundleId = params.get('bundleId');
  if (
    !projectId ||
    !UUID.test(projectId) ||
    !sessionId ||
    !UUID.test(sessionId) ||
    (bundleId !== null && !UUID.test(bundleId))
  )
    return reply({ error: 'Choose a saved project and session.' }, 400);
  try {
    const db = getD1();
    const owned = await db
      .prepare(
        'SELECT id FROM imported_trade_sessions WHERE owner_id=? AND id=? AND project_id=?',
      )
      .bind(user.userId, sessionId, projectId)
      .first();
    if (!owned) return reply({ error: 'Owned session unavailable.' }, 404);
    if (bundleId === null && request.headers.get('x-jito-protocol') !== '2') {
      const newer = await db
        .prepare(
          'SELECT 1 AS present FROM jito_bundles b JOIN jito_bundle_protocol v ON v.owner_id=b.owner_id AND v.bundle_id=b.id WHERE b.owner_id=? AND b.project_id=? AND b.session_id=? LIMIT 1',
        )
        .bind(user.userId, projectId, sessionId)
        .first();
      if (newer)
        return reply(
          {
            error:
              'Bundle client update required to see complete bundle history.',
          },
          409,
        );
    }
    if (bundleId !== null) {
      const ownedBundle = await db
        .prepare(
          'SELECT id FROM jito_bundles WHERE owner_id=? AND project_id=? AND session_id=? AND id=?',
        )
        .bind(user.userId, projectId, sessionId, bundleId)
        .first();
      if (!ownedBundle)
        return reply({ error: 'Owned bundle unavailable.' }, 404);
      const protocol = await db
        .prepare(
          'SELECT version FROM jito_bundle_protocol WHERE owner_id=? AND bundle_id=?',
        )
        .bind(user.userId, bundleId)
        .first<{ version: number }>();
      if (request.headers.get('x-jito-protocol') !== '2' && protocol)
        return reply(
          {
            error: 'Bundle client update required before opening this bundle.',
          },
          409,
        );
      const bundle = (await readJitoBundle(db, user.userId, bundleId)).record;
      const attempts =
        request.headers.get('x-jito-protocol') === '2' &&
        request.headers.get(JITO_OWNER_SCOPE_HEADER) === scoped.scope
          ? await listJitoSignAttempts(db, user.userId, bundleId)
          : undefined;
      return reply({
        projectId,
        sessionId,
        bundle,
        ...(attempts
          ? { attempts, legacyReadOnly: protocol?.version !== 2 }
          : {}),
      });
    }
    const { results } = await db
      .prepare(
        'SELECT b.id FROM jito_bundles b WHERE b.owner_id=? AND b.project_id=? AND b.session_id=? AND (?=2 OR NOT EXISTS(SELECT 1 FROM jito_bundle_protocol v WHERE v.owner_id=b.owner_id AND v.bundle_id=b.id)) ORDER BY b.created_at DESC,b.id DESC LIMIT 20',
      )
      .bind(
        user.userId,
        projectId,
        sessionId,
        request.headers.get('x-jito-protocol') === '2' ? 2 : 0,
      )
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
    return reply({
      projectId,
      sessionId,
      bundles,
      eligible: eligible.map((r) => JSON.parse(r.document)),
    });
  } catch {
    return reply({ error: 'Jito bundle history unavailable.' }, 503);
  }
}
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to use Jito bundles.' }, 401);
  let scoped: Awaited<ReturnType<typeof scopeFor>>;
  try {
    scoped = await scopeFor(request, user.userId);
  } catch {
    return json({ error: 'Jito account scope unavailable.' }, 503);
  }
  const reply = (value: unknown, status = 200) =>
    json(value, status, scoped.scope);
  if (!scoped.matches)
    return reply(
      { error: 'Signed-in account changed. Reload bundle history.' },
      409,
    );
  if (
    request.headers.get('origin') &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    return reply({ error: 'Cross-origin request rejected.' }, 403);
  if (
    !request.headers
      .get('content-type')
      ?.toLowerCase()
      .startsWith('application/json')
  )
    return reply({ error: 'JSON required.' }, 415);
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
    attemptId: string;
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
        'check-sequential',
        'begin-signing',
        'read-signing-attempt',
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
      body.action === 'check-sequential' &&
      (typeof body.id !== 'string' ||
        typeof body.sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(body.sha256))
    )
      throw new Error();
    if (
      ['register', 'submit', 'begin-signing'].includes(body.action) &&
      (!/^[a-f0-9]{64}$/.test(body.sha256) || body.approved !== true)
    )
      throw new Error();
    if (
      ['begin-signing', 'read-signing-attempt', 'register'].includes(
        body.action,
      ) &&
      (!UUID.test(body.attemptId) ||
        request.headers.get(JITO_OWNER_SCOPE_HEADER) !== scoped.scope)
    )
      throw new Error();
    if (
      ['begin-signing', 'register'].includes(body.action) &&
      (!Number.isSafeInteger(body.packet) || body.packet < 0)
    )
      throw new Error();
  } catch (error) {
    if (error instanceof JitoJsonError)
      return reply({ error: error.message }, error.status);
    return reply({ error: 'Invalid Jito bundle request.' }, 400);
  }
  if (
    [
      'prepare',
      'create',
      'register',
      'submit',
      'begin-signing',
      'read-signing-attempt',
    ].includes(body.action) &&
    request.headers.get('x-jito-protocol') !== '2'
  )
    return reply(
      { error: 'Bundle client update required before this operation.' },
      409,
    );
  // The current sequential check is unsigned and does not qualify the exact
  // registered signed vector at its simulation bank. Do not enter the sender
  // until a separate, verified qualification is wired here.
  if (body.action === 'begin-signing' && !JITO_RUNTIME_SIGNING_ENABLED)
    return reply(
      {
        error:
          'New Jito signing is disabled. Unsigned Raydium research evidence does not authorize a wallet prompt. Existing evidence recovery remains available.',
      },
      409,
    );
  if (body.action === 'submit')
    return reply(
      {
        error:
          'Jito bundle submission is unavailable until the exact signed transactions pass runtime qualification.',
      },
      409,
    );
  try {
    const db = getD1(),
      signal = AbortSignal.any([request.signal, AbortSignal.timeout(55000)]);
    if (
      ['prepare', 'create', 'submit', 'recover', 'check-sequential'].includes(
        body.action,
      )
    ) {
      const now = Date.now();
      const gate = await db
        .prepare(
          'INSERT INTO wallet_balance_gates(owner_id,next_allowed_at) VALUES (?,?) ON CONFLICT(owner_id) DO UPDATE SET next_allowed_at=excluded.next_allowed_at WHERE wallet_balance_gates.next_allowed_at<=?',
        )
        .bind(user.userId, now + 15000, now)
        .run();
      if (!gate.meta.changes)
        return reply(
          { error: 'Wait 15 seconds between bundle provider reviews.' },
          429,
        );
    }
    let bundle;
    switch (body.action) {
      case 'check-sequential':
        return reply({
          sequentialCheck: await checkJitoBundleSequential(
            db,
            user.userId,
            { id: body.id, sha256: body.sha256 },
            signal,
          ),
        });
      case 'prepare':
        bundle = await prepareJitoBundle(db, user.userId, body, signal);
        break;
      case 'create':
        bundle = await createJitoBundle(db, user.userId, body, signal);
        break;
      case 'register':
        bundle = await registerJitoSignAttempt(
          db,
          user.userId,
          body.id,
          body.sha256,
          body.packet,
          body.attemptId,
          body.transaction,
        );
        break;
      case 'begin-signing':
        return reply(
          await beginJitoSignAttempt(
            db,
            user.userId,
            body.id,
            body.sha256,
            body.packet,
            body.attemptId,
          ),
        );
      case 'read-signing-attempt': {
        const attempt = await readJitoSignAttempt(
          db,
          user.userId,
          body.attemptId,
        );
        if (!attempt || attempt.bundleId !== body.id)
          return reply({ error: 'Owned bundle attempt unavailable.' }, 404);
        return reply({ attempt });
      }
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
      default: {
        const recovered = await observeJitoBundleWithObservation(
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
        return reply({
          bundle: recovered.record,
          ...(recovered.observation
            ? { chainObservation: recovered.observation }
            : {}),
        });
      }
    }
    return reply({ bundle });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // Only bounded app-authored validation messages leave the server. Never provider payloads/URLs.
    const safe =
      message === 'Sequential check context changed or unavailable.' ||
      (/^(Choose |Bundle |Current complete |Sign every |Signed bundles |Only entirely |Approval belongs |Owned bundle |Project or wallet |Approved swap |Preparation changed |Tip payer |Cancel unsigned |Finalized tip |Exact finalized |Packets landed |Jito and chain |Signature recovery |Historical transaction |Registered bundle |Stored bundle |Reviewed tip)/.test(
        message,
      ) &&
        message.length <= 250);
    return reply(
      {
        error: safe
          ? message
          : 'Bundle operation did not complete. Reload retained status before retrying. Submission is never retried automatically.',
      },
      409,
    );
  }
}
