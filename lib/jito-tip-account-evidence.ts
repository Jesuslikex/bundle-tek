import { address, getProgramDerivedAddress } from '@solana/kit';
import { PUMP_GROUP_JITO_TIP_ACCOUNTS } from './pump-group-broadcast';
import { snapshotJitoEvidence } from './jito-evidence-json';
import {
  inspectPairRentAccount,
  pairRentMinimumRaw,
} from './pair-rent-evidence';

// Account layout and singleton seeds, not approval to execute this program.
// jito-foundation/jito-programs ce1dfb6b3f6c423bf206ec1f24df911d292aa409
export const JITO_TIP_PAYMENT_OWNER =
  'T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt';
const destinations = new Set<string>(PUMP_GROUP_JITO_TIP_ACCOUNTS);
const discriminator = 'ySH0dOBEYSg='; // SHA-256("account:TipPaymentAccount")[0..8]
const fail = (): never => {
  throw Error('Jito tip receiver identity, layout or rent differs.');
};

/** Supplied account evidence only. A System transfer credits this PDA; it does
 * not invoke the Tip Payment program or establish its binary provenance. */
export async function inspectJitoTipReceiver(input: {
  address: string;
  account: unknown;
  rentAccount: unknown;
}) {
  const value = snapshotJitoEvidence(input, 4096);
  const a = value.account as {
    owner?: unknown;
    executable?: unknown;
    lamports?: unknown;
    data?: unknown;
    space?: unknown;
  } | null;
  if (
    !destinations.has(value.address) ||
    !a ||
    a.owner !== JITO_TIP_PAYMENT_OWNER ||
    a.executable !== false ||
    typeof a.lamports !== 'string' ||
    !/^(0|[1-9]\d{0,19})$/.test(a.lamports) ||
    BigInt(a.lamports) > (1n << 64n) - 1n ||
    (a.space !== undefined && a.space !== '8') ||
    !Array.isArray(a.data) ||
    a.data.length !== 2 ||
    a.data[0] !== discriminator ||
    a.data[1] !== 'base64'
  )
    return fail();
  const minimum = pairRentMinimumRaw(
    inspectPairRentAccount(value.rentAccount),
    8,
  );
  if (BigInt(a.lamports) < BigInt(minimum)) return fail();
  const derived = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      getProgramDerivedAddress({
        programAddress: address(JITO_TIP_PAYMENT_OWNER),
        seeds: [new TextEncoder().encode(`TIP_ACCOUNT_${i}`)],
      }).then(([key]) => key as string),
    ),
  );
  if (
    destinations.size !== 8 ||
    new Set(derived).size !== 8 ||
    derived.some((key) => !destinations.has(key))
  )
    return fail();
  const seedIndex = derived.indexOf(value.address);
  if (seedIndex < 0) return fail();
  return {
    address: value.address,
    seedIndex,
    owner: JITO_TIP_PAYMENT_OWNER,
    accountBytes: 8 as const,
    requiredRentLamports: minimum,
    lamports: a.lamports,
    pdaAndLayoutChecked: true as const,
    sourceAuthenticated: false as const,
    bankVerified: false as const,
    programApproved: false as const,
    signingAllowed: false as const,
    executionAllowed: false as const,
  };
}
