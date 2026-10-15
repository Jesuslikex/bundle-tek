import bs58 from 'bs58';
import type { JupiterRouteAssessment } from './jupiter-route-assessment';
import type { SolanaSwapPreparation } from './warmup-swap-quote';
import { swapTokenBytes } from './swap-token-program-evidence';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
type AccountBinding = {
  tokenProgram?: string;
  byteLength?: number;
  expectedProgram?: string;
  exists?: boolean;
  lamports?: string;
  amountRaw?: string;
  nativeReserveRaw?: string | null;
  role: 'Source' | 'Destination';
  address: string;
  expectedMint: string;
  status: 'Matched bindings' | 'Mismatch' | 'Unavailable';
  reason: string;
  mint: string | null;
  walletOwner: string | null;
  state: string | null;
  delegate: string | null;
  delegatedAmountRaw: string | null;
  closeAuthority: string | null;
};
export async function readSwapTokenAccountBindings(
  route: JupiterRouteAssessment,
  order: Pick<SolanaSwapPreparation, 'inputMint' | 'outputMint'> & {
    preparation: Pick<SolanaSwapPreparation['preparation'], 'wallet'>;
  },
  minContextSlot: number,
  rpc: Rpc,
) {
  const limitations =
    'Confirmed chain account bindings only, not simulated post-state. Newly created or temporary wrapped SOL accounts can be absent. Token-2022 accounts accept only canonical immutable-owner extensions; mint extensions need separate fresh evidence. Mint authenticity, other instructions, route graph and total debits remain unverified. No signing clearance.';
  if (!route.decoded)
    return {
      slot: null,
      status: 'Unavailable' as const,
      accounts: [] as AccountBinding[],
      limitations,
    };
  if (!Number.isSafeInteger(minContextSlot) || minContextSlot < 0)
    throw new Error('Invalid token account observation slot.');
  const selections = [
    {
      role: 'Source' as const,
      address: route.decoded.sourceAccount,
      expectedMint: order.inputMint,
      expectedProgram: route.decoded.inputTokenProgram ?? TOKEN,
    },
    {
      role: 'Destination' as const,
      address: route.decoded.destinationAccount,
      expectedMint: order.outputMint,
      expectedProgram: route.decoded.outputTokenProgram ?? TOKEN,
    },
  ];
  const addresses = [...new Set(selections.map((a) => a.address))];
  const result = (await rpc('getMultipleAccounts', [
    addresses,
    {
      encoding: 'base64',
      commitment: 'confirmed',
      minContextSlot,
    },
  ])) as { context?: { slot?: unknown }; value?: unknown[] };
  const rawSlot = result?.context?.slot;
  if (typeof rawSlot !== 'string' || !/^(0|[1-9]\d{0,15})$/.test(rawSlot))
    throw new Error('Invalid token account observation slot.');
  const observedSlot = Number(rawSlot);
  if (
    !Number.isSafeInteger(observedSlot) ||
    observedSlot < minContextSlot ||
    observedSlot - minContextSlot > 32 ||
    !Array.isArray(result.value) ||
    result.value.length !== addresses.length
  )
    throw new Error('Inconsistent token account observations.');
  const accounts = selections.map((selection): AccountBinding => {
    const base: AccountBinding = {
      ...selection,
      status: 'Unavailable',
      reason: '',
      mint: null,
      walletOwner: null,
      state: null,
      delegate: null,
      delegatedAmountRaw: null,
      closeAuthority: null,
    };
    const raw = result.value![addresses.indexOf(selection.address)];
    if (raw === null)
      return {
        ...base,
        exists: false,
        reason: 'Account absent at the observed chain slot.',
      };
    if (!raw || typeof raw !== 'object')
      throw new Error('Invalid token account response.');
    const account = raw as {
      owner?: unknown;
      executable?: unknown;
      data?: unknown;
      lamports?: unknown;
    };
    if (typeof account.owner !== 'string' || account.executable !== false)
      throw new Error('Invalid token account metadata.');
    if (account.owner !== TOKEN && account.owner !== TOKEN2022)
      return {
        ...base,
        status: 'Mismatch',
        reason: 'Account is not owned by a supported token program.',
      };
    const { bytes, program } = swapTokenBytes(account, false);
    const view = new DataView(bytes.buffer);
    const key = (offset: number) =>
      bs58.encode(bytes.slice(offset, offset + 32));
    const option = (offset: number) => {
      const tag = view.getUint32(offset, true);
      if (tag > 1) throw new Error('Invalid token account option.');
      return tag === 1;
    };
    const delegate = option(72) ? key(76) : null;
    const nativeReserveRaw = option(109)
      ? view.getBigUint64(113, true).toString()
      : null;
    const closeAuthority = option(129) ? key(133) : null;
    if (bytes[108] > 2) throw new Error('Invalid token account state.');
    const mint = key(0),
      walletOwner = key(32);
    const matches =
      program === selection.expectedProgram &&
      mint === selection.expectedMint &&
      walletOwner === order.preparation.wallet &&
      bytes[108] === 1;
    return {
      ...base,
      exists: true,
      tokenProgram: program,
      byteLength: bytes.length,
      ...(typeof account.lamports === 'string' &&
      /^(0|[1-9]\d{0,19})$/.test(account.lamports)
        ? { lamports: account.lamports }
        : {}),
      amountRaw: view.getBigUint64(64, true).toString(),
      nativeReserveRaw,
      mint,
      walletOwner,
      delegate,
      closeAuthority,
      delegatedAmountRaw: view.getBigUint64(121, true).toString(),
      state: ['Uninitialized', 'Initialized', 'Frozen'][bytes[108]],
      status: matches ? 'Matched bindings' : 'Mismatch',
      reason: matches
        ? 'Mint, wallet owner and initialized state match.'
        : 'Token program, mint, wallet owner or initialized state differs from the selected order.',
    };
  });
  return {
    slot: observedSlot,
    accounts,
    limitations,
    status: accounts.some((a) => a.status === 'Mismatch')
      ? ('Mismatch' as const)
      : accounts.some((a) => a.status === 'Unavailable')
        ? ('Unavailable' as const)
        : ('Matched bindings' as const),
  };
}
export type SwapTokenAccountBindings = Awaited<
  ReturnType<typeof readSwapTokenAccountBindings>
>;
