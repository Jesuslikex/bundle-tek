import bs58 from 'bs58';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { toBaseUnits } from './distribution-plan';
type Account = {
  owner: string;
  executable: boolean;
  data: readonly [string, string];
  lamports: bigint;
};
function bytes(account: Account | null, length: number) {
  if (
    !account ||
    account.owner !== TOKEN_PROGRAM_ADDRESS ||
    account.executable ||
    account.data[1] !== 'base64'
  )
    throw new Error(
      'Only initialized standard SPL accounts are supported on devnet.',
    );
  const data = Uint8Array.from(atob(account.data[0]), (char) =>
    char.charCodeAt(0),
  );
  if (data.length !== length)
    throw new Error('Token extensions and malformed accounts are unsupported.');
  return data;
}
function token(account: Account | null, mint: string, owner: string) {
  const data = bytes(account, 165);
  if (
    bs58.encode(data.slice(0, 32)) !== mint ||
    bs58.encode(data.slice(32, 64)) !== owner ||
    data[108] !== 1
  )
    throw new Error(
      'Token account must match the saved mint and owner, initialized and unfrozen.',
    );
  const view = new DataView(data.buffer);
  if (
    [72, 109, 129].some((offset) => view.getUint32(offset, true) > 1) ||
    (mint === 'So11111111111111111111111111111111111111112') !==
      (view.getUint32(109, true) === 1)
  )
    throw new Error(
      'Token account native-mint state or optional data is inconsistent.',
    );
  return view.getBigUint64(64, true);
}
export function reviewDevnetTokenFunding(input: {
  wallet: string;
  mint: string;
  decimals: number;
  remaining: { address: string; amount: string }[];
  accounts: readonly (Account | null)[];
  balance: bigint;
  rent: bigint;
  slots: readonly bigint[];
}) {
  const { remaining, accounts, balance, rent, slots } = input;
  if (
    !remaining.length ||
    remaining.length > 100 ||
    accounts.length !== 4 ||
    !slots.length ||
    slots.some((slot) => slot < 0n) ||
    slots.reduce((a, b) => (a > b ? a : b)) -
      slots.reduce((a, b) => (a < b ? a : b)) >
      150n ||
    balance < 0n ||
    rent <= 0n ||
    balance >= 1n << 64n ||
    rent >= 1n << 64n
  )
    throw new Error(
      'Devnet token funding snapshot is inconsistent. Prepare again.',
    );
  const [mint, source, destination, funder] = accounts;
  const data = bytes(mint, 82);
  if (data[45] !== 1 || data[44] !== input.decimals)
    throw new Error(
      'Devnet mint initialization or decimals differ from the saved asset.',
    );
  const tokenBalance = token(source, input.mint, input.wallet);
  if (destination) token(destination, input.mint, remaining[0].address);
  if (
    !funder ||
    funder.owner !== '11111111111111111111111111111111' ||
    funder.executable ||
    funder.data[0] !== '' ||
    funder.lamports !== balance
  )
    throw new Error('Funder native SOL account is inconsistent.');
  const amounts = remaining.map((row) =>
    toBaseUnits(row.amount, input.decimals),
  );
  const requiredTokens = amounts.reduce((a, b) => a + b, 0n);
  if (amounts.some((amount) => amount <= 0n) || tokenBalance < requiredTokens)
    throw new Error(
      'Devnet funder cannot cover all remaining saved token amounts.',
    );
  // Conservatively reserve an ATA for each remaining recipient plus one rent reserve.
  const requiredSol = BigInt(remaining.length) * (rent + 6400n) + rent;
  if (balance < requiredSol)
    throw new Error(
      'Insufficient devnet SOL for account creation, fee allowance and rent reserve.',
    );
  return { tokenBalance, requiredTokens, requiredSol };
}
