import bs58 from 'bs58';
import { solanaTransferMessage } from './solana-transfer-message';
import type { JitoBundleSimulationFrame } from './jito-bundle-simulation-frames';
import { PAIR_CLOCK, pairClockUnixTimestamp } from './pair-stock-clock';
import { PAIR_RENT, inspectPairRentAccount } from './pair-rent-evidence';
const SYSTEM = '11111111111111111111111111111111';
const fail = (): never => {
  throw Error('CPMM bank anchor refused.');
};
/** Unsigned zero-value native transfer, with two additional readonly static
 * sysvars. Never sent: its complete simulation frame supplies actual bank
 * evidence without inventing or copying a different RPC snapshot. */
export function buildJitoCpmmBankAnchor(
  payer: string,
  tip: string,
  blockhash: string,
) {
  if (new Set([payer, tip, SYSTEM, PAIR_CLOCK, PAIR_RENT]).size !== 5) fail();
  const original = Buffer.from(
    solanaTransferMessage(payer, tip, blockhash, 1n),
  );
  if (!original.subarray(0, 4).equals(Buffer.from([1, 0, 1, 3]))) fail();
  const message = Buffer.concat([
    Buffer.from([1, 0, 3, 5]),
    original.subarray(4, 100),
    bs58.decode(PAIR_CLOCK),
    bs58.decode(PAIR_RENT),
    original.subarray(100),
  ]);
  // Keep the ordinary positive-only funding builder unchanged. This separate
  // simulation-only anchor encodes exactly zero, with no signing/send path.
  if (message.readUInt32LE(message.length - 12) !== 2) fail();
  message.writeBigUInt64LE(0n, message.length - 8);
  return Buffer.concat([Buffer.from([1]), Buffer.alloc(64), message]).toString(
    'base64',
  );
}
/** Requires an already fully checked original frame. Also binds exact packet
 * bytes, zero signatures, instruction, fees and every actual account image. */
export function inspectJitoCpmmBankAnchor(
  frame: JitoBundleSimulationFrame,
  expected: { payer: string; tip: string; blockhash: string },
  slot: number,
) {
  if (
    frame.transaction !==
      buildJitoCpmmBankAnchor(
        expected.payer,
        expected.tip,
        expected.blockhash,
      ) ||
    JSON.stringify(frame.keys) !==
      JSON.stringify([
        expected.payer,
        expected.tip,
        SYSTEM,
        PAIR_CLOCK,
        PAIR_RENT,
      ]) ||
    JSON.stringify(frame.requestedWritable) !==
      '[true,true,false,false,false]' ||
    frame.preAccounts.length !== 5 ||
    frame.postAccounts.length !== 5
  )
    fail();
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a) === JSON.stringify(b);
  for (let i = 1; i < 5; i++)
    if (!same(frame.preAccounts[i], frame.postAccounts[i])) fail();
  const before = frame.preAccounts[0],
    after = frame.postAccounts[0];
  if (
    !before ||
    !after ||
    before.owner !== SYSTEM ||
    before.executable ||
    before.data.length !== 0 ||
    !same({ ...before, lamports: '' }, { ...after, lamports: '' }) ||
    BigInt(before.lamports) - BigInt(after.lamports) !==
      BigInt(frame.feeLamports) ||
    BigInt(frame.feeLamports) > BigInt(frame.maximumFeeLamports)
  )
    fail();
  const rows = [PAIR_CLOCK, PAIR_RENT].map((address, i) => {
    const a = frame.preAccounts[i + 3];
    if (!a) return fail();
    return {
      address,
      owner: a.owner,
      executable: a.executable,
      lamports: a.lamports,
      dataBase64: Buffer.from(a.data).toString('base64'),
    };
  });
  pairClockUnixTimestamp(
    { ...rows[0], data: [rows[0].dataBase64, 'base64'] },
    slot,
  );
  inspectPairRentAccount({ ...rows[1], data: [rows[1].dataBase64, 'base64'] });
  return { slot, before: rows, after: structuredClone(rows) };
}
