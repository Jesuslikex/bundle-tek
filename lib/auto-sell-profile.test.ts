import { expect, it } from 'vitest';
import bs58 from 'bs58';
import { newAutoSellStrategy } from './auto-sell';
import {
  AUTO_SELL_PROFILE_MAX_BYTES,
  autoSellProfileId,
  autoSellProfileSha256,
  autoSellProfileTermsJson,
  readSavedAutoSellProfile,
  requireAutoSellProfileSummary,
  requireAutoSellProfileTerms,
  type AutoSellProfileTerms,
  type SavedAutoSellProfile,
} from './auto-sell-profile';

const projectId = '11111111-1111-4111-8111-111111111111';
const address = '11111111111111111111111111111111';
const mint = 'So11111111111111111111111111111111111111112';
function terms(): AutoSellProfileTerms {
  return {
    name: 'Exit configuration',
    projectId,
    projectRevision: 1,
    token: { chain: 'Solana', mint, decimals: 6, totalSupplyRaw: '1000000000' },
    wallets: [{ address, revision: 1 }],
    configuration: {
      strategies: [
        { ...newAutoSellStrategy(0), id: 'counter', replicationPercent: '100' },
      ],
      session: {
        startDelaySeconds: 0,
        endDurationSeconds: 60,
        endMaxSupplyPercent: '10',
        maxSlippageBps: 50,
      },
    },
  };
}
async function saved(value = terms()): Promise<SavedAutoSellProfile> {
  return {
    format: 'auto-sell-profile-v1',
    id: '22222222-2222-4222-8222-222222222222',
    profileId: '33333333-3333-4333-8333-333333333333',
    version: 1,
    createdAt: '2026-10-25T00:00:00.000Z',
    sha256: await autoSellProfileSha256(autoSellProfileTermsJson(value)),
    terms: value,
    signingAllowed: false,
    executionAllowed: false,
    automaticResumeAllowed: false,
  };
}

it('preserves complete Counter, DCA and Limit settings and all ordering without runner state', () => {
  const input = terms();
  const counter = input.configuration.strategies[0];
  counter.name = ' Counter with retained whitespace ';
  counter.trigger = { kind: 'min-sol', amount: '0.1' };
  counter.whitelist = [mint, address, mint];
  counter.endMaxTokenAmount = '1.25';
  counter.endMaxSupplyPercent = '';
  const dca = {
    ...newAutoSellStrategy(1),
    id: 'dca',
    mode: 'dca' as const,
    name: 'DCA',
    amountUnit: 'tokens' as const,
    dcaRandomized: true,
    dcaMinAmount: '1',
    dcaMaxAmount: '2',
    dcaIntervalSeconds: 86400,
  };
  const limit = {
    ...newAutoSellStrategy(2),
    id: 'limit',
    mode: 'limit' as const,
    name: 'Limit',
    limitOrders: [
      { id: 'one', amount: '1', marketCapUsd: '1000' },
      { id: 'two', amount: '2', marketCapUsd: '2000' },
    ],
  };
  input.configuration.strategies.push(dca, limit);
  input.wallets.push({ address: mint, revision: 2 });
  expect(requireAutoSellProfileTerms(input)).toEqual(input);
  const projected = requireAutoSellProfileTerms(input);
  input.configuration.strategies[0].whitelist.push(projectId);
  input.wallets[0].revision = 99;
  expect(projected.configuration.strategies[0].whitelist).toEqual([
    mint,
    address,
    mint,
  ]);
  expect(projected.wallets[0].revision).toBe(1);
});

it('canonicalizes object key order but preserves array order and known optional undefined semantics', () => {
  const input = terms();
  const reverse = (value: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(value).reverse());
  const reordered = reverse(input as unknown as Record<string, unknown>);
  reordered.token = reverse(input.token);
  reordered.configuration = reverse(
    input.configuration as unknown as Record<string, unknown>,
  );
  expect(autoSellProfileTermsJson(reordered)).toBe(
    autoSellProfileTermsJson(input),
  );
  input.configuration.strategies[0].endMaxTokenAmount = undefined;
  input.configuration.session.maxSlippageBps = undefined;
  const before = autoSellProfileTermsJson(input);
  delete input.configuration.strategies[0].endMaxTokenAmount;
  delete input.configuration.session.maxSlippageBps;
  expect(autoSellProfileTermsJson(input)).toBe(before);
  input.wallets.push({ address: mint, revision: 1 });
  const ordered = autoSellProfileTermsJson(input);
  input.wallets.reverse();
  expect(autoSellProfileTermsJson(input)).not.toBe(ordered);
});

it.each([0, 9, 10, 255])(
  'preserves supported imported token precision %s without granting execution',
  (decimals) => {
    const input = terms();
    input.token.decimals = decimals;
    expect(requireAutoSellProfileTerms(input).token.decimals).toBe(decimals);
  },
);

it.each([
  (v: AutoSellProfileTerms) => {
    v.projectId = 'not-a-uuid';
  },
  (v: AutoSellProfileTerms) => {
    v.projectRevision = 0;
  },
  (v: AutoSellProfileTerms) => {
    v.projectRevision = Number.MAX_SAFE_INTEGER + 1;
  },
  (v: AutoSellProfileTerms) => {
    v.token.decimals = 256;
  },
  (v: AutoSellProfileTerms) => {
    v.token.decimals = -1;
  },
  (v: AutoSellProfileTerms) => {
    v.token.totalSupplyRaw = '0';
  },
  (v: AutoSellProfileTerms) => {
    v.token.totalSupplyRaw = '01';
  },
  (v: AutoSellProfileTerms) => {
    v.token.totalSupplyRaw = '18446744073709551616';
  },
  (v: AutoSellProfileTerms) => {
    v.token.mint = '0'.repeat(32);
  },
  (v: AutoSellProfileTerms) => {
    v.wallets[0].address = '1'.repeat(33);
  },
  (v: AutoSellProfileTerms) => {
    v.wallets[0].revision = 0;
  },
  (v: AutoSellProfileTerms) => {
    v.wallets.push({ ...v.wallets[0] });
  },
  (v: AutoSellProfileTerms) => {
    v.configuration.strategies[0].dcaAmount = 'x'.repeat(81);
  },
  (v: AutoSellProfileTerms) => {
    v.configuration.strategies[0].dcaRandomized = 1 as unknown as boolean;
  },
  (v: AutoSellProfileTerms) => {
    v.configuration.strategies[0].limitOrders = Array.from(
      { length: 11 },
      (_, i) => ({ id: String(i), amount: '', marketCapUsd: '' }),
    );
  },
  (v: AutoSellProfileTerms) => {
    v.configuration.session.maxSlippageBps = 51;
  },
])(
  'refuses invalid context, duplicate wallets and inactive-field violations %#',
  (mutate) => {
    const value = terms();
    mutate(value);
    expect(() => requireAutoSellProfileTerms(value)).toThrow();
  },
);

it('admits the maximum u64 supply exactly as text', () => {
  const input = terms();
  input.token.totalSupplyRaw = '18446744073709551615';
  expect(requireAutoSellProfileTerms(input).token.totalSupplyRaw).toBe(
    '18446744073709551615',
  );
});

it.each(['password', 'vault', 'approved', 'signature', 'running', '__proto__'])(
  'rejects forbidden or unknown field %s at every storage depth',
  (key) => {
    for (const select of [
      (v: AutoSellProfileTerms) => v,
      (v: AutoSellProfileTerms) => v.token,
      (v: AutoSellProfileTerms) => v.wallets[0],
      (v: AutoSellProfileTerms) => v.configuration,
      (v: AutoSellProfileTerms) => v.configuration.strategies[0],
      (v: AutoSellProfileTerms) => v.configuration.strategies[0].trigger,
      (v: AutoSellProfileTerms) => v.configuration.session,
    ]) {
      const input = terms();
      Object.defineProperty(select(input), key, {
        value: 'sensitive',
        enumerable: true,
      });
      expect(() => requireAutoSellProfileTerms(input)).toThrow();
    }
  },
);

it('refuses accessors without invoking them, sparse arrays, custom prototypes and non-data properties', () => {
  let invoked = false;
  const input = terms();
  Object.defineProperty(input, 'name', {
    enumerable: true,
    get() {
      invoked = true;
      return 'secret';
    },
  });
  expect(() => requireAutoSellProfileTerms(input)).toThrow();
  expect(invoked).toBe(false);
  const arrayInput = terms();
  Object.defineProperty(arrayInput.wallets, '0', {
    enumerable: true,
    get() {
      invoked = true;
      return { address, revision: 1 };
    },
  });
  expect(() => requireAutoSellProfileTerms(arrayInput)).toThrow();
  expect(invoked).toBe(false);
  const sparse = terms();
  sparse.wallets = [];
  sparse.wallets.length = 1;
  expect(() => requireAutoSellProfileTerms(sparse)).toThrow();
  const inherited = Object.assign(
    Object.create({ password: 'secret' }),
    terms(),
  );
  expect(() => requireAutoSellProfileTerms(inherited)).toThrow();
  const extra = terms();
  Object.defineProperty(extra.configuration, Symbol('secret'), { value: true });
  expect(() => requireAutoSellProfileTerms(extra)).toThrow();
  const hidden = terms();
  Object.defineProperty(hidden.configuration, 'session', {
    value: hidden.configuration.session,
    enumerable: false,
  });
  expect(() => requireAutoSellProfileTerms(hidden)).toThrow();
  const namedArray = terms();
  Object.assign(namedArray.wallets, { password: 'secret' });
  expect(() => requireAutoSellProfileTerms(namedArray)).toThrow();
});

it('retains existing semantic refusals after structural admission', () => {
  const duplicate = terms();
  duplicate.configuration.strategies.push({
    ...duplicate.configuration.strategies[0],
  });
  expect(() => requireAutoSellProfileTerms(duplicate)).toThrow(
    'unique identifier',
  );
  const dca = terms();
  Object.assign(dca.configuration.strategies[0], {
    mode: 'dca',
    dcaAmount: '1',
    dcaIntervalSeconds: 9,
  });
  expect(() => requireAutoSellProfileTerms(dca)).toThrow('Interval');
  const limit = terms();
  Object.assign(limit.configuration.strategies[0], {
    mode: 'limit',
    limitOrders: [
      { id: 'a', amount: '1', marketCapUsd: '100' },
      { id: 'b', amount: '1', marketCapUsd: '100' },
    ],
  });
  expect(() => requireAutoSellProfileTerms(limit)).toThrow('higher');
  const mixed = terms();
  mixed.configuration.session.endMaxTokenAmount = '1';
  expect(() => requireAutoSellProfileTerms(mixed)).toThrow();
});

function distinctWallet(index: number) {
  const bytes = new Uint8Array(32).fill(255);
  bytes[30] = index >> 8;
  bytes[31] = index & 255;
  return bs58.encode(bytes);
}
it('enforces selected-wallet and ignored-address limits independently of overall capacity', () => {
  const input = terms();
  input.wallets = Array.from({ length: 500 }, (_, i) => ({
    address: distinctWallet(i),
    revision: 1,
  }));
  input.configuration.strategies[0].whitelist = Array(1024).fill(mint);
  expect(requireAutoSellProfileTerms(input).wallets).toHaveLength(500);
  input.wallets.push({ address: distinctWallet(500), revision: 1 });
  expect(() => requireAutoSellProfileTerms(input)).toThrow();
  input.wallets.pop();
  input.configuration.strategies[0].whitelist.push(mint);
  expect(() => requireAutoSellProfileTerms(input)).toThrow();
});

it('admits exactly262144 UTF8 bytes and refuses one more byte without truncation', () => {
  const input = terms();
  input.name = 'P';
  input.wallets = Array.from({ length: 500 }, (_, i) => ({
    address: distinctWallet(i),
    revision: 1,
  }));
  input.configuration.strategies = Array.from({ length: 5 }, (_, i) => ({
    ...newAutoSellStrategy(i),
    id: `strategy${i}`,
    replicationPercent: '100',
    whitelist: Array(1024).fill(distinctWallet(0)),
  }));
  const size = () => new TextEncoder().encode(JSON.stringify(input)).byteLength;
  expect(size()).toBeGreaterThan(AUTO_SELL_PROFILE_MAX_BYTES);
  while (size() > AUTO_SELL_PROFILE_MAX_BYTES)
    input.configuration.strategies[4].whitelist.pop();
  input.name += 'x'.repeat(AUTO_SELL_PROFILE_MAX_BYTES - size());
  expect(
    new TextEncoder().encode(autoSellProfileTermsJson(input)),
  ).toHaveLength(AUTO_SELL_PROFILE_MAX_BYTES);
  const boundaryName = input.name;
  input.name = 'é' + input.name.slice(1);
  expect(input.name.length).toBe(boundaryName.length);
  expect(() => requireAutoSellProfileTerms(input)).toThrow('capacity');
  input.name = boundaryName;
  input.name += 'x';
  expect(() => requireAutoSellProfileTerms(input)).toThrow('capacity');
});

it('admits only lean detached index metadata without claiming to verify its configuration hash', async () => {
  const full = await saved();
  const index = {
    id: full.id,
    profileId: full.profileId,
    version: full.version,
    name: full.terms.name,
    projectRevision: full.terms.projectRevision,
    createdAt: full.createdAt,
    sha256: '0'.repeat(64),
    token: full.terms.token,
    walletCount: 1,
    strategyCount: 1,
  };
  const copy = requireAutoSellProfileSummary(index);
  expect(copy).toEqual(index);
  expect(copy).not.toHaveProperty('terms');
  expect(copy).not.toHaveProperty('signingAllowed');
  index.token.decimals = 255;
  expect(copy.token.decimals).toBe(6);
  expect(requireAutoSellProfileSummary(index).token.decimals).toBe(255);
  for (const field of [
    'terms',
    'password',
    'signingAllowed',
    'executionAllowed',
    'automaticResumeAllowed',
  ])
    expect(() =>
      requireAutoSellProfileSummary({ ...index, [field]: false }),
    ).toThrow();
  let invoked = false;
  Object.defineProperty(index.token, 'mint', {
    enumerable: true,
    get() {
      invoked = true;
      return mint;
    },
  });
  expect(() => requireAutoSellProfileSummary(index)).toThrow();
  expect(invoked).toBe(false);
});

it.each([
  { walletCount: 0 },
  { walletCount: 501 },
  { walletCount: '1' },
  { strategyCount: 0 },
  { strategyCount: 6 },
  { strategyCount: 1.5 },
  { createdAt: '2026-10-25' },
  { version: -1 },
  { projectRevision: 0 },
  { id: 'invalid' },
  { sha256: 'not-a-sha' },
])('refuses malformed saved-index metadata %#', async (patch) => {
  const full = await saved();
  const index = {
    id: full.id,
    profileId: full.profileId,
    version: 1,
    name: full.terms.name,
    projectRevision: 1,
    createdAt: full.createdAt,
    sha256: full.sha256,
    token: full.terms.token,
    walletCount: 1,
    strategyCount: 1,
    ...patch,
  };
  expect(() => requireAutoSellProfileSummary(index)).toThrow();
});

it('hashes canonical terms and reads a detached saved envelope with false authority flags', async () => {
  expect(await autoSellProfileSha256('abc')).toBe(
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  const input = await saved();
  const result = await readSavedAutoSellProfile(input);
  expect(result).toEqual(input);
  input.terms.wallets[0].revision = 99;
  expect(result.terms.wallets[0].revision).toBe(1);
  expect([
    result.signingAllowed,
    result.executionAllowed,
    result.automaticResumeAllowed,
  ]).toEqual([false, false, false]);
});

it.each(['signingAllowed', 'executionAllowed', 'automaticResumeAllowed'])(
  'refuses a saved %s authority claim',
  async (key) => {
    const input = { ...(await saved()), [key]: true };
    await expect(readSavedAutoSellProfile(input)).rejects.toThrow();
  },
);
it('refuses changed terms, malformed identifiers/timestamps and unknown saved metadata', async () => {
  const changed = await saved();
  changed.terms.name = 'Changed';
  await expect(readSavedAutoSellProfile(changed)).rejects.toThrow(
    'hash differs',
  );
  for (const patch of [
    { id: 'invalid' },
    { profileId: 'invalid' },
    { version: 0 },
    { version: 1.5 },
    { createdAt: '2026-02-30T00:00:00.000Z' },
    { sha256: 'A'.repeat(64) },
    { password: 'secret' },
  ])
    await expect(
      readSavedAutoSellProfile({ ...(await saved()), ...patch }),
    ).rejects.toThrow();
  expect(autoSellProfileId(projectId)).toBe(projectId);
  expect(() =>
    autoSellProfileId(projectId.toUpperCase().replace('1111', 'ABCD')),
  ).toThrow();
});
