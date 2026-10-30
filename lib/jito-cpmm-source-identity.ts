import {
  requirePairTrustedPrograms,
  type PairObservedProgram,
} from './pair-trusted-programs';
import { snapshotJitoEvidence } from './jito-evidence-json';

/** Research reference only, matched by a controlled build in
 * docs/CODEX-RAYDIUM-BUILD-MATCH-20261030.json. Not a signing allowlist. */
export const CPMM_MATCHED_SOURCE_IDENTITY = Object.freeze({
  address: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  loader: 'BPFLoaderUpgradeab1e11111111111111111111111',
  programData: 'DMawCQzbgNTmbzaESc7o6pvL1KAeetY8zA7jNpzntHhU',
  deploymentSlot: '452376460',
  upgradeAuthority: 'FytDrVzDybM1TwFQPGb8qaxZR7dBCzNeqT3vtQsceZQK',
  codeSha256:
    'b6dbea8cefc2e7d490775ce6115e34a2ba480c0853c359e0bb4043b9381ef09a',
  codeBytes: 793824,
  identityKind: 'elf-code',
});
const SYSTEM = '11111111111111111111111111111111',
  TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const fail = (): never => {
  throw Error('CPMM matched-source research identity refused.');
};
/** Both complete inventories must match, with exactly System, classic Token and
 * the built CPMM reference. Shared trusted-program policy remains unchanged. */
export function requireJitoCpmmResearchIdentities(
  first: readonly PairObservedProgram[],
  last: readonly PairObservedProgram[],
) {
  const a = snapshotJitoEvidence(first, 16384),
    b = snapshotJitoEvidence(last, 16384);
  if (
    !Array.isArray(a) ||
    a.length !== 3 ||
    JSON.stringify(a) !== JSON.stringify(b) ||
    new Set(a.map((p) => p?.address)).size !== 3 ||
    a.some(
      (p) =>
        !p ||
        ![SYSTEM, TOKEN, CPMM_MATCHED_SOURCE_IDENTITY.address].includes(
          p.address,
        ) ||
        Object.keys(p).length !== 8,
    )
  )
    return fail();
  const cp = a.find((p) => p.address === CPMM_MATCHED_SOURCE_IDENTITY.address)!;
  for (const [key, expected] of Object.entries(CPMM_MATCHED_SOURCE_IDENTITY))
    if (cp[key as keyof typeof cp] !== expected) return fail();
  const standard = a.filter(
    (p) => p.address !== CPMM_MATCHED_SOURCE_IDENTITY.address,
  );
  requirePairTrustedPrograms(standard, standard);
  if (
    standard.find((p) => p.address === SYSTEM)?.codeBytes !== 21 ||
    standard.find((p) => p.address === TOKEN)?.codeBytes !== 108600
  )
    return fail();
  return {
    sourceRevision: 'f4b9b26342afe9122d5ff67cd7a4f19ded4ac0a5' as const,
    matchedSourceIdentityChecked: true as const,
    reviewedCodePolicyMatched: false as const,
    programApproved: false as const,
    sourceAuthenticated: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
