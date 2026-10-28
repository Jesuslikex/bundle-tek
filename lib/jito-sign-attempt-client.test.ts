import { describe, expect, it, vi } from 'vitest';
import bs58 from 'bs58';
import {
  createJitoSignAttemptClient,
  type JitoAttemptIdentity,
} from './jito-sign-attempt-client';
import { JITO_OWNER_SCOPE_HEADER } from './jito-owner-scope';

const identity: JitoAttemptIdentity = {
  ownerScope: 'a'.repeat(64),
  bundleId: '11111111-1111-1111-1111-111111111111',
  digest: 'b'.repeat(64),
  packet: 0,
  signer: bs58.encode(new Uint8Array(32).fill(9)),
  intentId: '22222222-2222-2222-2222-222222222222',
  attemptId: '33333333-3333-3333-3333-333333333333',
};

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    bundleId: identity.bundleId,
    manifestSha256: identity.digest,
    packet: identity.packet,
    signer: identity.signer,
    intentId: identity.intentId,
    attemptId: identity.attemptId,
    transaction: null,
    signature: null,
    state: 'unknown',
    ...overrides,
  };
}
function response(body: unknown, owner = identity.ownerScope, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      [JITO_OWNER_SCOPE_HEADER]: owner,
    },
  });
}
function client(fetchImpl: typeof fetch, assertCurrent = () => {}) {
  return createJitoSignAttemptClient({ identity, assertCurrent, fetchImpl });
}

describe('owner-bound Jito sign attempts', () => {
  it('sends one approved begin and provides a single-use permit', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({ attempt: attempt(), mayInvokeSigner: true }),
    );
    const c = client(fetchImpl);
    const result = await c.begin(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/imported-projects/jito-bundles');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
    });
    expect(init?.headers).toMatchObject({
      'x-jito-protocol': '2',
      [JITO_OWNER_SCOPE_HEADER]: identity.ownerScope,
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      action: 'begin-signing',
      id: identity.bundleId,
      attemptId: identity.attemptId,
      sha256: identity.digest,
      packet: 0,
      approved: true,
    });
    const invoke = vi.fn(async () => 'synthetic');
    await expect(result.permit!.invokeOnce(invoke)).resolves.toBe('synthetic');
    await expect(result.permit!.invokeOnce(invoke)).rejects.toThrow(
      'Signing attempt unavailable',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(c.begin(true)).rejects.toThrow('Signing attempt unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never invokes or retries after a lost response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error('sensitive provider details');
    });
    const c = client(fetchImpl);
    await expect(c.begin(true)).rejects.toThrow(
      'Signing attempt unavailable. Reload recovery history.',
    );
    await expect(c.begin(true)).rejects.toThrow('Signing attempt unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('requires explicit approval before making a request', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(client(fetchImpl).begin(false)).rejects.toThrow(
      'Signing attempt unavailable',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats retry and read as recovery-only', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ attempt: attempt(), mayInvokeSigner: false }),
      )
      .mockResolvedValueOnce(
        response({ attempt: attempt(), mayInvokeSigner: true }),
      );
    const c = client(fetchImpl);
    expect((await c.begin(true)).permit).toBeNull();
    const read = await c.read();
    expect(read.state).toBe('unknown');
    expect(read).not.toHaveProperty('permit');
    expect(JSON.parse(fetchImpl.mock.calls[1][1]?.body as string)).toEqual({
      action: 'read-signing-attempt',
      id: identity.bundleId,
      attemptId: identity.attemptId,
    });
  });

  it.each([
    ['bundle', { bundleId: '44444444-4444-4444-4444-444444444444' }],
    ['digest', { manifestSha256: 'c'.repeat(64) }],
    ['packet', { packet: 1 }],
    ['signer', { signer: bs58.encode(new Uint8Array(32).fill(8)) }],
    ['intent', { intentId: null }],
    ['attempt', { attemptId: '44444444-4444-4444-4444-444444444444' }],
    ['unknown receipt', { signature: 'bad' }],
  ])('rejects mismatched %s', async (_label, change) => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({ attempt: attempt(change), mayInvokeSigner: true }),
    );
    const c = client(fetchImpl);
    await expect(c.begin(true)).rejects.toThrow('Signing attempt unavailable');
    await expect(c.begin(true)).rejects.toThrow('Signing attempt unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects a mismatched owner scope, malformed authority and registered-with-authority', async () => {
    for (const result of [
      response({ attempt: attempt(), mayInvokeSigner: true }, 'c'.repeat(64)),
      response({ attempt: attempt(), mayInvokeSigner: 'true' }),
      response({
        attempt: attempt({
          state: 'registered',
          signature: null,
          transaction: null,
        }),
        mayInvokeSigner: true,
      }),
      response({ error: 'sensitive body' }, identity.ownerScope, 503),
    ]) {
      const fetchImpl = vi.fn<typeof fetch>(async () => result);
      await expect(client(fetchImpl).begin(true)).rejects.toThrow(
        'Signing attempt unavailable. Reload recovery history.',
      );
    }
  });

  it('burns the permit if the context changed, even if context later returns', async () => {
    let active = true;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({ attempt: attempt(), mayInvokeSigner: true }),
    );
    const result = await client(fetchImpl, () => {
      if (!active) throw Error('changed');
    }).begin(true);
    const invoke = vi.fn(async () => 'synthetic');
    active = false;
    await expect(result.permit!.invokeOnce(invoke)).rejects.toThrow(
      'Signing attempt unavailable',
    );
    active = true;
    await expect(result.permit!.invokeOnce(invoke)).rejects.toThrow(
      'Signing attempt unavailable',
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it('burns the permit before invoking a failing or pending signer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({ attempt: attempt(), mayInvokeSigner: true }),
    );
    const result = await client(fetchImpl).begin(true);
    const invoke = vi.fn(async () => {
      throw Error('wallet cancelled');
    });
    await expect(result.permit!.invokeOnce(invoke)).rejects.toThrow(
      'Signing attempt unavailable',
    );
    await expect(result.permit!.invokeOnce(invoke)).rejects.toThrow(
      'Signing attempt unavailable',
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('accepts only structurally matching registered receipt bytes, without granting authority', async () => {
    const signatureBytes = new Uint8Array(64).fill(7);
    const signature = bs58.encode(signatureBytes);
    const bytes = Uint8Array.from([1, ...signatureBytes, 42]);
    const transaction = btoa(String.fromCharCode(...bytes));
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      response({
        attempt: attempt({ state: 'registered', signature, transaction }),
        mayInvokeSigner: false,
      }),
    );
    const result = await client(fetchImpl).begin(true);
    expect(result.attempt.state).toBe('registered');
    expect(result.permit).toBeNull();
    expect(result.attempt.signature).toBe(signature);
    const wrong = bs58.encode(new Uint8Array(64).fill(8));
    const bad = vi.fn<typeof fetch>(async () =>
      response({
        attempt: attempt({
          state: 'registered',
          signature: wrong,
          transaction,
        }),
        mayInvokeSigner: false,
      }),
    );
    await expect(client(bad).read()).rejects.toThrow(
      'Signing attempt unavailable',
    );
    const contradictory = vi.fn<typeof fetch>(async () =>
      response({
        attempt: attempt({ state: 'registered', signature, transaction }),
        mayInvokeSigner: true,
      }),
    );
    await expect(client(contradictory).begin(true)).rejects.toThrow(
      'Signing attempt unavailable',
    );
  });

  it('does not grant authority after account changes while the response is pending', async () => {
    let active = true;
    let finish!: (value: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const c = client(fetchImpl, () => {
      if (!active) throw Error('account changed');
    });
    const pending = c.begin(true);
    active = false;
    finish(response({ attempt: attempt(), mayInvokeSigner: true }));
    await expect(pending).rejects.toThrow('Signing attempt unavailable');
    active = true;
    await expect(c.begin(true)).rejects.toThrow('Signing attempt unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid identities and never sends a request', () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const changes of [
      { ownerScope: 'bad' },
      { bundleId: 'bad' },
      { digest: 'bad' },
      { packet: 5 },
      { signer: 'bad' },
      { attemptId: 'bad' },
    ])
      expect(() =>
        createJitoSignAttemptClient({
          identity: { ...identity, ...changes },
          assertCurrent: () => {},
          fetchImpl,
        }),
      ).toThrow('Signing attempt unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
