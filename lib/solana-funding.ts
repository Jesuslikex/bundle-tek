import { validateFunding } from './funding-plan';
import { balanceRpc, SOLANA_MAINNET_GENESIS } from './wallet-balances';
import {
  getSolanaRpcEndpoint,
  requireConsistentSolanaSlots,
} from './solana-rpc';
import { warmupAtoms, warmupDecimal } from './wallet-warmup';
import { SolanaFundingError } from './solana-funding-error';
export { SolanaFundingError } from './solana-funding-error';
const SYSTEM = '11111111111111111111111111111111';
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
import { solanaTransferMessage } from './solana-transfer-message';
export { solanaTransferMessage } from './solana-transfer-message';
const integer = (v: unknown) => {
  if (
    typeof v !== 'string' ||
    !/^\d{1,20}$/.test(v) ||
    BigInt(v) > (1n << 64n) - 1n
  )
    throw new SolanaFundingError('Invalid Solana provider integer.');
  return BigInt(v);
};
const slot = (v: unknown) => {
  const n = Number(integer(v));
  if (!Number.isSafeInteger(n))
    throw new SolanaFundingError('Invalid Solana context slot.');
  return n;
};
type Account = {
  lamports: string;
  owner: string;
  executable: boolean;
  data: [string, string];
} | null;
export async function prepareSolanaFunding(
  value: unknown,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
) {
  const document = validateFunding(value),
    started = Date.now();
  if (
    document.chain !== 'Solana' ||
    document.currency !== 'SOL' ||
    document.assetAddress ||
    document.source !== 'Wallet' ||
    !document.funderAddress
  )
    throw new SolanaFundingError(
      'Choose native SOL, a wallet source and a funder address. Token funding is not supported here.',
    );
  if (document.delaySeconds || Date.parse(document.startAt) > started)
    throw new SolanaFundingError(
      'Prepare an immediate draft with zero recipient delay.',
    );
  const from = document.funderAddress,
    recipients = document.recipients,
    source = getSolanaRpcEndpoint('mainnet');
  if (recipients.some((r) => r.address === from))
    throw new SolanaFundingError('Funder cannot be a recipient.');
  const rpc = (method: string, params: unknown[]) =>
    balanceRpc(source, method, params, signal, fetcher);
  if ((await rpc('getGenesisHash', [])) !== SOLANA_MAINNET_GENESIS)
    throw new SolanaFundingError('Solana provider network mismatch.');
  const latest = (await rpc('getLatestBlockhash', [
    { commitment: 'finalized' },
  ])) as {
    context: { slot: string };
    value: { blockhash: string; lastValidBlockHeight: string };
  };
  const context = slot(latest.context.slot),
    blockhash = latest.value.blockhash,
    lastValidBlockHeight = integer(latest.value.lastValidBlockHeight);
  const funderResponse = (await rpc('getAccountInfo', [
    from,
    { encoding: 'base64', commitment: 'finalized', minContextSlot: context },
  ])) as { context: { slot: string }; value: Account };
  const accountResponse = (await rpc('getMultipleAccounts', [
    recipients.map((r) => r.address),
    { encoding: 'base64', commitment: 'finalized', minContextSlot: context },
  ])) as { context: { slot: string }; value: Account[] };
  if (!Array.isArray(accountResponse.value))
    throw new SolanaFundingError('Incomplete account snapshot.');
  accountResponse.value.unshift(funderResponse.value);
  const slots = [
    context,
    slot(funderResponse.context.slot),
    slot(accountResponse.context.slot),
  ];
  const checkSlots = () => {
    if (slots.some((s) => s < context))
      throw new SolanaFundingError('Provider returned a stale context slot.');
    requireConsistentSolanaSlots(slots);
  };
  checkSlots();
  if (
    !Array.isArray(accountResponse.value) ||
    accountResponse.value.length !== recipients.length + 1
  )
    throw new SolanaFundingError('Incomplete funding account snapshot.');
  for (const a of accountResponse.value)
    if (a === undefined)
      throw new SolanaFundingError('Incomplete account snapshot.');
    else if (
      a &&
      (a.owner !== SYSTEM ||
        a.executable !== false ||
        !Array.isArray(a.data) ||
        a.data[0] !== '' ||
        a.data[1] !== 'base64')
    )
      throw new SolanaFundingError(
        'Use ordinary system wallets without account data.',
      );
  const reserve = integer(
    await rpc('getMinimumBalanceForRentExemption', [
      0,
      { commitment: 'finalized' },
    ]),
  );
  const balance = accountResponse.value[0]
    ? integer(accountResponse.value[0].lamports)
    : 0n;
  const transactions: Array<{
    recipient: string;
    amount: string;
    lamports: string;
    messageBase64: string;
    unsignedTransactionBase64: string;
    feeLamports: string;
  }> = [];
  let total = 0n,
    fees = 0n;
  for (const [i, r] of recipients.entries()) {
    const raw = warmupAtoms(r.amount, 9),
      message = solanaTransferMessage(from, r.address, blockhash, raw),
      messageBase64 = base64(message);
    const recipientBalance = accountResponse.value[i + 1]
      ? integer(accountResponse.value[i + 1]!.lamports)
      : 0n;
    if (recipientBalance + raw < reserve)
      throw new SolanaFundingError(
        'A recipient would remain below the rent-exempt minimum.',
      );
    const fee = (await rpc('getFeeForMessage', [
      messageBase64,
      { commitment: 'finalized', minContextSlot: context },
    ])) as { context: { slot: string }; value: string | null };
    slots.push(slot(fee.context.slot));
    checkSlots();
    if (fee.value === null)
      throw new SolanaFundingError(
        'Blockhash fee is unavailable. Prepare again.',
      );
    const cost = integer(fee.value);
    fees += cost;
    total += raw;
    transactions.push({
      recipient: r.address,
      amount: r.amount,
      lamports: raw.toString(),
      messageBase64,
      unsignedTransactionBase64: base64(
        Uint8Array.from([1, ...new Uint8Array(64), ...message]),
      ),
      feeLamports: cost.toString(),
    });
  }
  if (balance < total + fees + reserve)
    throw new SolanaFundingError(
      'Funder balance does not cover transfers, quoted fees and rent reserve.',
    );
  // Each simulation uses the same starting snapshot; aggregate conservation above covers the batch spend.
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.min(3, transactions.length) }, async () => {
      while (index < transactions.length) {
        const item = transactions[index++];
        const sim = (await rpc('simulateTransaction', [
          item.unsignedTransactionBase64,
          {
            encoding: 'base64',
            commitment: 'finalized',
            sigVerify: false,
            replaceRecentBlockhash: false,
            minContextSlot: context,
          },
        ])) as { context: { slot: string }; value: { err: unknown } };
        slots.push(slot(sim.context.slot));
        checkSlots();
        if (sim.value?.err !== null)
          throw new SolanaFundingError('A native transfer simulation failed.');
      }
    }),
  );
  const valid = (await rpc('isBlockhashValid', [
    blockhash,
    { commitment: 'finalized', minContextSlot: context },
  ])) as { context: { slot: string }; value: boolean };
  slots.push(slot(valid.context.slot));
  checkSlots();
  const height = integer(
    await rpc('getBlockHeight', [{ commitment: 'finalized' }]),
  );
  if (
    valid.value !== true ||
    height >= lastValidBlockHeight ||
    signal.aborted ||
    Date.now() >= started + 60000
  )
    throw new SolanaFundingError(
      'Funding blockhash or preparation has expired.',
    );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(document)),
  );
  return {
    format: 'pulseforge-solana-unsigned-funding-v1',
    executionAllowed: false as const,
    signed: false as const,
    chain: 'Solana',
    currency: 'SOL',
    assetAddress: null,
    accountRent: '0',
    funder: from,
    blockhash,
    lastValidBlockHeight: lastValidBlockHeight.toString(),
    slot: Math.max(...slots),
    source: new URL(source).hostname,
    preparedAt: new Date(started).toISOString(),
    expiresAt: new Date(started + 60000).toISOString(),
    draftHash: Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    total: warmupDecimal(total, 9),
    fees: warmupDecimal(fees, 9),
    rentReserve: warmupDecimal(reserve, 9),
    required: warmupDecimal(total + fees + reserve, 9),
    transactions,
    limitations:
      'Unsigned legacy messages with zero placeholder signatures. Transfers are independent, not atomic. No priority fee or nonce reservation. Simulation is per transfer and does not reserve balances. Blockhash may expire before the displayed refresh time. Recheck balances and lifetime before signing.',
  };
}
export type SolanaFundingBatch = Awaited<
  ReturnType<typeof prepareSolanaFunding>
>;
