import {
  swapToken2022Programs,
  type SwapToken2022Evidence,
} from './swap-token-program-evidence';

type Row = Record<string, unknown>;
function shape(value: unknown, keys: readonly string[]): value is Row {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const names = Reflect.ownKeys(value);
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    names.length === keys.length &&
    names.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === 'string' &&
        keys.includes(key) &&
        descriptor?.enumerable === true &&
        'value' in descriptor
      );
    })
  );
}
function list(value: unknown, keys: string[], max: number): value is Row[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, i) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, i);
      return (
        descriptor?.enumerable === true &&
        'value' in descriptor &&
        shape(descriptor.value, keys)
      );
    }).every(Boolean)
  );
}
const fields = [
  'accountKeysSha256',
  'version',
  'wrappedFromNativeRaw',
  'maximumRentLamports',
  'maximumNativeDebitLamports',
  'preexistingWrappedRefundRaw',
  'closesWrappedAccount',
  'accounts',
  'lookupTables',
];
const accountFields = [
  'address',
  'mint',
  'index',
  'created',
  'closed',
  'rentBeforeRaw',
];
const lookupFields = ['address', 'sha256', 'lastExtendedSlot'];
const proofFields = [
  'format',
  'slot',
  'recheckSlot',
  'mints',
  'accountSize',
  'rentLamports',
];
const mintFields = ['address', 'program', 'decimals', 'policySha256'];
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 256;
const uint = (value: unknown) =>
  text(value) &&
  /^(0|[1-9]\d{0,19})$/.test(value) &&
  BigInt(value) <= (1n << 64n) - 1n;
const digest = (value: unknown) => text(value) && /^[a-f0-9]{64}$/.test(value);
function proof(value: unknown): value is SwapToken2022Evidence {
  if (
    !shape(value, proofFields) ||
    !list(value.mints, mintFields, 2) ||
    value.mints.length !== 2 ||
    !value.mints.every(
      (mint) =>
        text(mint.address) &&
        text(mint.program) &&
        digest(mint.policySha256) &&
        Number.isInteger(mint.decimals),
    ) ||
    !Number.isSafeInteger(value.slot) ||
    !Number.isSafeInteger(value.recheckSlot) ||
    (value.slot as number) < 0 ||
    (value.recheckSlot as number) < (value.slot as number) ||
    (value.recheckSlot as number) - (value.slot as number) > 32
  )
    return false;
  try {
    const evidence = value as unknown as SwapToken2022Evidence;
    swapToken2022Programs(evidence, {
      inputMint: evidence.mints[0].address,
      outputMint: evidence.mints[1].address,
    });
    return true;
  } catch {
    return false;
  }
}
function settlement(value: unknown): value is Row {
  if (!value || typeof value !== 'object') return false;
  const version = Object.getOwnPropertyDescriptor(value, 'version')?.value;
  return (
    (version === 1 || version === 2) &&
    shape(value, version === 2 ? [...fields, 'token2022Evidence'] : fields) &&
    digest(value.accountKeysSha256) &&
    [
      'wrappedFromNativeRaw',
      'maximumRentLamports',
      'maximumNativeDebitLamports',
      'preexistingWrappedRefundRaw',
    ].every((key) => uint(value[key])) &&
    typeof value.closesWrappedAccount === 'boolean' &&
    list(value.accounts, accountFields, 256) &&
    value.accounts.every(
      (account) =>
        text(account.address) &&
        text(account.mint) &&
        Number.isSafeInteger(account.index) &&
        (account.index as number) >= 0 &&
        typeof account.created === 'boolean' &&
        typeof account.closed === 'boolean' &&
        uint(account.rentBeforeRaw),
    ) &&
    list(value.lookupTables, lookupFields, 32) &&
    value.lookupTables.every(
      (table) =>
        text(table.address) &&
        digest(table.sha256) &&
        uint(table.lastExtendedSlot),
    ) &&
    (version === 1 || proof(value.token2022Evidence))
  );
}
function equal(a: unknown, b: unknown): boolean {
  if (a === null || typeof a !== 'object') return Object.is(a, b);
  if (!b || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b))
    return false;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every(
      (key) => Object.hasOwn(b, key) && equal((a as Row)[key], (b as Row)[key]),
    )
  );
}

/** Compare policy only AFTER a fresh requireWarmupSigningReview succeeds.
 * Does not establish freshness, mint validity, ownership, signing or execution authority. */
export function matchingJitoSettlementPolicy(
  approved: unknown,
  fresh: unknown,
): boolean {
  if (
    !settlement(approved) ||
    !settlement(fresh) ||
    approved.version !== fresh.version
  )
    return false;
  if (equal(approved, fresh)) return true;
  if (approved.version === 1) return false;
  const oldProof = approved.token2022Evidence as SwapToken2022Evidence;
  const newProof = fresh.token2022Evidence as SwapToken2022Evidence;
  if (newProof.slot < oldProof.recheckSlot) return false;
  return (
    fields.every((key) => equal(approved[key], fresh[key])) &&
    proofFields
      .filter((key) => key !== 'slot' && key !== 'recheckSlot')
      .every((key) =>
        equal(
          (oldProof as unknown as Row)[key],
          (newProof as unknown as Row)[key],
        ),
      )
  );
}
