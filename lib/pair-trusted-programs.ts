/**
 * Pinned stock-pair program policy. Every executable identity observed by BOTH
 * complete runtime code scans must match one entry exactly: address, loader,
 * identity kind, upgrade authority and a reviewed code SHA-256. Any program not
 * listed, or listed without a reviewed hash, refuses the trade.
 *
 * ELF program hashes are intentionally empty until a reviewed live scan pins
 * them; this keeps production approval fail-closed even with the server flag on.
 */
export type PairTrustedProgram = {
  address: string;
  loader: string;
  identityKind: 'native-system' | 'native-marker' | 'elf-code';
  upgradeAuthority: string | null;
  codeSha256: readonly string[];
};
export type PairObservedProgram = {
  address: string;
  loader: string;
  programData: string | null;
  deploymentSlot: string | null;
  upgradeAuthority: string | null;
  codeSha256: string;
  codeBytes: number;
  identityKind: string;
};
const NATIVE = 'NativeLoader1111111111111111111111111111111',
  UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111',
  BPF2 = 'BPFLoader2111111111111111111111111111111111';
export const PAIR_TRUSTED_PROGRAMS: readonly PairTrustedProgram[] =
  Object.freeze([
    {
      address: '11111111111111111111111111111111',
      loader: NATIVE,
      identityKind: 'native-system',
      upgradeAuthority: null,
      // sha256("system_program"), the native loader account data.
      codeSha256: [
        'd8e11c483f20607a1e5f015d768e4dd294213e33b948a69640f7bacaaf25e280',
      ],
    },
    {
      address: 'ComputeBudget111111111111111111111111111111',
      loader: NATIVE,
      identityKind: 'native-marker',
      upgradeAuthority: null,
      // sha256("compute_budget_program"), the native loader account data.
      codeSha256: [
        '005950c007e8e550a16beddf836f0082d26d197f5f645ff7c04a5c8d171cf8a1',
      ],
    },
    {
      address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      loader: BPF2,
      identityKind: 'elf-code',
      upgradeAuthority: null,
      codeSha256: [],
    },
    {
      address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      loader: BPF2,
      identityKind: 'elf-code',
      upgradeAuthority: null,
      codeSha256: [],
    },
    {
      address: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      loader: UPGRADEABLE,
      identityKind: 'elf-code',
      upgradeAuthority: null,
      codeSha256: [],
    },
    {
      address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      loader: UPGRADEABLE,
      identityKind: 'elf-code',
      upgradeAuthority: null,
      codeSha256: [],
    },
  ]);

export class PairTrustedProgramError extends Error {}

/** Returns true only when both scans are identical and fully allowlisted. */
export function requirePairTrustedPrograms(
  firstScan: readonly PairObservedProgram[] | undefined,
  secondScan: readonly PairObservedProgram[] | undefined,
  allowlist: readonly PairTrustedProgram[] = PAIR_TRUSTED_PROGRAMS,
): true {
  if (
    !Array.isArray(firstScan) ||
    !Array.isArray(secondScan) ||
    !firstScan.length ||
    firstScan.length > 32 ||
    JSON.stringify(firstScan) !== JSON.stringify(secondScan)
  )
    throw new PairTrustedProgramError(
      'Both complete program code scans must match before trusted policy can apply.',
    );
  if (new Set(firstScan.map((p) => p.address)).size !== firstScan.length)
    throw new PairTrustedProgramError('Duplicate program identity observed.');
  for (const p of firstScan) {
    const trusted = allowlist.find((t) => t.address === p.address);
    if (!trusted)
      throw new PairTrustedProgramError(
        `Program ${p.address} is not on the trusted stock-pair allowlist.`,
      );
    if (
      p.loader !== trusted.loader ||
      p.identityKind !== trusted.identityKind ||
      p.upgradeAuthority !== trusted.upgradeAuthority ||
      typeof p.codeSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(p.codeSha256) ||
      !trusted.codeSha256.includes(p.codeSha256)
    )
      throw new PairTrustedProgramError(
        `Program ${p.address} code, loader or authority differs from its reviewed pin.`,
      );
  }
  return true;
}
