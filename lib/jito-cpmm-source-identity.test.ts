import { expect, it } from 'vitest';
import {
  CPMM_MATCHED_SOURCE_IDENTITY,
  requireJitoCpmmResearchIdentities,
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
