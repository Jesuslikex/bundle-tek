import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { address, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { getExtensionEncoder } from '@solana-program/token-2022';
import { TOKEN_2022 } from '../lib/token-withdrawal-fee';
import { nativeWithdrawalFixture } from './native-withdrawal-fixture';
import {
  tokenWithdrawalInput,
  signNativeWithdrawal,
} from '../lib/native-withdrawal';
import { prepareTokenWithdrawal } from '../lib/token-withdrawal-server';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import { formatNativeBalance } from '../lib/wallet-balance-format';
export async function tokenWithdrawalFixture(
  existing = false,
  token2022 = false,
  withFee = false,
  selection: { mint?: string; amountRaw?: bigint } = {},
) {
  const program = token2022 ? TOKEN_2022 : TOKEN_PROGRAM_ADDRESS;
  const accountRent =
    890880n + 6960n * BigInt(token2022 ? (withFee ? 182 : 170) : 165);
  const native = await nativeWithdrawalFixture(),
    wallet = native.wallet,
    recipient = bs58.encode(
      nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).publicKey,
    ),
    mint = selection.mint ?? bs58.encode(new Uint8Array(32).fill(9)),
    blockhash = bs58.encode(new Uint8Array(32).fill(3)),
    amount = selection.amountRaw ?? 9007199254740993n,
    balance = 20000000000000000n;
  const encode = (v: Uint8Array) => btoa(String.fromCharCode(...v));
  const feeExtension = {
    __kind: 'TransferFeeConfig' as const,
    transferFeeConfigAuthority: address('11111111111111111111111111111111'),
    withdrawWithheldAuthority: address('11111111111111111111111111111111'),
    withheldAmount: 0n,
    olderTransferFee: {
      epoch: 0n,
      maximumFee: 100n,
      transferFeeBasisPoints: 100,
    },
    newerTransferFee: {
      epoch: 10n,
      maximumFee: 500n,
      transferFeeBasisPoints: 250,
    },
  };
  const mintExtensionBytes = withFee
    ? Uint8Array.from(getExtensionEncoder().encode(feeExtension))
    : new Uint8Array();
  const mintData = new Uint8Array(
    withFee ? 166 + mintExtensionBytes.length : 82,
  );
  mintData[44] = 6;
  mintData[45] = 1;
  if (withFee) {
    mintData[165] = 1;
    mintData.set(mintExtensionBytes, 166);
  }
  function account(owner: string, raw: bigint) {
    const extensionBytes = token2022
      ? Uint8Array.from([
          ...getExtensionEncoder().encode({ __kind: 'ImmutableOwner' }),
          ...(withFee
            ? getExtensionEncoder().encode({
                __kind: 'TransferFeeAmount',
                withheldAmount: 0n,
              })
            : []),
        ])
      : new Uint8Array();
    const bytes = new Uint8Array(token2022 ? 166 + extensionBytes.length : 165);
    bytes.set(bs58.decode(mint));
    bytes.set(bs58.decode(owner), 32);
    new DataView(bytes.buffer).setBigUint64(64, raw, true);
    bytes[108] = 1;
    if (token2022) {
      bytes[165] = 2;
      bytes.set(extensionBytes, 166);
    }
    return {
      owner: program,
      executable: false,
      lamports: accountRent.toString(),
      data: [encode(bytes), 'base64'],
    };
  }
  const data: Record<string, unknown> = {
    getGenesisHash: SOLANA_MAINNET_GENESIS,
    getLatestBlockhash: {
      context: { slot: '100' },
      value: { blockhash, lastValidBlockHeight: '200' },
    },
    getMultipleAccounts: {
      context: { slot: '100' },
      value: [
        {
          owner: '11111111111111111111111111111111',
          executable: false,
          lamports: '2000000000',
          data: ['', 'base64'],
        },
        {
          owner: program,
          executable: false,
          lamports: '1461600',
          data: [encode(mintData), 'base64'],
        },
        account(wallet, balance),
        existing ? account(recipient, 100n) : null,
      ],
    },
    getFeeForMessage: { context: { slot: '100' }, value: '5000' },
    simulateTransaction: { context: { slot: '100' }, value: { err: null } },
    isBlockhashValid: { context: { slot: '100' }, value: true },
    getBlockHeight: '150',
  };
  data.getEpochInfo = { epoch: '5', absoluteSlot: '100' };
  const fetcher = (async (_url: unknown, init: RequestInit) => {
    if (typeof init.body !== 'string')
      throw new Error('Fixture JSON request body required.');
    const body = JSON.parse(init.body);
    return Response.json({
      jsonrpc: '2.0',
      id: 1,
      result:
        body.method === 'getMinimumBalanceForRentExemption'
          ? (890880n + 6960n * BigInt(body.params[0])).toString()
          : body.method === 'getAccountInfo'
            ? {
                context: { slot: '100' },
                value: (data.getMultipleAccounts as { value: unknown[] })
                  .value[1],
              }
            : data[body.method],
    });
  }) as unknown as typeof fetch;
  const review = await prepareTokenWithdrawal(
    tokenWithdrawalInput(
      wallet,
      recipient,
      formatNativeBalance(amount.toString(), 6),
      1,
      mint,
      6,
    ),
    AbortSignal.timeout(10000),
    fetcher,
  );
  const signed = await signNativeWithdrawal(native.session, review, () => {});
  const message = Uint8Array.from(atob(signed.transaction), (c) =>
      c.charCodeAt(0),
    ).slice(65),
    keys = getCompiledTransactionMessageDecoder()
      .decode(message)
      .staticAccounts.map(String),
    source = keys.indexOf(review.token!.sourceAccount),
    destination = keys.indexOf(review.token!.destinationAccount);
  const preBalances: string[] = keys.map((_, i) =>
    i === 0
      ? '2000000000'
      : i === source
        ? accountRent.toString()
        : i === destination
          ? existing
            ? accountRent.toString()
            : '0'
          : '1',
  );
  const postBalances = [...preBalances];
  postBalances[0] = (
    2000000000n -
    5000n -
    (existing ? 0n : accountRent)
  ).toString();
  postBalances[destination] = accountRent.toString();
  const tokenBalance = (index: number, owner: string, raw: bigint) => ({
    accountIndex: index,
    mint,
    owner,
    programId: program,
    uiTokenAmount: { amount: raw.toString(), decimals: 6 },
  });
  const receipt = {
    version: 'legacy' as const,
    slot: '120',
    blockTime: null,
    transaction: [signed.transaction, 'base64'],
    meta: {
      err: null,
      fee: '5000',
      preBalances,
      postBalances,
      preTokenBalances: [
        tokenBalance(source, wallet, balance),
        ...(existing ? [tokenBalance(destination, recipient, 100n)] : []),
      ],
      postTokenBalances: [
        tokenBalance(source, wallet, balance - amount),
        tokenBalance(
          destination,
          recipient,
          BigInt(review.token!.transferFee?.netAmountRaw ?? amount.toString()) +
            (existing ? 100n : 0n),
        ),
      ],
    },
  };
  return {
    review,
    signed,
    receipt,
    fetcher,
    data,
    wallet,
    recipient,
    mint,
    source,
    destination,
  };
}
