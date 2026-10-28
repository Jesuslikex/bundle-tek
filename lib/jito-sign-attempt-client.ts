import bs58 from 'bs58';
import { JITO_OWNER_SCOPE_HEADER } from './jito-owner-scope';
import { readBoundedPanelJson } from './read-bounded-panel-json';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ENDPOINT = '/api/imported-projects/jito-bundles';
const UNAVAILABLE = 'Signing attempt unavailable. Reload recovery history.';

export type JitoAttemptIdentity = Readonly<{
  ownerScope: string;
  bundleId: string;
  digest: string;
  packet: number;
  signer: string;
  intentId: string | null;
  attemptId: string;
}>;

export type JitoAttempt = Readonly<{
  bundleId: string;
  manifestSha256: string;
  packet: number;
  signer: string;
  intentId: string | null;
  attemptId: string;
  state: 'unknown' | 'registered';
  signature: string | null;
  transaction: string | null;
}>;

function unavailable(): never {
  throw new Error(UNAVAILABLE);
}

function base58Bytes(value: unknown, length: number): Uint8Array | null {
  if (typeof value !== 'string' || value.length > 90) return null;
  try {
    const bytes = bs58.decode(value);
    return bytes.length === length && bs58.encode(bytes) === value
      ? bytes
      : null;
  } catch {
    return null;
  }
}

function checkIdentity(value: JitoAttemptIdentity): JitoAttemptIdentity {
  if (
    !value ||
    !/^[a-f0-9]{64}$/.test(value.ownerScope) ||
    !UUID.test(value.bundleId) ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    !Number.isInteger(value.packet) ||
    value.packet < 0 ||
    value.packet > 4 ||
    !base58Bytes(value.signer, 32) ||
    (value.intentId !== null && !UUID.test(value.intentId)) ||
    !UUID.test(value.attemptId)
  )
    return unavailable();
  return Object.freeze({ ...value });
}

/** Response bytes are not proof of a signature or an on-chain result. Any
 * registration/recovery flow must separately verify the exact signed packet. */
function checkedAttempt(
  raw: unknown,
  expected: JitoAttemptIdentity,
): JitoAttempt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return unavailable();
  const value = raw as Record<string, unknown>;
  if (
    value.bundleId !== expected.bundleId ||
    value.manifestSha256 !== expected.digest ||
    value.packet !== expected.packet ||
    value.signer !== expected.signer ||
    value.intentId !== expected.intentId ||
    value.attemptId !== expected.attemptId
  )
    return unavailable();
  if (value.state === 'unknown') {
    if (value.signature !== null || value.transaction !== null)
      return unavailable();
  } else if (value.state === 'registered') {
    const signature = base58Bytes(value.signature, 64);
    if (
      !signature ||
      typeof value.transaction !== 'string' ||
      value.transaction.length < 88 ||
      value.transaction.length > 1644 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        value.transaction,
      )
    )
      return unavailable();
    try {
      const rawTransaction = atob(value.transaction);
      if (
        rawTransaction.length < 65 ||
        rawTransaction.length > 1232 ||
        rawTransaction.charCodeAt(0) !== 1 ||
        signature.some((byte, i) => rawTransaction.charCodeAt(i + 1) !== byte)
      )
        return unavailable();
    } catch {
      return unavailable();
    }
  } else return unavailable();
  return Object.freeze({
    bundleId: expected.bundleId,
    manifestSha256: expected.digest,
    packet: expected.packet,
    signer: expected.signer,
    intentId: expected.intentId,
    attemptId: expected.attemptId,
    state: value.state as JitoAttempt['state'],
    signature: value.signature as string | null,
    transaction: value.transaction as string | null,
  });
}

/** A one-use local permit, valid only after a newly inserted server attempt.
 * The trusted caller must hold the journal lock and persist UNKNOWN first. */
export type JitoSignerPermit = Readonly<{
  invokeOnce<T>(invoke: () => Promise<T>): Promise<T>;
}>;

export function createJitoSignAttemptClient(options: {
  identity: JitoAttemptIdentity;
  assertCurrent: () => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}) {
  const identity = checkIdentity(options.identity);
  const assertCurrent = options.assertCurrent;
  const fetchImpl = options.fetchImpl ?? fetch;
  if (typeof assertCurrent !== 'function' || typeof fetchImpl !== 'function')
    return unavailable();
  let beginConsumed = false;

  const current = () => {
    if (options.signal?.aborted) return unavailable();
    try {
      assertCurrent();
    } catch {
      return unavailable();
    }
  };

  async function request(action: 'begin-signing' | 'read-signing-attempt') {
    current();
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000);
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        signal,
        headers: {
          'content-type': 'application/json',
          'x-jito-protocol': '2',
          [JITO_OWNER_SCOPE_HEADER]: identity.ownerScope,
        },
        body: JSON.stringify({
          action,
          id: identity.bundleId,
          attemptId: identity.attemptId,
          ...(action === 'begin-signing'
            ? {
                sha256: identity.digest,
                packet: identity.packet,
                approved: true,
              }
            : {}),
        }),
      });
      current();
      if (
        signal.aborted ||
        !response.ok ||
        response.headers.get(JITO_OWNER_SCOPE_HEADER) !== identity.ownerScope
      ) {
        void response.body?.cancel().catch(() => {});
        return unavailable();
      }
      const raw = await readBoundedPanelJson(response, signal);
      current();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return unavailable();
      return raw as Record<string, unknown>;
    } catch {
      return unavailable();
    }
  }

  return Object.freeze({
    /** The checkbox must still be checked at this explicit invocation. A lost
     * response consumes the attempt locally; the caller must reconcile. */
    async begin(approved: boolean): Promise<{
      attempt: JitoAttempt;
      permit: JitoSignerPermit | null;
    }> {
      if (approved !== true || beginConsumed) return unavailable();
      beginConsumed = true;
      const raw = await request('begin-signing');
      const attempt = checkedAttempt(raw.attempt, identity);
      if (typeof raw.mayInvokeSigner !== 'boolean') return unavailable();
      if (!raw.mayInvokeSigner) return { attempt, permit: null };
      if (attempt.state !== 'unknown') return unavailable();
      let used = false;
      const permit = Object.freeze({
        async invokeOnce<T>(invoke: () => Promise<T>): Promise<T> {
          if (used || typeof invoke !== 'function') return unavailable();
          used = true;
          current();
          try {
            return await invoke();
          } catch {
            return unavailable();
          }
        },
      });
      return { attempt, permit };
    },
    /** A read is strictly recovery-only and never creates signer authority. */
    async read(): Promise<JitoAttempt> {
      const raw = await request('read-signing-attempt');
      return checkedAttempt(raw.attempt, identity);
    },
  });
}
