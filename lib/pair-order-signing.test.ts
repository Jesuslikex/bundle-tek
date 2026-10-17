import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pairExecutionFixture } from '../test/pair-order-execution-fixture';
import type { VaultSession } from './browser-wallet-vault';

const window = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock('./pair-order-authorization', () => ({
  requirePairOrderSigningWindow: vi.fn(async () => {
    window.calls++;
    if (window.fail)
      throw Error(
        'Signing authorization expired or changed. Request a new review.',
      );
  }),
}));
const {
  signPairOrderPacket,
  verifyPairOrderSignedPacket,
  requirePairOrderUnsignedPacket,
} = await import('./pair-order-signing');

let f: Awaited<ReturnType<typeof pairExecutionFixture>>;
beforeEach(async () => {
  f = await pairExecutionFixture();
  window.fail = false;
  window.calls = 0;
});
afterEach(() => f.close());
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
function setup(seed = new Uint8Array(32).fill(9)) {
  const authorizationId = crypto.randomUUID();
  const authorization = {
    id: authorizationId,
    sha256: 'f'.repeat(64),
    packetSha256: f.packetSha256,
  } as never;
  const review = { wallet: f.wallet } as never;
  const execution = {
    authorizationId,
    wallet: f.wallet,
    packet: f.packet,
    packetSha256: f.packetSha256,
  };
  const session = {
    payload: {
      version: 1,
      wallets: [
        {
          id: 'w',
          family: 'solana',
          address: f.wallet,
          seed: hex(seed),
          createdAt: '',
        },
      ],
    },
  } as unknown as VaultSession;
  const approval = {
    approved: true as const,
    authorizationId,
    authorizationSha256: 'f'.repeat(64),
    packetSha256: f.packetSha256,
  };
  return { authorization, review, execution, session, approval };
}

it('signs only the exact approved bytes inside the window and the server verifier accepts it', async () => {
  const s = setup();
  const signed = await signPairOrderPacket(
    s.session,
    s.review,
    s.authorization,
    s.execution,
    s.approval,
    () => {},
  );
  expect(signed).toEqual(f.sign());
  expect(window.calls).toBe(3);
  await expect(
    verifyPairOrderSignedPacket(s.execution, signed.signedPacket),
  ).resolves.toBe(signed.signature);
});

it('refuses without exact explicit approval, outside the window or after a context change', async () => {
  const s = setup();
  for (const approval of [
    { ...s.approval, approved: false },
    { ...s.approval, authorizationId: crypto.randomUUID() },
    { ...s.approval, authorizationSha256: '0'.repeat(64) },
    { ...s.approval, packetSha256: '0'.repeat(64) },
  ])
    await expect(
      signPairOrderPacket(
        s.session,
        s.review,
        s.authorization,
        s.execution,
        approval as never,
        () => {},
      ),
    ).rejects.toThrow(/Explicit approval/);
  window.fail = true;
  await expect(
    signPairOrderPacket(
      s.session,
      s.review,
      s.authorization,
      s.execution,
      s.approval,
      () => {},
    ),
  ).rejects.toThrow(/expired/);
  window.fail = false;
  await expect(
    signPairOrderPacket(
      s.session,
      s.review,
      s.authorization,
      s.execution,
      s.approval,
      () => {
        throw Error('Order review closed.');
      },
    ),
  ).rejects.toThrow(/closed/);
});

it('refuses substituted packets, wrong vault keys and missing wallets', async () => {
  const s = setup();
  await expect(
    signPairOrderPacket(
      s.session,
      s.review,
      s.authorization,
      { ...s.execution, packet: btoa('x'.repeat(200)) },
      s.approval,
      () => {},
    ),
  ).rejects.toThrow();
  await expect(
    requirePairOrderUnsignedPacket({
      ...s.execution,
      packetSha256: 'e'.repeat(64),
    }),
  ).rejects.toThrow(/approved hash/);
  const wrong = setup(new Uint8Array(32).fill(4));
  await expect(
    signPairOrderPacket(
      wrong.session,
      s.review,
      s.authorization,
      s.execution,
      s.approval,
      () => {},
    ),
  ).rejects.toThrow(/identity differs/);
  const empty = {
    payload: { version: 1, wallets: [] },
  } as unknown as VaultSession;
  await expect(
    signPairOrderPacket(
      empty,
      s.review,
      s.authorization,
      s.execution,
      s.approval,
      () => {},
    ),
  ).rejects.toThrow(/Unlock/);
});

it('rejects signed packets with altered messages, unsigned slots or another key', async () => {
  const s = setup();
  const good = f.sign();
  await expect(
    verifyPairOrderSignedPacket(s.execution, f.packet),
  ).rejects.toThrow(/differs/);
  const bytes = Uint8Array.from(atob(good.signedPacket), (c) =>
    c.charCodeAt(0),
  );
  bytes[bytes.length - 2] ^= 1;
  await expect(
    verifyPairOrderSignedPacket(
      s.execution,
      btoa(String.fromCharCode(...bytes)),
    ),
  ).rejects.toThrow(/differs/);
  const other = (await import('tweetnacl')).default.sign.keyPair.fromSeed(
    new Uint8Array(32).fill(4),
  );
  await expect(
    verifyPairOrderSignedPacket(
      s.execution,
      f.sign(other.secretKey).signedPacket,
    ),
  ).rejects.toThrow(/differs/);
  await expect(
    verifyPairOrderSignedPacket(s.execution, 'not base64!'),
  ).rejects.toThrow();
});
