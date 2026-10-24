import { expect, it } from 'vitest';
import { jitoRawResponseFixture } from '../test/jito-raw-response-fixture';
import {
  buildJitoAssetRead,
  readJitoAssetEvidence,
  verifyJitoAssetBracket,
} from './jito-asset-evidence';
import { PAIR_RENT } from './pair-rent-evidence';
const signal = () => new AbortController().signal;
async function fixture(token2022 = false) {
  const f = await jitoRawResponseFixture({ token2022 });
  const e = f.fixture;
  const mints = [
    e.observations[0].order.inputMint,
    e.observations[0].order.outputMint,
  ];
  const accounts = [
    ...e.observations[0].mintAccounts.before,
    e.rentAccounts.before,
  ].map((value) => {
    const a = value as {
      owner: string;
      executable: boolean;
      data: string[];
      lamports?: string;
    };
    return {
      ...a,
      lamports: BigInt(a.lamports ?? '10000000'),
      rentEpoch: (1n << 64n) - 1n,
      space: BigInt(Buffer.from(a.data[0], 'base64').length),
    };
  });
  const read = async (
    slot: number,
    id = 'assets',
    change?: (v: typeof accounts) => void,
  ) => {
    const p = buildJitoAssetRead(mints, 100, slot, id),
      a = structuredClone(accounts);
    change?.(a);
    return readJitoAssetEvidence(
      p,
      new Response(
        f.wire({
          jsonrpc: '2.0',
          id,
          result: { context: { slot: BigInt(slot) }, value: a },
        }),
      ).body,
      signal(),
    );
  };
  return { f, mints, accounts, read };
}
for (const modern of [false, true])
  it(`retains complete independent mint/Rent bracketing bytes for2022=${modern}`, async () => {
    const x = await fixture(modern),
      before = await x.read(100, 'before'),
      after = await x.read(102, 'after');
    const result = await verifyJitoAssetBracket(before, after, 101, signal());
    expect(result).toMatchObject({
      minimumSlot: 100,
      beforeSlot: 100,
      afterSlot: 102,
      mintPolicyChecksPassed: true,
      rentChecksPassed: true,
      signingAllowed: false,
      providerQualified: false,
    });
    expect(result.mintAccounts.map((a) => a.address)).toEqual(x.mints);
    expect(result.minimumSystemReserveLamports).toBe('890880');
    expect(before.rawBody.length).toBeGreaterThan(200);
    expect(JSON.parse(before.requestBody).params[0]).toEqual([
      ...x.mints,
      PAIR_RENT,
    ]);
  });
for (const bad of [
  'id',
  'count',
  'slot',
  'precision',
  'null',
  'space',
  'base64',
] as const)
  it(`refuses raw asset ${bad} without partial evidence`, async () => {
    const x = await fixture(),
      p = buildJitoAssetRead(x.mints, 100, 100, 'assets');
    const a = structuredClone(x.accounts);
    const raw: {
      jsonrpc: string;
      id: string;
      result: { context: { slot: bigint }; value: unknown[] };
    } = {
      jsonrpc: '2.0',
      id: 'assets',
      result: { context: { slot: 100n }, value: a },
    };
    if (bad === 'id') raw.id = 'other';
    if (bad === 'count') raw.result.value.pop();
    if (bad === 'slot') raw.result.context.slot = 133n;
    if (bad === 'precision') raw.result.value[0] = { ...a[0], lamports: 1.5 };
    if (bad === 'null') raw.result.value[0] = null;
    if (bad === 'space') a[0].space = 0n;
    if (bad === 'base64') a[0].data[0] += '=';
    await expect(
      readJitoAssetEvidence(p, new Response(x.f.wire(raw)).body, signal()),
    ).rejects.toThrow();
  });
it('refuses minted-policy or Rent changes, stale bracketing and mutated raw evidence', async () => {
  const x = await fixture(),
    before = await x.read(100, 'before'),
    after = await x.read(102, 'after');
  await expect(
    verifyJitoAssetBracket(before, after, 99, signal()),
  ).rejects.toThrow();
  const sameFloor = await x.read(100, 'low');
  await expect(
    verifyJitoAssetBracket(before, sameFloor, 101, signal()),
  ).rejects.toThrow();
  const changed = await x.read(102, 'changed', (a) => {
    const b = Buffer.from(a[1].data[0], 'base64');
    b[44] = 8;
    a[1].data[0] = b.toString('base64');
  });
  await expect(
    verifyJitoAssetBracket(before, changed, 101, signal()),
  ).rejects.toThrow();
  const rent = await x.read(102, 'rent', (a) => {
    const b = Buffer.from(a[2].data[0], 'base64');
    b[0] ^= 1;
    a[2].data[0] = b.toString('base64');
  });
  await expect(
    verifyJitoAssetBracket(before, rent, 101, signal()),
  ).rejects.toThrow();
  after.rawBody[0] ^= 1;
  await expect(
    verifyJitoAssetBracket(before, after, 101, signal()),
  ).rejects.toThrow();
});
it('does not issue forgeable plans or accept duplicate/accessor/invalid address scopes', async () => {
  const x = await fixture();
  for (const m of [
    [x.mints[0], x.mints[0]],
    [x.mints[0], PAIR_RENT],
    ['bad', x.mints[1]],
  ])
    expect(() => buildJitoAssetRead(m, 100, 100, 'a')).toThrow();
  let invoked = false;
  const m = [...x.mints];
  Object.defineProperty(m, '0', {
    get() {
      invoked = true;
      throw Error('getter');
    },
    enumerable: true,
  });
  expect(() => buildJitoAssetRead(m, 100, 100, 'a')).toThrow();
  expect(invoked).toBe(false);
  await expect(
    readJitoAssetEvidence(
      { ...buildJitoAssetRead(x.mints, 100, 100, 'a') },
      new Response('{}').body,
      signal(),
    ),
  ).rejects.toThrow();
});

it('requires distinct before/after captures, plans and RPC identities even at one bank', async () => {
  const x = await fixture(),
    a = await x.read(100, 'same'),
    b = await x.read(100, 'same');
  await expect(verifyJitoAssetBracket(a, a, 100, signal())).rejects.toThrow();
  await expect(verifyJitoAssetBracket(a, b, 100, signal())).rejects.toThrow();
});
