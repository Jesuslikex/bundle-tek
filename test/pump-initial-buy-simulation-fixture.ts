import bs58 from 'bs58';
import {
  generateKeyPairSigner,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import {
  pumpSimulationFixture,
  raw,
  SYSTEM,
} from './pump-launch-simulation-fixture';
import { buildPumpCreateAndBuyMessage } from '../lib/pump-initial-buy-message';
import {
  PUMP_LAUNCH_PROGRAM,
  PUMP_TOKEN,
  PUMP_TOKEN_2022,
} from '../lib/pump-launch-config';
import {
  type PumpLaunchRpc,
  type PumpRpcAccount,
  pumpAccountBytes,
} from '../lib/pump-launch-simulation';
import {
  decodePumpInitialBuyState,
  pumpInitialBuyPrice,
} from '../lib/pump-initial-buy-state';

const u64 = (value: bigint) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
};
const u32 = (value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
};
const join = (pieces: Uint8Array[]) => Uint8Array.from(Buffer.concat(pieces));
const rates = join([u64(0n), u64(95n), u64(30n)]);
/** Independently laid-out Borsh bytes; no production encoder or schema iterator. */
export function initialBuyFeeFixture() {
  return join([
    Uint8Array.of(143, 52, 146, 187, 219, 123, 76, 155),
    Uint8Array.of(1),
    new Uint8Array(32),
    rates,
    u32(1),
    new Uint8Array(16),
    rates,
    u32(1),
    new Uint8Array(16),
    rates,
    new Uint8Array(24),
  ]);
}
export function initialBuyVolumeFixture(user: string, volume = 0n) {
  const bytes = new Uint8Array(137);
  bytes.set([86, 255, 112, 14, 102, 53, 154, 250]);
  bytes.set(bs58.decode(user), 8);
  new DataView(bytes.buffer).setBigUint64(57, volume, true);
  return bytes;
}
export async function pumpInitialBuySimulationFixture(
  stock = false,
  token22 = false,
  upgradeable = false,
) {
  const baseline = await pumpSimulationFixture(stock, upgradeable),
    { f, before } = baseline;
  const recipient = (await generateKeyPairSigner()).address;
  const global = f.input({
    buyback_fee_recipients: Array(8).fill(recipient),
    buyback_basis_points: 5000n,
  }).global;
  before.set(f.pdas.global, raw(PUMP_LAUNCH_PROGRAM, global.data));
  const quoteProgram = stock && token22 ? PUMP_TOKEN_2022 : PUMP_TOKEN;
  if (stock && token22) {
    const mint = f.quoteAccount([], PUMP_TOKEN_2022);
    before.set(f.quoteMint, raw(mint.owner, mint.data));
  }
  if (!stock) {
    const native = new Uint8Array(82);
    native[44] = 9;
    native[45] = 1;
    before.set(baseline.intent.quoteMint, raw(PUMP_TOKEN, native));
  }
  before.set(
    PUMP_TOKEN,
    raw(
      'BPFLoader2111111111111111111111111111111111',
      Uint8Array.of(3),
      '1000000',
      true,
    ),
  );
  const packet = await buildPumpCreateAndBuyMessage({
    create: {
      ...baseline.intent,
      ...baseline.base,
      quoteMint: baseline.intent.quoteMint,
      global,
      ...(stock
        ? {
            quoteMintAccount: {
              address: f.quoteMint,
              owner: quoteProgram,
              data: pumpAccountBytes(before.get(f.quoteMint)!),
              executable: false,
              slot: 100,
            },
          }
        : {}),
    },
    tokenAmountRaw: '1000000000000',
    maximumQuoteCostRaw: '100000000',
  });
  const curveQuote = String(packet.instructions.at(-1)!.accounts![7].address);
  const token = (
    mint: string,
    owner: string,
    amount: bigint,
    token22 = false,
  ) => {
    const bytes = baseline.custody(mint, amount, token22);
    bytes.set(bs58.decode(owner), 32);
    return bytes;
  };
  if (stock)
    before.set(
      packet.userQuoteAccount,
      raw(quoteProgram, token(f.quoteMint, f.payer, 200000000n, token22)),
    );
  else before.set(packet.buybackAccount, raw(SYSTEM));
  before.set(
    packet.feeConfig,
    raw('pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ', initialBuyFeeFixture()),
  );
  let creationPost: Map<string, PumpRpcAccount> | null = null;
  baseline.state.postHook = (post) => {
    if (stock && token22)
      post.set(
        curveQuote,
        raw(quoteProgram, token(f.quoteMint, f.pdas.bondingCurve, 0n, true)),
      );
    creationPost = new Map(post);
  };
  const state = {
    postHook: (_post: Map<string, PumpRpcAccount>) => {},
    err: null as unknown,
    units: '300000',
    loadedBytes: '1048576',
    replacement: null as unknown,
    fee: '10000',
    slot: '100',
  };
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    calls.push({ method, params });
    if (method === 'simulateTransaction') {
      const tx = getTransactionDecoder().decode(
          Uint8Array.from(atob(params[0] as string), (char) =>
            char.charCodeAt(0),
          ),
        ),
        message = getCompiledTransactionMessageDecoder().decode(
          tx.messageBytes,
        );
      if (message.version === 1) {
        if (!creationPost) throw new Error('Creation evidence is missing.');
        const price = pumpInitialBuyPrice({
          quoteMint: baseline.intent.quoteMint,
          virtualTokensRaw: '1073000000000000',
          virtualQuoteRaw: stock ? '100000000' : '30000000000',
          tokenAmountRaw: '1000000000000',
          feeConfig: decodePumpInitialBuyState(
            'FeeConfig',
            initialBuyFeeFixture(),
          ),
        });
        const principal = BigInt(price.principalRaw),
          protocol = BigInt(price.protocolFeeRaw),
          creator = BigInt(price.creatorFeeRaw),
          buyback = protocol / 2n,
          total = BigInt(price.totalQuoteCostRaw);
        const post = new Map(creationPost);
        const curve = f.config('BondingCurve', {
          virtual_token_reserves: 1072000000000000n,
          virtual_quote_reserves:
            (stock ? 100000000n : 30000000000n) + principal,
          real_token_reserves: 792100000000000n,
          real_quote_reserves: principal,
          token_total_supply: 1000000000000000n,
          creator: f.payer,
          quote_mint: stock ? f.quoteMint : SYSTEM,
          initial_virtual_quote_reserves: stock ? 100000000n : 30000000000n,
          creator_fee: creator,
          protocol_fees: protocol - buyback,
        });
        post.set(
          f.pdas.bondingCurve,
          raw(
            PUMP_LAUNCH_PROGRAM,
            curve,
            stock
              ? '1000000'
              : (
                  1000000n +
                  principal +
                  creator +
                  protocol -
                  buyback
                ).toString(),
          ),
        );
        post.set(
          f.pdas.associatedCurve,
          raw(
            PUMP_TOKEN_2022,
            token(f.mint, f.pdas.bondingCurve, 999000000000000n, true),
          ),
        );
        post.set(
          packet.userBaseAccount,
          raw(PUMP_TOKEN_2022, token(f.mint, f.payer, 1000000000000n, true)),
        );
        post.set(
          packet.volumeAccount,
          raw(PUMP_LAUNCH_PROGRAM, initialBuyVolumeFixture(f.payer)),
        );
        if (stock) {
          post.set(
            packet.userQuoteAccount,
            raw(
              quoteProgram,
              token(f.quoteMint, f.payer, 200000000n - total, token22),
            ),
          );
          post.set(
            curveQuote,
            raw(
              quoteProgram,
              token(
                f.quoteMint,
                f.pdas.bondingCurve,
                principal + creator + protocol - buyback,
                token22,
              ),
            ),
          );
          post.set(
            packet.buybackAccount,
            raw(quoteProgram, token(f.quoteMint, recipient, buyback, token22)),
          );
        } else
          post.set(
            packet.buybackAccount,
            raw(SYSTEM, new Uint8Array(), (1000000n + buyback).toString()),
          );
        const rent = stock ? 7000000n : 5000000n;
        post.set(
          f.payer,
          raw(
            SYSTEM,
            new Uint8Array(),
            (1000000000n - 10000n - rent - (stock ? 0n : total)).toString(),
          ),
        );
        state.postHook(post);
        const keys = (params[1] as { accounts: { addresses: string[] } })
          .accounts.addresses;
        return {
          context: { slot: state.slot },
          value: {
            err: state.err,
            accounts: keys.map((key) => post.get(key) ?? null),
            unitsConsumed: state.units,
            fee: state.fee,
            loadedAccountsDataSize: state.loadedBytes,
            replacementBlockhash: state.replacement,
          },
        };
      }
    }
    return baseline.rpc(method, params, signal);
  };
  return {
    ...baseline,
    rpc,
    calls,
    packet,
    state,
    token,
    setMetadataUri: (uri: string) => {
      baseline.intent.uri = uri;
    },
    curveQuote,
    intent: {
      ...baseline.intent,
      tokenAmountRaw: '1000000000000',
      maximumQuoteCostRaw: '100000000',
    },
  };
}
