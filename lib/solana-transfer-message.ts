import bs58 from 'bs58';
import { SolanaFundingError } from './solana-funding-error';
const SYSTEM = '11111111111111111111111111111111';
export function solanaTransferMessage(
  from: string,
  to: string,
  blockhash: string,
  lamports: bigint,
) {
  if (
    from === to ||
    from === SYSTEM ||
    to === SYSTEM ||
    lamports <= 0n ||
    lamports > (1n << 64n) - 1n
  )
    throw new SolanaFundingError('Invalid native SOL transfer.');
  const keys = [from, to, SYSTEM, blockhash].map((k) => {
    const bytes = bs58.decode(k);
    if (bytes.length !== 32)
      throw new SolanaFundingError('Invalid public key or blockhash.');
    return bytes;
  });
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return Uint8Array.from([
    1,
    0,
    1,
    3,
    ...keys[0],
    ...keys[1],
    ...keys[2],
    ...keys[3],
    1,
    2,
    2,
    0,
    1,
    12,
    ...data,
  ]);
}
