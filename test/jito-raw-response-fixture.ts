/** Synthetic Rust-shaped response data only. No provider or execution qualification. */
import bs58 from 'bs58';
import { jitoSequentialEconomicsFixture } from './jito-sequential-economics-fixture';
import {
  SWAP_TOKEN,
  SWAP_TOKEN_2022,
  SWAP_WRAPPED_SOL,
} from '../lib/swap-token-program-evidence';

class SyntheticRawNumber {
  constructor(readonly source: string) {}
}
/** Test-only lexical JSON number. Never use this marker for production evidence. */
export function rawNumberToken(source: string) {
  if (
    typeof source !== 'string' ||
    source.length > 128 ||
    !/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(source)
  )
    throw Error('Invalid synthetic JSON numeric token.');
  return new SyntheticRawNumber(source);
}
function encode(value: unknown): string {
  if (value instanceof SyntheticRawNumber) return value.source;
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return (
      '[' + value.map((v) => encode(v === undefined ? null : v)).join(',') + ']'
    );
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => JSON.stringify(k) + ':' + encode(v))
        .join(',') +
      '}'
    );
  throw Error('Unsupported synthetic JSON value.');
}
const display = (amount: bigint, decimals: number) => {
  const padded = amount.toString().padStart(decimals + 1, '0');
  if (!decimals) return padded;
  return (padded.slice(0, -decimals) + '.' + padded.slice(-decimals)).replace(
    /\.?0+$/,
    '',
  );
};
type Fixture = Awaited<ReturnType<typeof jitoSequentialEconomicsFixture>>;
type RawAccount =
  Fixture['result']['value']['transactionResults'][number]['preExecutionAccounts'][number];
function account(value: RawAccount) {
  if (value === null) return null;
  return {
    owner: value.owner,
    executable: value.executable,
    lamports: BigInt(value.lamports),
    data: [...value.data],
    rentEpoch: (1n << 64n) - 1n,
    space: BigInt(Buffer.from(value.data[0], 'base64').byteLength),
  };
}
function tokens(accounts: RawAccount[]) {
  return accounts.flatMap((value, index) => {
    if (!value || ![SWAP_TOKEN, SWAP_TOKEN_2022].includes(value.owner))
      return [];
    const bytes = Buffer.from(value.data[0], 'base64');
    if (bytes.length < 165 || (bytes.length !== 165 && bytes[165] !== 2))
      return [];
    const mint = bs58.encode(bytes.subarray(0, 32)),
      amount = bytes.readBigUInt64LE(64);
    const decimals = mint === SWAP_WRAPPED_SOL ? 9 : 6;
    return [
      {
        accountIndex: BigInt(index),
        mint,
        owner: bs58.encode(bytes.subarray(32, 64)),
        programId: value.owner,
        uiTokenAmount: {
          amount: amount.toString(),
          decimals: BigInt(decimals),
          uiAmount: rawNumberToken(
            amount === 0n ? '0.0' : `${amount}e-${decimals}`,
          ),
          uiAmountString: amount === 0n ? '0' : display(amount, decimals),
        },
      },
    ];
  });
}
export async function jitoRawResponseFixture(
  options: Pick<
    NonNullable<Parameters<typeof jitoSequentialEconomicsFixture>[0]>,
    'side' | 'lookup' | 'token2022' | 'wallets'
  > = {},
) {
  const fixture = await jitoSequentialEconomicsFixture(options);
  const envelope = {
    jsonrpc: '2.0',
    id: 'jito-test',
    result: {
      context: { slot: 101n, apiVersion: '2.2.0' },
      value: {
        summary: 'succeeded',
        transactionResults: fixture.result.value.transactionResults.map(
          (frame, index) => ({
            err: null,
            preExecutionAccounts: frame.preExecutionAccounts.map(account),
            postExecutionAccounts: frame.postExecutionAccounts.map(account),
            fee: BigInt(frame.fee),
            unitsConsumed: BigInt(frame.unitsConsumed),
            loadedAccountsDataSize: BigInt(frame.loadedAccountsDataSize),
            loadedAddresses: structuredClone(frame.loadedAddresses),
            replacementBlockhash: null,
            preBalances: frame.preExecutionAccounts.map((a) =>
              BigInt(a?.lamports ?? '0'),
            ),
            postBalances: frame.postExecutionAccounts.map((a) =>
              BigInt(a?.lamports ?? '0'),
            ),
            preTokenBalances: tokens(frame.preExecutionAccounts),
            postTokenBalances: tokens(frame.postExecutionAccounts),
            logs: index % 2 ? null : ['Synthetic local simulation log'],
            returnData:
              index % 2
                ? null
                : {
                    programId: fixture.keys[index][0],
                    data: ['AQID', 'base64'],
                  },
          }),
        ),
      },
    },
  };
  const policy = {
    profile: 'jito-rust-raw-frames-v1' as const,
    packets: fixture.packets,
    minimumSlot: 100,
    simulationBankSlot: 101,
    bankEncoding: 'slot-object' as const,
    verifySignatures: false,
    rpcId: 'jito-test',
  };
  const wire = (value: unknown = envelope) => encode(value);
  const body = (value: unknown = envelope) => new Response(wire(value)).body!;
  return { fixture, envelope, policy, wire, body };
}
