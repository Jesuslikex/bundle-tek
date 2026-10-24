import { beforeAll, expect, it } from 'vitest';
import { nativeWarmupFixture } from '../test/warmup-native-fixture';
import { requireWarmupSigningReview } from './warmup-signing';
import type { WarmupSettlement } from './warmup-native-settlement';
import { matchingJitoSettlementPolicy } from './jito-settlement-policy';

let v1: WarmupSettlement, approved: WarmupSettlement, fresh: WarmupSettlement;
beforeAll(async () => {
  const legacy = await nativeWarmupFixture({ side: 'Buy', lookup: true });
  v1 = await requireWarmupSigningReview(legacy.order, legacy.simulation);
  const f = await nativeWarmupFixture({
    side: 'Buy',
    v2: true,
    token2022: true,
    lookup: true,
    shared: false,
  });
  approved = await requireWarmupSigningReview(f.order, f.simulation);
  const next = structuredClone(f.simulation);
  const slot = approved.token2022Evidence!.recheckSlot + 1;
  next.token2022Evidence!.slot = slot;
  next.token2022Evidence!.recheckSlot = slot + 1;
  next.simulationSlot = slot;
  next.lookupObservation!.slot = slot;
  next.lookupObservation!.recheckSlot = slot + 1;
  fresh = await requireWarmupSigningReview(f.order, next);
});

it('accepts a genuinely reviewed unchanged v1 policy without mutation', () => {
  const copy = structuredClone(v1);
  expect(matchingJitoSettlementPolicy(v1, copy)).toBe(true);
  expect(copy).toEqual(v1);
});
it('accepts the same v2 source policy only after both real settlement reviews pass', () => {
  const before = structuredClone(approved),
    after = structuredClone(fresh);
  expect(matchingJitoSettlementPolicy(approved, fresh)).toBe(true);
  expect(approved).toEqual(before);
  expect(fresh).toEqual(after);
});
it('preserves exact equality for an admitted v2 proof whose observation spans slots', () => {
  const copy = structuredClone(approved);
  copy.token2022Evidence!.slot = 100;
  copy.token2022Evidence!.recheckSlot = 101;
  expect(matchingJitoSettlementPolicy(copy, structuredClone(copy))).toBe(true);
});
it('accepts coherent forward boundary slots, including a 32-slot span and touching observations', () => {
  for (const span of [0, 32]) {
    const copy = structuredClone(fresh);
    copy.token2022Evidence!.slot = approved.token2022Evidence!.recheckSlot;
    copy.token2022Evidence!.recheckSlot = copy.token2022Evidence!.slot + span;
    expect(matchingJitoSettlementPolicy(approved, copy)).toBe(true);
  }
});

const mutations: [string, (v: WarmupSettlement) => void][] = [
  [
    'account hash',
    (v) => {
      v.accountKeysSha256 = 'a'.repeat(64);
    },
  ],
  [
    'wrapped amount',
    (v) => {
      v.wrappedFromNativeRaw = '7';
    },
  ],
  [
    'rent ceiling',
    (v) => {
      v.maximumRentLamports = '7';
    },
  ],
  [
    'debit ceiling',
    (v) => {
      v.maximumNativeDebitLamports = '7';
    },
  ],
  [
    'refund',
    (v) => {
      v.preexistingWrappedRefundRaw = '7';
    },
  ],
  [
    'closure',
    (v) => {
      v.closesWrappedAccount = !v.closesWrappedAccount;
    },
  ],
  [
    'account address',
    (v) => {
      v.accounts[0].address += 'x';
    },
  ],
  [
    'account mint',
    (v) => {
      v.accounts[0].mint += 'x';
    },
  ],
  [
    'account index',
    (v) => {
      v.accounts[0].index++;
    },
  ],
  [
    'account creation',
    (v) => {
      v.accounts[0].created = !v.accounts[0].created;
    },
  ],
  [
    'account closure',
    (v) => {
      v.accounts[0].closed = !v.accounts[0].closed;
    },
  ],
  [
    'account reserve',
    (v) => {
      v.accounts[0].rentBeforeRaw = '7';
    },
  ],
  [
    'account order',
    (v) => {
      v.accounts.reverse();
    },
  ],
  [
    'missing account',
    (v) => {
      v.accounts.pop();
    },
  ],
  [
    'added account',
    (v) => {
      v.accounts.push({ ...v.accounts[0] });
    },
  ],
  [
    'lookup address',
    (v) => {
      v.lookupTables[0].address += 'x';
    },
  ],
  [
    'lookup hash',
    (v) => {
      v.lookupTables[0].sha256 = 'b'.repeat(64);
    },
  ],
  [
    'lookup extension slot',
    (v) => {
      v.lookupTables[0].lastExtendedSlot = '7';
    },
  ],
  [
    'missing lookup',
    (v) => {
      v.lookupTables.pop();
    },
  ],
  [
    'added lookup',
    (v) => {
      v.lookupTables.push({ ...v.lookupTables[0] });
    },
  ],
];
it.each(mutations)('refuses changed %s for both versions', (_name, mutate) => {
  for (const original of [v1, approved]) {
    const copy = structuredClone(original.version === 1 ? original : fresh);
    mutate(copy);
    expect(matchingJitoSettlementPolicy(original, copy)).toBe(false);
  }
});

it.each([
  ['format', 'other'],
  ['accountSize', 165],
  ['rentLamports', '2039280'],
] as const)('refuses changed proof %s', (key, value) => {
  const copy = structuredClone(fresh);
  Object.assign(copy.token2022Evidence!, { [key]: value });
  expect(matchingJitoSettlementPolicy(approved, copy)).toBe(false);
});
it.each(['address', 'program', 'decimals', 'policySha256'] as const)(
  'refuses changed mint %s',
  (key) => {
    const copy = structuredClone(fresh);
    Object.assign(copy.token2022Evidence!.mints[1], {
      [key]: key === 'decimals' ? 7 : 'x',
    });
    expect(matchingJitoSettlementPolicy(approved, copy)).toBe(false);
  },
);
it('refuses dropped, added, reordered or extra-field mint evidence', () => {
  for (const mutate of [
    (p: NonNullable<WarmupSettlement['token2022Evidence']>) => {
      p.mints.pop();
    },
    (p: NonNullable<WarmupSettlement['token2022Evidence']>) => {
      p.mints.push({ ...p.mints[0] });
    },
    (p: NonNullable<WarmupSettlement['token2022Evidence']>) => {
      p.mints.reverse();
    },
    (p: NonNullable<WarmupSettlement['token2022Evidence']>) => {
      Object.assign(p.mints[0], { unexpected: true });
    },
  ]) {
    const copy = structuredClone(fresh);
    mutate(copy.token2022Evidence!);
    expect(matchingJitoSettlementPolicy(approved, copy)).toBe(false);
  }
});
it.each([
  -1,
  1.5,
  NaN,
  Infinity,
  Number.MAX_SAFE_INTEGER + 1,
  '100',
  undefined,
])('refuses invalid slots %s on either side', (slot) => {
  for (const key of ['slot', 'recheckSlot']) {
    const old = structuredClone(approved),
      next = structuredClone(fresh);
    Object.assign(old.token2022Evidence!, { [key]: slot });
    Object.assign(next.token2022Evidence!, { [key]: slot });
    expect(matchingJitoSettlementPolicy(old, fresh)).toBe(false);
    expect(matchingJitoSettlementPolicy(approved, next)).toBe(false);
  }
});
it('refuses backward, overlapping, reversed and excessive-span proof observations', () => {
  for (const [slot, recheckSlot] of [
    [
      approved.token2022Evidence!.recheckSlot - 1,
      fresh.token2022Evidence!.recheckSlot,
    ],
    [1000, 999],
    [1000, 1033],
  ]) {
    const copy = structuredClone(fresh);
    Object.assign(copy.token2022Evidence!, { slot, recheckSlot });
    expect(matchingJitoSettlementPolicy(approved, copy)).toBe(false);
    expect(matchingJitoSettlementPolicy(copy, fresh)).toBe(false);
  }
});
it('rejects missing, added and unknown fields, versions and evidence even when both sides match', () => {
  const malformed: unknown[] = [
    null,
    [],
    {},
    { ...v1, version: 3 },
    { ...v1, token2022Evidence: undefined },
    { ...approved, token2022Evidence: undefined },
    { ...v1, unexpected: true },
  ];
  for (const field of Object.keys(v1)) {
    const copy = { ...v1 } as Record<string, unknown>;
    delete copy[field];
    malformed.push(copy);
  }
  for (const field of Object.keys(fresh.token2022Evidence!)) {
    const copy = structuredClone(fresh);
    delete (copy.token2022Evidence as unknown as Record<string, unknown>)[
      field
    ];
    malformed.push(copy);
  }
  for (const value of malformed)
    expect(matchingJitoSettlementPolicy(value, value)).toBe(false);
  expect(matchingJitoSettlementPolicy(v1, approved)).toBe(false);
  expect(matchingJitoSettlementPolicy(approved, v1)).toBe(false);
});
it('refuses getters, sparse arrays and nested unknown fields without evaluating accessors', () => {
  const getter = { ...fresh };
  Object.defineProperty(getter, 'version', {
    get() {
      throw Error('must not evaluate');
    },
    enumerable: true,
  });
  expect(matchingJitoSettlementPolicy(approved, getter)).toBe(false);
  const sparse = structuredClone(fresh);
  Reflect.deleteProperty(sparse.accounts, '0');
  expect(matchingJitoSettlementPolicy(approved, sparse)).toBe(false);
  const arrayGetter = structuredClone(fresh);
  Object.defineProperty(arrayGetter.accounts, '0', {
    get() {
      throw Error('must not evaluate');
    },
    enumerable: true,
  });
  expect(matchingJitoSettlementPolicy(approved, arrayGetter)).toBe(false);
  for (const key of ['accounts', 'lookupTables'] as const) {
    const copy = structuredClone(fresh);
    Object.assign(copy[key][0], { unexpected: true });
    expect(matchingJitoSettlementPolicy(copy, copy)).toBe(false);
  }
});
it('refuses missing nested fields and unknown or invalid proof policy even on identical copies', () => {
  for (const key of ['accounts', 'lookupTables'] as const)
    for (const field of Object.keys(fresh[key][0])) {
      const copy = structuredClone(fresh);
      delete (copy[key][0] as unknown as Record<string, unknown>)[field];
      expect(matchingJitoSettlementPolicy(copy, copy)).toBe(false);
    }
  for (const change of [
    { unexpected: true },
    { format: 'other' },
    { accountSize: 165 },
  ]) {
    const copy = structuredClone(fresh);
    Object.assign(copy.token2022Evidence!, change);
    expect(matchingJitoSettlementPolicy(copy, copy)).toBe(false);
  }
});
