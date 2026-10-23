import { expect, it } from 'vitest';
import { counterRuntimeUiFixture } from '../test/counter-runtime-ui-fixture';
import {
  counterRuntimeView,
  type CounterRuntimeEvidenceView,
} from './counter-runtime-view';
import { pairRuntimeDigest } from './pair-runtime-trace';
async function rehash(runtime: CounterRuntimeEvidenceView) {
  const { sha256: _sha, ...receipt } = runtime;
  runtime.sha256 = await pairRuntimeDigest(receipt);
}
it('admits exact base preview plus bounded two-scan ordinary-Clock code identity without trusted-policy authority', async () => {
  const f = await counterRuntimeUiFixture();
  expect(
    await counterRuntimeView(
      { preview: f.preview, runtime: f.runtime },
      f.plan,
      f.request,
    ),
  ).toEqual({ preview: f.preview, runtime: f.runtime });
});
it.each([
  'signingAllowed',
  'executionAllowed',
  'programCodeAttested',
  'semanticAuditEstablished',
  'trustedProgramPolicyEstablished',
  'innerInstructionPolicyVerified',
])(
  'refuses elevated %s even with a matching public receipt hash',
  async (key) => {
    const f = await counterRuntimeUiFixture();
    Object.assign(f.runtime, { [key]: true });
    await rehash(f.runtime);
    await expect(
      counterRuntimeView(
        { preview: f.preview, runtime: f.runtime },
        f.plan,
        f.request,
      ),
    ).rejects.toThrow();
  },
);
it.each(['codeIdentityObserved', 'ordinaryClockVerified'])(
  'requires exact positive evidence %s',
  async (key) => {
    const f = await counterRuntimeUiFixture();
    Object.assign(f.runtime, { [key]: false });
    await rehash(f.runtime);
    await expect(
      counterRuntimeView(
        { preview: f.preview, runtime: f.runtime },
        f.plan,
        f.request,
      ),
    ).rejects.toThrow();
  },
);
it('refuses unknown wrapper/receipt fields, wrong packet binding and damaged digest', async () => {
  const f = await counterRuntimeUiFixture();
  for (const value of [
    { preview: f.preview, runtime: f.runtime, extra: false },
    {
      preview: f.preview,
      runtime: { ...f.runtime, automaticExecutionAllowed: false },
    },
    {
      preview: f.preview,
      runtime: { ...f.runtime, packetSha256: '5'.repeat(64) },
    },
    { preview: f.preview, runtime: { ...f.runtime, sha256: '5'.repeat(64) } },
  ])
    await expect(
      counterRuntimeView(value, f.plan, f.request),
    ).rejects.toThrow();
});
it('refuses missing/duplicate/unsorted program coverage and invalid native/loader/header identities', async () => {
  const f = await counterRuntimeUiFixture();
  const mutations: ((r: CounterRuntimeEvidenceView) => void)[] = [
    (r) => {
      r.programs = [];
    },
    (r) => {
      r.programs.push(r.programs[0]);
    },
    (r) => {
      r.programs.reverse();
    },
    (r) => {
      r.programs[0].identityKind = 'elf-code';
    },
    (r) => {
      r.programs[1].address = r.programs[2].address;
    },
    (r) => {
      r.programs[1].codeBytes = 46;
    },
    (r) => {
      r.programs[2].programData = r.programs[0].address;
    },
    (r) => {
      r.programs[2].loader = r.programs[0].loader;
    },
    (r) => {
      r.programs[2].codeBytes = 3;
    },
    (r) => {
      r.programs[2].address = 'not an address';
    },
  ];
  for (const mutate of mutations) {
    const r = structuredClone(f.runtime);
    mutate(r);
    await rehash(r);
    await expect(
      counterRuntimeView({ preview: f.preview, runtime: r }, f.plan, f.request),
    ).rejects.toThrow();
  }
});
it('checks the exact 32-slot bound, simulation inclusion, scan count and original expiry', async () => {
  const f = await counterRuntimeUiFixture();
  f.runtime.maximumSlot = 132;
  await rehash(f.runtime);
  expect(
    (
      await counterRuntimeView(
        { preview: f.preview, runtime: f.runtime },
        f.plan,
        f.request,
      )
    ).runtime.maximumSlot,
  ).toBe(132);
  const mutations: ((r: CounterRuntimeEvidenceView) => void)[] = [
    (r) => {
      r.maximumSlot = 133;
    },
    (r) => {
      r.minimumSlot = 111;
    },
    (r) => {
      r.simulationSlot = 99;
    },
    (r) => {
      r.simulationSlot = 134;
    },
    (r) => {
      Object.assign(r, { codeScanCount: 1 });
    },
    (r) => {
      r.expiresAt = r.observedAt;
    },
    (r) => {
      r.observedAt = new Date(
        Date.parse(f.preview.observedAt) + 1,
      ).toISOString();
    },
  ];
  for (const mutate of mutations) {
    const r = structuredClone(f.runtime);
    mutate(r);
    await rehash(r);
    await expect(
      counterRuntimeView({ preview: f.preview, runtime: r }, f.plan, f.request),
    ).rejects.toThrow();
  }
  await expect(
    counterRuntimeView(
      { preview: f.preview, runtime: f.runtime },
      f.plan,
      f.request,
      Date.parse(f.runtime.expiresAt),
    ),
  ).rejects.toThrow();
});
it('retains original base-preview context and amount safeguards', async () => {
  const f = await counterRuntimeUiFixture();
  for (const preview of [
    { ...f.preview, maximumQuoteInputRaw: '1006' },
    { ...f.preview, signingAllowed: true },
    { ...f.preview, walletRevision: 2 },
    { ...f.preview, automaticExecutionAllowed: false },
    {
      ...f.preview,
      observedAt: f.preview.observedAt.replace('.000Z', 'Z') + ' ',
    },
  ])
    await expect(
      counterRuntimeView({ preview, runtime: f.runtime }, f.plan, f.request),
    ).rejects.toThrow();
});
it('admits the existing native System empty identity and exact upgradeable deployment header profile', async () => {
  const f = await counterRuntimeUiFixture();
  f.runtime.programs[0].codeBytes = 0;
  const elf = f.runtime.programs[2];
  elf.loader = 'BPFLoaderUpgradeab1e11111111111111111111111';
  elf.programData = f.request.wallet;
  elf.deploymentSlot = '99';
  elf.upgradeAuthority = f.request.wallet;
  await rehash(f.runtime);
  expect(
    await counterRuntimeView(
      { preview: f.preview, runtime: f.runtime },
      f.plan,
      f.request,
    ),
  ).toBeTruthy();
  elf.deploymentSlot = '111';
  await rehash(f.runtime);
  await expect(
    counterRuntimeView(
      { preview: f.preview, runtime: f.runtime },
      f.plan,
      f.request,
    ),
  ).rejects.toThrow();
});
it('admits scan-start before simulation time and independent original packet expiry, using original receipt hash', async () => {
  const f = await counterRuntimeUiFixture();
  f.runtime.observedAt = new Date(
    Date.parse(f.preview.observedAt) - 1000,
  ).toISOString();
  f.runtime.expiresAt = new Date(
    Date.parse(f.runtime.expiresAt) - 1000,
  ).toISOString();
  f.preview.expiresAt = new Date(
    Date.parse(f.runtime.expiresAt) - 1000,
  ).toISOString();
  await rehash(f.runtime);
  expect(
    (
      await counterRuntimeView(
        { preview: f.preview, runtime: f.runtime },
        f.plan,
        f.request,
      )
    ).runtime.expiresAt,
  ).toBe(f.runtime.expiresAt);
});
it('checks bounded ordinary Clock receipts with exact integer 30-second skew and valid evaluation ordering', async () => {
  const f = await counterRuntimeUiFixture();
  const evaluated = Date.parse(f.preview.observedAt),
    rounded = Math.floor(evaluated / 1000) * 1000;
  for (const mutate of [
    (r: CounterRuntimeEvidenceView) => {
      r.clocks = [];
    },
    (r: CounterRuntimeEvidenceView) => {
      r.clocks[0].slot = 99;
    },
    (r: CounterRuntimeEvidenceView) => {
      r.clocks[0].unixTimestamp = String(Math.floor(evaluated / 1000) - 31);
    },
    (r: CounterRuntimeEvidenceView) => {
      r.clocks[0].unixTimestamp = '01';
    },
    (r: CounterRuntimeEvidenceView) => {
      r.clocks[0].evaluatedAt = new Date(evaluated - 1).toISOString();
    },
    (r: CounterRuntimeEvidenceView) => {
      r.clocks.push(...Array.from({ length: 300 }, () => r.clocks[0]));
    },
  ]) {
    const r = structuredClone(f.runtime);
    mutate(r);
    await rehash(r);
    await expect(
      counterRuntimeView({ preview: f.preview, runtime: r }, f.plan, f.request),
    ).rejects.toThrow();
  }
  f.preview.observedAt = new Date(rounded).toISOString();
  f.runtime.observedAt = f.preview.observedAt;
  f.preview.expiresAt = new Date(rounded + 30000).toISOString();
  f.runtime.expiresAt = f.preview.expiresAt;
  for (const c of f.runtime.clocks) {
    c.evaluatedAt = f.preview.observedAt;
    c.unixTimestamp = String(Math.floor(rounded / 1000) - 30);
  }
  await rehash(f.runtime);
  expect(
    await counterRuntimeView(
      { preview: f.preview, runtime: f.runtime },
      f.plan,
      f.request,
    ),
  ).toBeTruthy();
});
