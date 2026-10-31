import { expect, it } from 'vitest';
import {
  CPMM_MATCHED_SOURCE_IDENTITY,
  requireJitoCpmmResearchIdentities,
  requireJitoCpmmSetupResearchIdentities,
  CPMM_INITIALIZE_V2_SOURCE_IDENTITY,
  requireJitoCpmmV2SetupResearchIdentities,
} from './jito-cpmm-source-identity';
import {
  PAIR_TRUSTED_PROGRAMS,
  requirePairTrustedPrograms,
  type PairObservedProgram,
} from './pair-trusted-programs';
const system = '11111111111111111111111111111111',
  token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function researchIdentities(): PairObservedProgram[] {
  return [system, token]
    .map<PairObservedProgram>((address) => {
      const p = PAIR_TRUSTED_PROGRAMS.find((p) => p.address === address)!;
      return {
        address,
        loader: p.loader,
        identityKind: p.identityKind,
        upgradeAuthority: p.upgradeAuthority,
        codeSha256: p.codeSha256[0],
        codeBytes: address === system ? 21 : 108600,
        programData: null,
        deploymentSlot: null,
      };
    })
    .concat([{ ...CPMM_MATCHED_SOURCE_IDENTITY }]);
}
it('matches the built source identity without adding it to shared signing policy', () => {
  const a = researchIdentities();
  expect(
    requireJitoCpmmResearchIdentities(a, structuredClone(a)),
  ).toMatchObject({
    matchedSourceIdentityChecked: true,
    reviewedCodePolicyMatched: false,
    sourceAuthenticated: false,
    programApproved: false,
    signingAllowed: false,
  });
  expect(() => requirePairTrustedPrograms(a, a)).toThrow();
  expect(
    PAIR_TRUSTED_PROGRAMS.some(
      (p) => p.address === CPMM_MATCHED_SOURCE_IDENTITY.address,
    ),
  ).toBe(false);
});
it.each(Object.keys(CPMM_MATCHED_SOURCE_IDENTITY))(
  'refuses changed CPMM %s, even across identical scans',
  (key) => {
    const a = researchIdentities(),
      cp = a.at(-1)!;
    (cp as unknown as Record<string, unknown>)[key] =
      key === 'codeBytes' ? 793825 : 'changed';
    expect(() => requireJitoCpmmResearchIdentities(a, a)).toThrow();
  },
);
it('requires three distinct complete matching scans and retains standard program pins', () => {
  const a = researchIdentities(),
    b = structuredClone(a);
  b[1].codeSha256 = '0'.repeat(64);
  expect(() => requireJitoCpmmResearchIdentities(a, b)).toThrow();
  expect(() => requireJitoCpmmResearchIdentities(b, b)).toThrow();
  const shorter = a.slice(1);
  expect(() => requireJitoCpmmResearchIdentities(shorter, shorter)).toThrow();
  const duplicate = [a[0], a[0], a[2]];
  expect(() =>
    requireJitoCpmmResearchIdentities(duplicate, duplicate),
  ).toThrow();
});

function setupIdentities(): PairObservedProgram[] {
  const address = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
  const p = PAIR_TRUSTED_PROGRAMS.find((p) => p.address === address)!;
  return [
    ...researchIdentities(),
    {
      address,
      loader: p.loader,
      identityKind: p.identityKind,
      upgradeAuthority: p.upgradeAuthority,
      codeSha256: p.codeSha256[0],
      codeBytes: 105032,
      programData: null,
      deploymentSlot: null,
    },
  ];
}
it('isolates the independently built initialize_v2 artifact from old and shared profiles', () => {
  const old = setupIdentities(),
    current = setupIdentities();
  Object.assign(
    current.find((p) => p.address === CPMM_MATCHED_SOURCE_IDENTITY.address)!,
    CPMM_INITIALIZE_V2_SOURCE_IDENTITY,
  );
  expect(
    requireJitoCpmmV2SetupResearchIdentities(current, structuredClone(current)),
  ).toMatchObject({
    sourceRevision: '40cbd81ee1014eee27c123d8846558c402f6c5fb',
    matchedSourceIdentityChecked: true,
    programApproved: false,
    signingAllowed: false,
    executionAllowed: false,
  });
  expect(() => requireJitoCpmmV2SetupResearchIdentities(old, old)).toThrow();
  expect(() =>
    requireJitoCpmmSetupResearchIdentities(current, current),
  ).toThrow();
  expect(() => requirePairTrustedPrograms(current, current)).toThrow();
});
it.each(Object.keys(CPMM_INITIALIZE_V2_SOURCE_IDENTITY))(
  'refuses changed v2 %s even across identical scans',
  (key) => {
    const a = setupIdentities();
    const cp = a.find(
      (p) => p.address === CPMM_MATCHED_SOURCE_IDENTITY.address,
    )!;
    Object.assign(cp, CPMM_INITIALIZE_V2_SOURCE_IDENTITY);
    (cp as unknown as Record<string, unknown>)[key] =
      key === 'codeBytes' ? 793825 : 'changed';
    expect(() => requireJitoCpmmV2SetupResearchIdentities(a, a)).toThrow();
  },
);
it('isolates the four-program setup profile and retains every shared pin', () => {
  const a = setupIdentities();
  expect(
    requireJitoCpmmSetupResearchIdentities(a, structuredClone(a)),
  ).toMatchObject({
    ataSetupProgramChecked: true,
    matchedSourceIdentityChecked: true,
    reviewedCodePolicyMatched: false,
    programApproved: false,
    signingAllowed: false,
  });
  expect(() => requireJitoCpmmResearchIdentities(a, a)).toThrow();
  expect(() =>
    requireJitoCpmmSetupResearchIdentities(
      researchIdentities(),
      researchIdentities(),
    ),
  ).toThrow();
  expect(() => requirePairTrustedPrograms(a, a)).toThrow();
});
it.each([
  'address',
  'loader',
  'identityKind',
  'upgradeAuthority',
  'codeSha256',
  'codeBytes',
  'programData',
  'deploymentSlot',
])('refuses changed ATA %s even when both scans agree', (field) => {
  const a = setupIdentities();
  (a.at(-1)! as unknown as Record<string, unknown>)[field] =
    field === 'codeBytes' ? 105033 : 'changed';
  expect(() => requireJitoCpmmSetupResearchIdentities(a, a)).toThrow();
});
