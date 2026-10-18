import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit-v1';
import {
  getAllocateInstructionDataEncoder,
  getAssignInstructionDataEncoder,
  getCreateAccountAllowPrefundInstructionDataEncoder,
  getCreateAccountInstructionDataEncoder,
  getTransferSolInstructionDataEncoder,
} from '@solana-program/system';
import { getTransferCheckedInstructionDataEncoder } from '@solana-program/token';
import bs58 from 'bs58';
import { pumpGroupChainEffectsFixture } from './pump-group-chain-effects-fixture';
import { requirePumpLaunchGroupReview } from '../lib/pump-launch-group-review';
import {
  PUMP_LAUNCH_PROGRAM,
  PUMP_NATIVE_QUOTE,
  PUMP_TOKEN_2022,
} from '../lib/pump-launch-config';
import createSchema from '../lib/pump-launch-schema.json';
import buySchema from '../lib/pump-initial-buy-schema.json';
import quoteSchema from '../lib/pump-exact-quote-schema.json';
import type { PumpLaunchRpc } from '../lib/pump-launch-simulation';

/** Synthetic execution metadata using real compiled/signed packets and official
 * instruction encoders. Chosen funding sizes/amounts are test data, not measured
 * rent, BPF execution, current balances or actual Pump chain observations. */
export async function pumpGroupPaymentFixture(
  stock = false,
  mode: 'create' | 'prefund' | 'split' = 'create',
  baseline?: Awaited<ReturnType<typeof pumpGroupChainEffectsFixture>>,
) {
  const f = baseline ?? (await pumpGroupChainEffectsFixture(stock)),
    { built } = await requirePumpLaunchGroupReview(f.review, false);
  const native = f.review.input.create.quoteMint === PUMP_NATIVE_QUOTE;
  const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    SYSTEM = '11111111111111111111111111111111';
  const payer = f.review.input.create.payer,
    mint = f.review.input.create.mint,
    quoteMint = f.review.input.create.quoteMint;
  const matches = (d: ArrayLike<number> | undefined, p: number[]) =>
    !!d && p.every((n, i) => d[i] === n);
  const creation = built.packets[0].instructions
    .find(
      (ix) =>
        String(ix.programAddress) === PUMP_LAUNCH_PROGRAM &&
        matches(ix.data, createSchema.instruction.discriminator),
    )!
    .accounts!.map((a) => String(a.address));
  const curve = creation[2],
    curveBase = creation[3],
    curveQuote = native ? '' : creation[17];
  const buyers = built.packets.flatMap((p) => p.buyerAccounts);
  const balances = new Map<string, bigint>(),
    tokens = new Map<
      string,
      {
        owner: string;
        mint: string;
        programId: string;
        decimals: number;
        amount: bigint;
      }
    >();
  const fresh = new Set([
    mint,
    curve,
    curveBase,
    ...(!native ? [curveQuote] : []),
    ...buyers.flatMap((b) => [
      b.userBaseAccount,
      b.volumeAccount,
      ...(!native ? [b.buybackAccount] : []),
    ]),
  ]);
  for (const key of fresh) balances.set(key, 0n);
  if (!native)
    for (const b of buyers) {
      balances.set(b.userQuoteAccount, 2000000n);
      tokens.set(b.userQuoteAccount, {
        owner: b.payer,
        mint: quoteMint,
        programId: built.quote.tokenProgram,
        decimals: built.quote.decimals,
        amount: 1000000000000n,
      });
    }
  if (mode === 'prefund')
    for (const b of buyers) balances.set(b.userBaseAccount, 2000000n);
  const receipts = built.packets.map((packet, i) => {
    const transaction = f.signed.packets[i].transaction;
    const message = getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(Buffer.from(transaction, 'base64'))
          .messageBytes,
      ),
      keys = message.staticAccounts.map(String);
    const get = (key: string) => balances.get(key) ?? 1000000000000n;
    const preBalances = keys.map((key) => get(key).toString());
    const tokenRows = () =>
      keys.flatMap((key, accountIndex) => {
        const t = tokens.get(key);
        return t
          ? [
              {
                accountIndex,
                mint: t.mint,
                owner: t.owner,
                programId: t.programId,
                uiTokenAmount: {
                  amount: t.amount.toString(),
                  decimals: t.decimals,
                },
              },
            ]
          : [];
      });
    const preTokenBalances = tokenRows();
    balances.set(payer, get(payer) - 5000n);
    const innerInstructions: {
      index: number;
      instructions: {
        programIdIndex: number;
        accounts: number[];
        data: string;
        stackHeight: number;
      }[];
    }[] = [];
    for (const [rootIndex, ix] of packet.instructions.entries()) {
      const program = String(ix.programAddress),
        accounts = (ix.accounts ?? []).map((a) => String(a.address));
      const instructions: (typeof innerInstructions)[number]['instructions'] =
        [];
      function push(
        program: string,
        addresses: string[],
        data: Uint8Array,
        stackHeight = 2,
      ) {
        const programIdIndex = keys.indexOf(program),
          indices = addresses.map((a) => keys.indexOf(a));
        if (programIdIndex < 0 || indices.some((i) => i < 0))
          throw new Error('Synthetic CPI address is outside exact packet');
        instructions.push({
          programIdIndex,
          accounts: indices,
          data: bs58.encode(data),
          stackHeight,
        });
      }
      function transfer(from: string, to: string, amount: bigint, depth = 2) {
        push(
          SYSTEM,
          [from, to],
          Uint8Array.from(
            getTransferSolInstructionDataEncoder().encode({ amount }),
          ),
          depth,
        );
        balances.set(from, get(from) - amount);
        balances.set(to, get(to) + amount);
      }
      function create(
        from: string,
        to: string,
        owner: string,
        space: bigint,
        amount: bigint,
        depth = 2,
      ) {
        if (
          mode === 'split' &&
          owner === PUMP_TOKEN_2022 &&
          buyers.some((b) => b.userBaseAccount === to)
        ) {
          transfer(from, to, amount, depth);
          push(
            SYSTEM,
            [to],
            Uint8Array.from(
              getAllocateInstructionDataEncoder().encode({ space }),
            ),
            depth,
          );
          push(
            SYSTEM,
            [to],
            Uint8Array.from(
              getAssignInstructionDataEncoder().encode({
                programAddress: owner as Parameters<
                  ReturnType<typeof getAssignInstructionDataEncoder>['encode']
                >[0]['programAddress'],
              }),
            ),
            depth,
          );
        } else {
          const prefund =
              mode === 'prefund' &&
              buyers.some((b) => b.userBaseAccount === to),
            additional = prefund ? 0n : amount;
          const args = {
            lamports: additional,
            space,
            programAddress: owner as Parameters<
              ReturnType<
                typeof getCreateAccountInstructionDataEncoder
              >['encode']
            >[0]['programAddress'],
          };
          const data = Uint8Array.from(
            prefund
              ? getCreateAccountAllowPrefundInstructionDataEncoder().encode(
                  args,
                )
              : getCreateAccountInstructionDataEncoder().encode(args),
          );
          push(SYSTEM, prefund ? [to] : [from, to], data, depth);
          balances.set(from, get(from) - additional);
          balances.set(to, get(to) + additional);
        }
      }
      function tokenAccount(
        from: string,
        to: string,
        owner: string,
        tokenMint: string,
        tokenProgram: string,
        decimals: number,
        nested: boolean,
      ) {
        if (tokens.has(to)) return;
        if (nested)
          push(
            ATA,
            [from, to, owner, tokenMint, SYSTEM, tokenProgram],
            Uint8Array.of(1),
          );
        create(from, to, tokenProgram, 165n, 2000000n, nested ? 3 : 2);
        tokens.set(to, {
          owner,
          mint: tokenMint,
          programId: tokenProgram,
          decimals,
          amount: 0n,
        });
      }
      if (
        program === PUMP_LAUNCH_PROGRAM &&
        matches(ix.data, createSchema.instruction.discriminator)
      ) {
        create(payer, mint, PUMP_TOKEN_2022, 256n, 3000000n);
        create(payer, curve, PUMP_LAUNCH_PROGRAM, 200n, 2500000n);
        tokenAccount(payer, curveBase, curve, mint, PUMP_TOKEN_2022, 6, true);
        tokens.get(curveBase)!.amount = 1000000000000000n;
        if (!native)
          tokenAccount(
            payer,
            curveQuote,
            curve,
            quoteMint,
            built.quote.tokenProgram,
            built.quote.decimals,
            true,
          );
      } else if (program === ATA) {
        tokenAccount(
          accounts[0],
          accounts[1],
          accounts[2],
          accounts[3],
          accounts[5],
          accounts[3] === mint ? 6 : built.quote.decimals,
          false,
        );
      } else if (
        program === PUMP_LAUNCH_PROGRAM &&
        (matches(ix.data, buySchema.instruction.discriminator) ||
          matches(ix.data, quoteSchema.instruction.discriminator))
      ) {
        const b = packet.buyerAccounts.find((b) => b.payer === accounts[8])!;
        create(b.payer, b.volumeAccount, PUMP_LAUNCH_PROGRAM, 200n, 1500000n);
        if (native) {
          transfer(b.payer, curve, 950n);
          transfer(b.payer, b.buybackAccount, 50n);
        } else {
          const q = tokens.get(b.userQuoteAccount)!;
          q.amount -= 1000n;
          tokens.get(curveQuote)!.amount += 950n;
          tokens.get(b.buybackAccount)!.amount += 50n;
          push(
            built.quote.tokenProgram,
            [b.userQuoteAccount, quoteMint, curveQuote, b.payer],
            Uint8Array.from(
              getTransferCheckedInstructionDataEncoder().encode({
                amount: 950n,
                decimals: built.quote.decimals,
              }),
            ),
          );
          push(
            built.quote.tokenProgram,
            [b.userQuoteAccount, quoteMint, b.buybackAccount, b.payer],
            Uint8Array.from(
              getTransferCheckedInstructionDataEncoder().encode({
                amount: 50n,
                decimals: built.quote.decimals,
              }),
            ),
          );
        }
        const holder = f.review.input.holders.find(
          (h) => h.address === b.payer,
        );
        const amount = BigInt(
          b.payer === payer
            ? f.review.input.developer!.tokenAmountRaw
            : holder?.kind === 'exact-base-output'
              ? holder.tokenAmountRaw
              : holder?.kind === 'exact-quote-input'
                ? holder.minimumTokenOutputRaw
                : '0',
        );
        tokens.get(curveBase)!.amount -= amount;
        tokens.get(b.userBaseAccount)!.amount += amount;
        push(
          PUMP_TOKEN_2022,
          [curveBase, mint, b.userBaseAccount, curve],
          Uint8Array.from(
            getTransferCheckedInstructionDataEncoder().encode({
              amount,
              decimals: 6,
            }),
          ),
        );
      }
      if (instructions.length)
        innerInstructions.push({ index: rootIndex, instructions });
    }
    return {
      slot: String(f.review.simulation.maximumSlot + 10 + i),
      transaction: [transaction, 'base64'],
      meta: {
        err: null as unknown,
        fee: '5000',
        preBalances,
        postBalances: keys.map((k) => get(k).toString()),
        preTokenBalances,
        postTokenBalances: tokenRows(),
        innerInstructions,
      },
    };
  });
  const rpc: PumpLaunchRpc = async (method, params) => {
    if (method === 'getGenesisHash')
      return f.rpc(method, params, new AbortController().signal);
    if (method === 'getTransaction') {
      const i = f.signed.packets.findIndex((p) => p.signature === params[0]);
      if (i < 0) throw Error('Unknown synthetic payment packet');
      return structuredClone(receipts[i]);
    }
    throw Error('Synthetic payments allow finalized reads only');
  };
  return { ...f, built, receipts, rpc };
}
