import { expect, it } from 'vitest';
import {
  PAIR_TRUSTED_PROGRAMS,
  PairTrustedProgramError,
  requirePairTrustedPrograms,
  type PairObservedProgram,
  type PairTrustedProgram,
} from './pair-trusted-programs';

const UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const jup: PairObservedProgram = {
  address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  loader: UPGRADEABLE,
  programData: '4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT',
  deploymentSlot: '1',
  upgradeAuthority: null,
  codeSha256: 'a'.repeat(64),
  codeBytes: 10,
  identityKind: 'elf-code',
};
const system: PairObservedProgram = {
  address: '11111111111111111111111111111111',
  loader: 'NativeLoader1111111111111111111111111111111',
  programData: null,
  deploymentSlot: null,
  upgradeAuthority: null,
  codeSha256:
    'd8e11c483f20607a1e5f015d768e4dd294213e33b948a69640f7bacaaf25e280',
  codeBytes: 14,
  identityKind: 'native-system',
};
const pinned: PairTrustedProgram[] = [
  {
    address: jup.address,
    loader: UPGRADEABLE,
    identityKind: 'elf-code',
    upgradeAuthority: null,
    codeSha256: ['a'.repeat(64)],
  },
  ...PAIR_TRUSTED_PROGRAMS.filter((p) => p.address === system.address),
];

it('accepts only identical complete scans fully matching reviewed pins', () => {
  expect(requirePairTrustedPrograms([jup, system], [jup, system], pinned)).toBe(
    true,
  );
});
it.each([
  ['missing second scan', [jup], undefined],
  ['empty scans', [], []],
  ['different scans', [jup], [{ ...jup, codeSha256: 'b'.repeat(64) }]],
  ['duplicate identity', [jup, jup], [jup, jup]],
  [
    'unlisted program',
    [{ ...jup, address: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP' }],
    [{ ...jup, address: '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP' }],
  ],
  [
    'changed code hash',
    [{ ...jup, codeSha256: 'c'.repeat(64) }],
    [{ ...jup, codeSha256: 'c'.repeat(64) }],
  ],
  [
    'changed loader',
    [{ ...jup, loader: 'BPFLoader2111111111111111111111111111111111' }],
    [{ ...jup, loader: 'BPFLoader2111111111111111111111111111111111' }],
  ],
  [
    'new upgrade authority',
    [{ ...jup, upgradeAuthority: system.address }],
    [{ ...jup, upgradeAuthority: system.address }],
  ],
  [
    'changed identity kind',
    [{ ...jup, identityKind: 'native-marker' }],
    [{ ...jup, identityKind: 'native-marker' }],
  ],
] as const)('refuses %s', (_name, a, b) => {
  expect(() =>
    requirePairTrustedPrograms(
      a as unknown as PairObservedProgram[],
      b as unknown as PairObservedProgram[] | undefined,
      pinned,
    ),
  ).toThrow(PairTrustedProgramError);
});
it('keeps the shipped allowlist fail-closed for ELF programs until reviewed hashes are pinned', () => {
  expect(() => requirePairTrustedPrograms([jup], [jup])).toThrow(
    /reviewed pin/,
  );
  for (const p of PAIR_TRUSTED_PROGRAMS)
    if (p.identityKind === 'elf-code') expect(p.codeSha256).toEqual([]);
  expect(requirePairTrustedPrograms([system], [system])).toBe(true);
});
