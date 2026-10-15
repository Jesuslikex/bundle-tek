import { beforeAll, afterEach, expect, it, vi } from 'vitest';
import {
  address,
  getTransactionDecoder,
  getBase64Decoder,
} from '@solana/kit-v1';
import nacl from 'tweetnacl';
import type { VaultSession } from './browser-wallet-vault';
import type { PumpLaunchGroupConsent } from './pump-launch-group-review';
import { pumpLaunchGroupReviewFixture } from '../test/pump-launch-group-review-fixture';
import { signPumpLaunchGroup } from './pump-launch-group-signing';
import { verifyPumpLaunchGroupSignatures } from './pump-launch-group-signatures';

// Only generated synthetic fixture keys are extractable. No production key or vault is opened.
vi.mock('@solana/kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/kit')>();
  return {
    ...actual,
    generateKeyPairSigner: () => actual.generateKeyPairSigner(true),
  };
});
vi.mock('@solana/kit-v1', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/kit-v1')>();
  return {
    ...actual,
    generateKeyPairSigner: () => actual.generateKeyPairSigner(true),
  };
});

type Fixture = Awaited<ReturnType<typeof pumpLaunchGroupReviewFixture>>;
let f: Fixture, sessions: Map<string, VaultSession>;
async function fixtureSessions(source: Fixture) {
  const keys = [
    source.fixture.f.f.payerSigner,
    source.fixture.f.f.mintSigner,
    ...source.fixture.holderSigners,
  ];
  const wallets = await Promise.all(
    keys.map(async (key, index) => {
      const der = new Uint8Array(
        await crypto.subtle.exportKey('pkcs8', key.keyPair.privateKey),
      );
      try {
        // WebCrypto's generated Ed25519 PKCS8 envelope holds the 32-byte seed.
        if (der.length !== 48)
          throw new Error('Unexpected synthetic key envelope');
        return {
          id: 'synthetic-' + index,
          family: 'solana' as const,
          address: key.address,
          seed: Buffer.from(der.subarray(16)).toString('hex'),
          createdAt: new Date().toISOString(),
        };
      } finally {
        der.fill(0);
      }
    }),
  );
  const session: VaultSession = {
    key: keys[0].keyPair.privateKey,
    salt: 'synthetic-unused',
    payload: { version: 1, wallets },
  };
  const required = [
    source.review.input.create.payer,
    source.review.input.create.mint,
    ...source.review.input.holders
      .filter((h) => h.kind !== 'none')
      .map((h) => h.address),
  ];
  return new Map(required.map((key) => [key, session]));
}
beforeAll(async () => {
  f = await pumpLaunchGroupReviewFixture();
  sessions = await fixtureSessions(f);
}, 20000);
afterEach(() => vi.restoreAllMocks());
const sign = (
  supplied = sessions,
  current: () => void = () => {},
  signal?: AbortSignal,
) => signPumpLaunchGroup(supplied, f.review, f.consent, current, signal);

it('signs all ordered packets locally, preserves messages and omits zero slots without permission or network access', async () => {
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('No signing network'));
  const result = await sign();
  expect(result.packets.length).toBeGreaterThan(1);
  expect(result).toMatchObject({
    signatureSetVerified: true,
    signingAllowed: false,
    executionAllowed: false,
    completeLaunch: false,
  });
  const inactive = f.review.input.holders.find(
    (h) => h.kind === 'none',
  )!.address;
  for (const [index, packet] of result.packets.entries()) {
    const tx = getTransactionDecoder().decode(
        Buffer.from(packet.transaction, 'base64'),
      ),
      original = getTransactionDecoder().decode(
        Buffer.from(f.review.packets[index].transaction, 'base64'),
      );
    expect(getBase64Decoder().decode(tx.messageBytes)).toBe(
      getBase64Decoder().decode(original.messageBytes),
    );
    expect(Object.values(tx.signatures).every((s) => s !== null)).toBe(true);
    expect(Object.values(original.signatures).every((s) => s === null)).toBe(
      true,
    );
    expect(tx.signatures[address(inactive)]).toBeUndefined();
    expect(Boolean(tx.signatures[address(f.review.input.create.mint)])).toBe(
      index === 0,
    );
  }
  expect(
    (
      await verifyPumpLaunchGroupSignatures(
        f.review,
        result.packets.map((p) => p.transaction),
      )
    ).signedGroupSha256,
  ).toBe(result.signedGroupSha256);
  expect(network).not.toHaveBeenCalled();
});

it('requires exact group, context, simulation, scope and limits consent before touching keys', async () => {
  const derive = vi.spyOn(nacl.sign.keyPair, 'fromSeed'),
    detached = vi.spyOn(nacl.sign, 'detached');
  for (const patch of [
    { approved: false },
    { reviewId: 'other' },
    { manifestSha256: '0'.repeat(64) },
    { contextSha256: '0'.repeat(64) },
    { simulationSha256: '0'.repeat(64) },
    { approvedScope: 'create-only' },
    { acknowledgeSimulationLimits: false },
    { extra: true },
  ]) {
    await expect(
      signPumpLaunchGroup(
        sessions,
        f.review,
        { ...f.consent, ...patch } as PumpLaunchGroupConsent,
        () => {},
      ),
    ).rejects.toThrow('Explicit approval');
  }
  expect(derive).not.toHaveBeenCalled();
  expect(detached).not.toHaveBeenCalled();
});
it('rejects missing last-packet keys and extra inactive sessions before any signature', async () => {
  const detached = vi.spyOn(nacl.sign, 'detached'),
    missing = new Map(sessions);
  missing.delete(f.review.packets.at(-1)!.requiredSigners.at(-1)!);
  await expect(sign(missing)).rejects.toThrow('complete group signer set');
  const inactive = f.review.input.holders.find(
    (h) => h.kind === 'none',
  )!.address;
  await expect(
    sign(new Map([...sessions, [inactive, sessions.values().next().value!]])),
  ).rejects.toThrow('complete group signer set');
  expect(detached).not.toHaveBeenCalled();
});
it('validates a bad identity in the final packet before signing even the first packet and clears copied seeds', async () => {
  const last = f.review.packets.at(-1)!.requiredSigners.at(-1)!,
    changed = new Map(sessions),
    bad = structuredClone(sessions.get(last)!);
  bad.payload.wallets.find((w) => w.address === last)!.seed = '0'.repeat(64);
  changed.set(last, bad);
  const derive = vi.spyOn(nacl.sign.keyPair, 'fromSeed'),
    detached = vi.spyOn(nacl.sign, 'detached');
  await expect(sign(changed)).rejects.toThrow('seed does not match');
  expect(detached).not.toHaveBeenCalled();
  expect(
    derive.mock.calls.every(([bytes]) => bytes.every((byte) => byte === 0)),
  ).toBe(true);
});
it('rejects malformed, missing, EVM and duplicate selected vault identities', async () => {
  const key = f.review.input.create.payer,
    detached = vi.spyOn(nacl.sign, 'detached');
  for (const kind of ['seed', 'missing', 'evm', 'duplicate']) {
    const copy = structuredClone(sessions.get(key)!);
    const wallet = copy.payload.wallets.find((w) => w.address === key)!;
    if (kind === 'seed') wallet.seed = 'invalid';
    if (kind === 'missing')
      copy.payload.wallets = copy.payload.wallets.filter(
        (w) => w.address !== key,
      );
    if (kind === 'evm') wallet.family = 'evm';
    if (kind === 'duplicate') copy.payload.wallets.push({ ...wallet });
    await expect(sign(new Map([...sessions, [key, copy]]))).rejects.toThrow(
      'exact group wallet',
    );
  }
  expect(detached).not.toHaveBeenCalled();
});
it('refuses altered and incomplete reviews before extracting private seeds', async () => {
  const derive = vi.spyOn(nacl.sign.keyPair, 'fromSeed');
  for (const change of ['missing', 'order', 'bytes', 'signer', 'limits']) {
    const review = structuredClone(f.review);
    if (change === 'missing') review.packets.pop();
    if (change === 'order') review.packets.reverse();
    if (change === 'bytes')
      review.packets[0].transaction = review.packets[1].transaction;
    if (change === 'signer') review.packets.at(-1)!.requiredSigners.pop();
    if (change === 'limits') review.allowances.deployerFeeAndRentLimitRaw = '1';
    await expect(
      signPumpLaunchGroup(sessions, review, f.consent, () => {}),
    ).rejects.toThrow();
  }
  expect(derive).not.toHaveBeenCalled();
});
it('requires a live synchronous caller guard before touching keys', async () => {
  const derive = vi.spyOn(nacl.sign.keyPair, 'fromSeed');
  await expect(
    sign(sessions, () => {
      throw new Error('Runtime qualification missing');
    }),
  ).rejects.toThrow('Runtime qualification missing');
  await expect(
    sign(sessions, (() => Promise.resolve()) as () => void),
  ).rejects.toThrow('synchronous live');
  expect(derive).not.toHaveBeenCalled();
});
it('discards interrupted partial work and erases temporary seed/secret bytes on cancellation', async () => {
  const derive = vi.spyOn(nacl.sign.keyPair, 'fromSeed'),
    detached = vi.spyOn(nacl.sign, 'detached'),
    control = new AbortController();
  await expect(
    sign(
      sessions,
      () => {
        if (detached.mock.calls.length)
          control.abort(new Error('Draft changed'));
      },
      control.signal,
    ),
  ).rejects.toThrow('Draft changed');
  expect(detached).toHaveBeenCalledTimes(1);
  expect(
    derive.mock.calls.every(([bytes]) => bytes.every((byte) => byte === 0)),
  ).toBe(true);
  expect(detached.mock.calls[0][1].every((byte) => byte === 0)).toBe(true);
});
it('rejects vault selection or seed changes between packets without returning a partial group', async () => {
  const detached = vi.spyOn(nacl.sign, 'detached');
  const changed = new Map(sessions);
  await expect(
    sign(changed, () => {
      if (detached.mock.calls.length)
        changed.delete(f.review.input.create.payer);
    }),
  ).rejects.toThrow('selection changed');
  detached.mockClear();
  const clone = structuredClone(sessions),
    key = f.review.input.create.payer;
  await expect(
    sign(clone, () => {
      if (detached.mock.calls.length)
        clone.get(key)!.payload.wallets.find((w) => w.address === key)!.seed =
          '0'.repeat(64);
    }),
  ).rejects.toThrow('identity changed');
});
it('rejects expiry before signing or during partial signing, but preserves historical verification', async () => {
  const result = await sign(),
    detached = vi.spyOn(nacl.sign, 'detached');
  const clock = vi
    .spyOn(Date, 'now')
    .mockReturnValue(Date.parse(f.review.expiresAt) + 1);
  await expect(sign()).rejects.toThrow('expired');
  expect(detached).not.toHaveBeenCalled();
  expect(
    (
      await verifyPumpLaunchGroupSignatures(
        f.review,
        result.packets.map((p) => p.transaction),
      )
    ).signedGroupSha256,
  ).toBe(result.signedGroupSha256);
  clock.mockRestore();
  await expect(
    sign(sessions, () => {
      if (detached.mock.calls.length)
        vi.spyOn(Date, 'now').mockReturnValue(
          Date.parse(f.review.expiresAt) + 1,
        );
    }),
  ).rejects.toThrow('expired');
});
it('erases temporary private bytes after success without erasing caller-owned unlocked vaults', async () => {
  const initial = structuredClone(sessions),
    derive = vi.spyOn(nacl.sign.keyPair, 'fromSeed'),
    detached = vi.spyOn(nacl.sign, 'detached');
  await sign();
  expect(
    derive.mock.calls.every(([bytes]) => bytes.every((byte) => byte === 0)),
  ).toBe(true);
  expect(
    detached.mock.calls.every(([, secret]) =>
      secret.every((byte) => byte === 0),
    ),
  ).toBe(true);
  expect(sessions).toEqual(initial);
});
for (const token22 of [false, true])
  it(`signs the complete stock quote group with its exact token program (Token-2022=${token22})`, async () => {
    const variant = await pumpLaunchGroupReviewFixture(true, token22),
      vaults = await fixtureSessions(variant);
    const result = await signPumpLaunchGroup(
      vaults,
      variant.review,
      variant.consent,
      () => {},
    );
    expect(result.packets.length).toBe(variant.review.packets.length);
    expect(
      (
        await verifyPumpLaunchGroupSignatures(
          variant.review,
          result.packets.map((p) => p.transaction),
        )
      ).signedGroupSha256,
    ).toBe(result.signedGroupSha256);
    expect(result.executionAllowed).toBe(false);
  }, 20000);
