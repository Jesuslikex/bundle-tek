import bs58 from 'bs58';
import {
  getExtensionEncoder,
  type ExtensionArgs,
} from '@solana-program/token-2022';
import {
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit';
import { pumpLaunchFixture } from './pump-launch-fixture';
import {
  type PumpCreateIntent,
  type PumpLaunchRpc,
  type PumpRpcAccount,
} from '../lib/pump-launch-simulation';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import {
  PUMP_LAUNCH_PROGRAM,
  PUMP_NATIVE_QUOTE,
  PUMP_TOKEN_2022,
} from '../lib/pump-launch-config';
export const SYSTEM = '11111111111111111111111111111111',
  UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
export const raw = (
  owner: string,
  data: Uint8Array = new Uint8Array(),
  lamports = '1000000',
  executable = false,
): NonNullable<PumpRpcAccount> => ({
  owner,
  executable,
  lamports,
  data: [Buffer.from(data).toString('base64'), 'base64'],
});
function extensions(base: Uint8Array, mint: boolean, values: ExtensionArgs[]) {
  const header = new Uint8Array(166);
  header.set(base);
  header[165] = mint ? 1 : 2;
  return Uint8Array.from(
    Buffer.concat([
      header,
      ...values.map((e) => getExtensionEncoder().encode(e)),
    ]),
  );
}
export async function pumpSimulationFixture(
  tokenQuote = false,
  upgradeable = false,
) {
  const f = await pumpLaunchFixture(),
    base = f.input();
  const intent: PumpCreateIntent = {
    name: base.name,
    symbol: base.symbol,
    uri: base.uri,
    payer: f.payer,
    mint: f.mint,
    quoteMint: tokenQuote ? f.quoteMint : PUMP_NATIVE_QUOTE,
  };
  const state = {
    genesis: SOLANA_MAINNET_GENESIS,
    slot: '100',
    fee: '10000',
    height: '900',
    valid: true,
    units: '150000',
    err: null as unknown,
    replacement: null as unknown,
    simFee: '10000',
    postHook: (_post: Map<string, PumpRpcAccount>) => {},
    stableHook: (_pre: Map<string, PumpRpcAccount>) => {},
    minContextOffset: 0,
    headerChanged: false,
  };
  const before = new Map<string, PumpRpcAccount>([
    [f.payer, raw(SYSTEM, new Uint8Array(), '1000000000')],
    [f.pdas.global, raw(PUMP_LAUNCH_PROGRAM, base.global.data)],
    [f.pdas.control, null],
    [f.mint, null],
    [f.pdas.bondingCurve, null],
    [f.pdas.associatedCurve, null],
    [f.pdas.mayhemState, null],
    [f.pdas.mayhemTokenVault, null],
    [f.pdas.solVault, raw(SYSTEM)],
  ]);
  const programKeys = [
    PUMP_LAUNCH_PROGRAM,
    PUMP_TOKEN_2022,
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e',
  ];
  for (const key of programKeys)
    before.set(
      key,
      raw(
        'BPFLoader2111111111111111111111111111111111',
        Uint8Array.of(1, 2),
        '1000000',
        true,
      ),
    );
  for (const key of [SYSTEM, 'ComputeBudget111111111111111111111111111111'])
    before.set(
      key,
      raw(
        'NativeLoader1111111111111111111111111111111',
        Uint8Array.of(1),
        '1',
        true,
      ),
    );
  before.set(f.pdas.mintAuthority, null);
  before.set(f.pdas.eventAuthority, null);
  before.set(f.pdas.globalParams, null);
  if (tokenQuote) {
    const q = f.quoteAccount();
    before.set(f.quoteMint, raw(q.owner, q.data));
    before.set(
      q.owner,
      raw(
        'BPFLoader2111111111111111111111111111111111',
        Uint8Array.of(2),
        '1000000',
        true,
      ),
    );
  }
  const programDataKey = bs58.encode(new Uint8Array(32).fill(222));
  if (upgradeable) {
    const link = new Uint8Array(36);
    new DataView(link.buffer).setUint32(0, 2, true);
    link.set(bs58.decode(programDataKey), 4);
    before.set(PUMP_LAUNCH_PROGRAM, raw(UPGRADEABLE, link, '1000000', true));
  }
  const metadataMint = () => {
    const bytes = new Uint8Array(82);
    bytes[44] = 6;
    bytes[45] = 1;
    new DataView(bytes.buffer).setBigUint64(36, 1000000000000000n, true);
    return extensions(bytes, true, [
      { __kind: 'MetadataPointer', authority: null, metadataAddress: f.mint },
      {
        __kind: 'TokenMetadata',
        updateAuthority: null,
        mint: f.mint,
        name: intent.name,
        symbol: intent.symbol,
        uri: intent.uri,
        additionalMetadata: new Map(),
      },
    ]);
  };
  const custody = (mint: string, amount: bigint, token22 = true) => {
    const bytes = new Uint8Array(165);
    bytes.set(bs58.decode(mint), 0);
    bytes.set(bs58.decode(f.pdas.bondingCurve), 32);
    new DataView(bytes.buffer).setBigUint64(64, amount, true);
    bytes[108] = 1;
    return token22
      ? extensions(bytes, false, [{ __kind: 'ImmutableOwner' }])
      : bytes;
  };
  let fullReads = 0,
    headerReads = 0;
  const calls: Array<{
    method: string;
    params: unknown[];
    signal: AbortSignal;
  }> = [];
  const rpc: PumpLaunchRpc = async (method, params, signal) => {
    calls.push({ method, params, signal });
    if (method === 'getGenesisHash') return state.genesis;
    if (method === 'getLatestBlockhash')
      return {
        context: { slot: state.slot },
        value: { blockhash: base.blockhash, lastValidBlockHeight: '1000' },
      };
    if (method === 'getMultipleAccounts') {
      const keys = params[0] as string[],
        options = params[1] as { dataSlice?: unknown };
      if (options.dataSlice) {
        headerReads++;
        const header = new Uint8Array(45),
          view = new DataView(header.buffer);
        view.setUint32(0, 3, true);
        view.setBigUint64(
          4,
          state.headerChanged && headerReads > 1 ? 2n : 1n,
          true,
        );
        header[12] = 1;
        header.set(bs58.decode(f.payer), 13);
        return {
          context: { slot: state.slot },
          value: keys.map(() => raw(UPGRADEABLE, header)),
        };
      }
      if (keys.includes(f.payer)) {
        fullReads++;
        if (fullReads > 1) state.stableHook(before);
      }
      return {
        context: {
          slot: (Number(state.slot) + state.minContextOffset).toString(),
        },
        value: keys.map((key) => before.get(key) ?? null),
      };
    }
    if (method === 'getFeeForMessage')
      return { context: { slot: state.slot }, value: state.fee };
    if (method === 'simulateTransaction') {
      const tx = getTransactionDecoder().decode(
          Buffer.from(params[0] as string, 'base64'),
        ),
        message = getCompiledTransactionMessageDecoder().decode(
          tx.messageBytes,
        );
      const post = new Map(before),
        accounts = (params[1] as { accounts: { addresses: string[] } }).accounts
          .addresses;
      const curve = f.config('BondingCurve', {
        virtual_token_reserves: 1073000000000000n,
        virtual_quote_reserves: tokenQuote ? 100000000n : 30000000000n,
        real_token_reserves: 793100000000000n,
        token_total_supply: 1000000000000000n,
        creator: f.payer,
        quote_mint: tokenQuote ? f.quoteMint : SYSTEM,
        initial_virtual_quote_reserves: tokenQuote ? 100000000n : 30000000000n,
      });
      post.set(f.mint, raw(PUMP_TOKEN_2022, metadataMint()));
      post.set(f.pdas.bondingCurve, raw(PUMP_LAUNCH_PROGRAM, curve));
      post.set(
        f.pdas.associatedCurve,
        raw(PUMP_TOKEN_2022, custody(f.mint, 1000000000000000n)),
      );
      let rent = 3000000n;
      if (tokenQuote) {
        const ix =
          message.version === 'legacy' ? message.instructions[1] : null;
        if (!ix) throw new Error('Wrong fixture message');
        const quoteAta = String(message.staticAccounts[ix.accountIndices![17]]);
        post.set(
          quoteAta,
          raw(f.quoteAccount().owner, custody(f.quoteMint, 0n, false)),
        );
        rent += 1000000n;
      }
      post.set(
        f.payer,
        raw(
          SYSTEM,
          new Uint8Array(),
          (1000000000n - BigInt(state.fee) - rent).toString(),
        ),
      );
      state.postHook(post);
      return {
        context: { slot: state.slot },
        value: {
          err: state.err,
          unitsConsumed: state.units,
          replacementBlockhash: state.replacement,
          fee: state.simFee,
          accounts: accounts.map((key) => post.get(key) ?? null),
        },
      };
    }
    if (method === 'getMinimumBalanceForRentExemption') return '100000';
    if (method === 'isBlockhashValid')
      return { context: { slot: state.slot }, value: state.valid };
    if (method === 'getBlockHeight') return state.height;
    throw new Error('Unexpected fixture RPC ' + method);
  };
  return { f, base, intent, state, before, rpc, calls, metadataMint, custody };
}
