import { toBaseUnits } from './distribution-plan';
type NativeAccount = {
  owner: string;
  executable: boolean;
  data: readonly [string, string];
  lamports: bigint;
};
export function reviewDevnetNativeFunding(
  remaining: { address: string; amount: string }[],
  balance: bigint,
  rent: bigint,
  funder: NativeAccount | null,
  recipient: NativeAccount | null,
  slots: readonly bigint[],
) {
  const system = '11111111111111111111111111111111',
    valid = (v: bigint) => typeof v === 'bigint' && v >= 0n && v < 1n << 64n;
  if (
    !remaining.length ||
    remaining.length > 100 ||
    !valid(balance) ||
    !valid(rent) ||
    !slots.length ||
    slots.some((slot) => !valid(slot)) ||
    slots.reduce((max, slot) => (slot > max ? slot : max)) -
      slots.reduce((min, slot) => (slot < min ? slot : min)) >
      150n
  )
    throw new Error(
      'Devnet funding snapshot is invalid or inconsistent. Prepare again.',
    );
  const ordinary = (account: NativeAccount) =>
    account.owner === system &&
    !account.executable &&
    account.data[0] === '' &&
    valid(account.lamports);
  if (!funder || !ordinary(funder) || funder.lamports !== balance)
    throw new Error(
      'Funder must be an initialized native SOL wallet with a consistent balance.',
    );
  if (recipient && !ordinary(recipient))
    throw new Error('Choose a standard native SOL recipient wallet.');
  const amounts = remaining.map((row) => toBaseUnits(row.amount, 9));
  if (amounts.some((amount) => amount <= 0n))
    throw new Error('Funding amounts must be positive.');
  if ((recipient?.lamports || 0n) + amounts[0] < rent)
    throw new Error(
      'Recipient would remain below the rent-exempt minimum. Increase its saved amount.',
    );
  const required = amounts.reduce((sum, amount) => sum + amount + 6400n, rent);
  if (balance < required)
    throw new Error(
      'Devnet funder balance cannot cover remaining recipients, fee allowance and rent reserve.',
    );
  return required;
}
