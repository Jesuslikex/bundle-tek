import { address, getProgramDerivedAddress } from '@solana/kit';
import bs58 from 'bs58';
import { snapshotJitoEvidence } from './jito-evidence-json';

// Candidate inspection only. The controlled source/build match is recorded in
// CODEX-RAYDIUM-BUILD-MATCH-20261030.json; this inspector does not authenticate
// live program bytes and grants no route or signing authority.
const CPMM = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const DISCRIMINATOR = '8fbe5adac41e33de';
const U64 = (1n << 64n) - 1n;
type Meta = { address: string; signer: boolean; writable: boolean };
type Candidate = {
  program: string;
  dataHex: string;
  accounts: Meta[];
  expected: {
    payer: string;
    inputMint: string;
    outputMint: string;
    inputRaw: string;
    minimumOutputRaw: string;
  };
};
const fail = (): never => {
  throw Error('CPMM candidate instruction refused.');
};
function exact(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function key(value: unknown): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44)
    return fail();
  try {
    const bytes = bs58.decode(value);
    if (bytes.length === 32 && bs58.encode(bytes) === value) return value;
  } catch {
    /* Refuse below. */
  }
  return fail();
}
function amount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value))
    return fail();
  const n = BigInt(value);
  if (n > U64) return fail();
  return n;
}
async function associated(payer: string, mint: string) {
  const [result] = await getProgramDerivedAddress({
    programAddress: address(ATA),
    seeds: [bs58.decode(payer), bs58.decode(TOKEN), bs58.decode(mint)],
  });
  return result;
}
/**
 * Checks only a supplied candidate's instruction shape, amount bindings, and
 * canonical addresses. The candidate and expected values are not independently
 * authenticated. It does not inspect packet bytes, chain accounts or prices.
 */
export async function inspectJitoCpmmCandidateInstruction(input: Candidate) {
  const copied = snapshotJitoEvidence(input, 16384);
  if (
    !exact(copied, ['program', 'dataHex', 'accounts', 'expected']) ||
    copied.program !== CPMM ||
    !exact(copied.expected, [
      'payer',
      'inputMint',
      'outputMint',
      'inputRaw',
      'minimumOutputRaw',
    ]) ||
    !Array.isArray(copied.accounts) ||
    copied.accounts.length !== 13 ||
    typeof copied.dataHex !== 'string' ||
    !/^[0-9a-f]{48}$/.test(copied.dataHex) ||
    !copied.dataHex.startsWith(DISCRIMINATOR)
  )
    return fail();
  const accounts = copied.accounts;
  for (const meta of accounts) {
    if (
      !exact(meta, ['address', 'signer', 'writable']) ||
      typeof meta.signer !== 'boolean' ||
      typeof meta.writable !== 'boolean'
    )
      return fail();
    key(meta.address);
  }
  const expected = copied.expected;
  const payer = key(expected.payer),
    inputMint = key(expected.inputMint),
    outputMint = key(expected.outputMint);
  const inputRaw = amount(expected.inputRaw),
    minimumOutputRaw = amount(expected.minimumOutputRaw);
  if (
    inputMint === outputMint ||
    accounts[0].address !== payer ||
    accounts[10].address !== inputMint ||
    accounts[11].address !== outputMint ||
    accounts[8].address !== TOKEN ||
    accounts[9].address !== TOKEN ||
    accounts.some((a) => a.address === CPMM) ||
    !accounts[0].signer ||
    accounts.slice(1).some((a) => a.signer) ||
    [3, 4, 5, 6, 7, 12].some((i) => !accounts[i].writable) ||
    [1, 2, 8, 9, 10, 11].some((i) => accounts[i].writable)
  )
    return fail();
  const unique = accounts.map((a) => a.address).filter((_, i) => i !== 9);
  if (new Set(unique).size !== unique.length) return fail();
  const bytes = Buffer.from(copied.dataHex, 'hex');
  if (
    bytes.readBigUInt64LE(8) !== inputRaw ||
    bytes.readBigUInt64LE(16) !== minimumOutputRaw
  )
    return fail();
  const [authority, authorityBump] = await getProgramDerivedAddress({
    programAddress: address(CPMM),
    seeds: [new TextEncoder().encode('vault_and_lp_mint_auth_seed')],
  });
  const [source, destination] = await Promise.all([
    associated(payer, inputMint),
    associated(payer, outputMint),
  ]);
  if (
    accounts[1].address !== authority ||
    accounts[4].address !== source ||
    accounts[5].address !== destination
  )
    return fail();
  return {
    format: 'jito-cpmm-candidate-instruction-v1' as const,
    payer,
    inputMint,
    outputMint,
    inputRaw: inputRaw.toString(),
    minimumOutputRaw: minimumOutputRaw.toString(),
    pool: accounts[3].address,
    config: accounts[2].address,
    observation: accounts[12].address,
    authorityBump,
    authority: accounts[1].address,
    source: accounts[4].address,
    destination: accounts[5].address,
    inputVault: accounts[6].address,
    outputVault: accounts[7].address,
    instructionShapeChecked: true as const,
    sourceAuthenticated: false as const,
    programApproved: false as const,
    packetVerified: false as const,
    accountStateVerified: false as const,
    priceVerified: false as const,
    economicOutputVerified: false as const,
    providerQualified: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
