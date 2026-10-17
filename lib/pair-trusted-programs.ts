/**
 * Pinned stock-pair program policy. Every executable identity observed by BOTH
 * complete runtime code scans must match one entry exactly: address, loader,
 * identity kind, upgrade authority and a reviewed code SHA-256. Any program not
 * listed, or listed without a reviewed hash, refuses the trade.
 *
 * Pinned by the owner on 2026-10-17 from the read-only scan
 * scripts/scan-stock-trusted-programs.mjs at 2026-10-17T05:10:22Z (stable
 * across two passes). Any code upgrade or authority change refuses the trade
 * until a new reviewed scan.
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
    // System, 21 bytes.
    {
      address: '11111111111111111111111111111111',
      loader: NATIVE,
      identityKind: 'native-system',
      upgradeAuthority: null,
      codeSha256: [
        'c94b792a6d8b25d3e53ea94d8b80111735ed80d6a7dc8deb937cd342707f5f03',
      ],
    },
    // Route AMM (unlabelled), 617240 bytes.
    {
      address: 'AQU1FRd7papthgdrwPTTq5JacJh8YtwEXaBfKU3bTz45',
      loader: UPGRADEABLE,
      identityKind: 'elf-code',
      upgradeAuthority: '8pJhHxPQRiUGdtVSCNPyP9AH994zeyYEBGb5yZRzheSA',
      codeSha256: [
        '13014cfae34ffd3d4060859ea3a4093edd3cdc8604300eee9c6706d89141d058',
      ],
    },
    // Associated Token, 105032 bytes.
    {
      address: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      loader: BPF2,
      identityKind: 'elf-code',
      upgradeAuthority: null,
      codeSha256: [
        '6804554e69fd3a58caa191dc4a58f4c67223d30ca28ab8987f39fc18d2f7374d',
      ],
    },
    // Route AMM (unlabelled), 292944 bytes.
    {
      address: 'B72M6nyCLFgWiJtAN4naUTminMiTmyGcEqQHXwVeRdht',
      loader: UPGRADEABLE,
      identityKind: 'elf-code',
      upgradeAuthority: 'G5N5xrumrJe75DnndRBoqAhpLYRZTnRabMJjgJF4UUE2',
      codeSha256: [
        '94e02df4d4b078b2464c430803119b97f0511402b584c0b842bdfcc626523631',
      ],
    },
    // Route AMM (unlabelled), 252552 bytes.
    {
      address: 'BiSoNHVpsVZW2F7rx2eQ59yQwKxzU5NvBcmKshCSUypi',
      loader: UPGRADEABLE,
      identityKind: 'elf-code',
      upgradeAuthority: '6dDjBZdpafRKe7WuVHYTF1HphW1BWiKqioMD5eBGYipS',
      codeSha256: [
        '9b36724da2fa354f8fd89924f657add1e1c0a547dc5dc3028e8c327f544b1d5e',
      ],
    },
    // Compute Budget, 22 bytes.
    {
      address: 'ComputeBudget111111111111111111111111111111',
      loader: NATIVE,
      identityKind: 'native-marker',
      upgradeAuthority: null,
      codeSha256: [
        '005950c007e8e550a16beddf836f0082d26d197f5f645ff7c04a5c8d171cf8a1',
      ],
    },
    // Jupiter v6, 2892224 bytes.
    {
      address: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      loader: UPGRADEABLE,
      identityKind: 'elf-code',
      upgradeAuthority: 'CvQZZ23qYDWF2RUpxYJ8y9K4skmuvYEEjH7fK58jtipQ',
      codeSha256: [
        '099da3a26d336aa7174960f057546f192fc1ccda8e3e9d1b4aa5c69fa8a79a5f',
      ],
    },
    // SPL Token, 108600 bytes.
    {
      address: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
      loader: UPGRADEABLE,
      identityKind: 'elf-code',
      upgradeAuthority: null,
      codeSha256: [
        '8190d3f7ceb6cb7a7a8d8924bff89f9f611e15ce1f806f2b6237f3311a98f697',
      ],
    },
    // Token-2022, 1382016 bytes.
    {
      address: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
      loader: UPGRADEABLE,
      identityKind: 'elf-code',
      upgradeAuthority: 'AeLmXCbPaQHGWRLr2saFsEVfmMNuKnxRAbWCT9P5twgz',
      codeSha256: [
        '0999dbf708971e723b08d1caafc988826a59c6001ed6dc02260da07defbe1469',
      ],
    },
    // Route AMM (unlabelled), 425440 bytes.
    {
      address: 'ZERor4xhbUycZ6gb9ntrhqscUcZmAbQDjEAtCf4hbZY',
      loader: UPGRADEABLE,
      identityKind: 'elf-code',
      upgradeAuthority: 'UPgd1zNpfgYRRcudZyubhKPrrYKL7vKRmw25SR6qto5',
      codeSha256: [
        '74e7243f70a4db8dc8b99e265d8cd706afd0c30e66600157ef81529ed784ec43',
      ],
    },
    // Riptide, 258992 bytes.
    {
      address: 'riptK81hDxhe5pW5jSzSM9iRA8azgEgLJ4dXkPtBS7j',
      loader: UPGRADEABLE,
      identityKind: 'elf-code',
      upgradeAuthority: 'GwH3Hiv5mACLX3ufTw1pFsrhSPon5tdw252DBs4Rx4PV',
      codeSha256: [
        '32a8a8f75662cfdc8d29abe4bf6826c9c027a4b9222d544f46285762c661ab86',
      ],
    },
    // Orca Whirlpool, 10485715 bytes.
    {
      address: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
      loader: UPGRADEABLE,
      identityKind: 'elf-code',
      upgradeAuthority: 'GwH3Hiv5mACLX3ufTw1pFsrhSPon5tdw252DBs4Rx4PV',
      codeSha256: [
        'c422b22f3eefe86dd55878a4f505b9c68c26e241dc96af1573ca032b24b8ee3f',
      ],
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
