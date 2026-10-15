import {
  address,
  getTransactionDecoder,
  getCompiledTransactionMessageDecoder,
} from '@solana/kit-v1';
import { findAssociatedTokenPda } from '@solana-program/token';
import { pumpLaunchGroupReviewFixture } from './pump-launch-group-review-fixture';
import { signSyntheticPumpGroup } from './pump-group-synthetic-signatures';
import { verifyPumpLaunchGroupSignatures } from '../lib/pump-launch-group-signatures';
import {
  PUMP_NATIVE_QUOTE,
  PUMP_TOKEN_2022,
  inspectPumpQuoteMint,
} from '../lib/pump-launch-config';
import { pumpCreateAddresses } from '../lib/pump-launch-message';
import { SOLANA_MAINNET_GENESIS } from '../lib/wallet-balances';
import type { PumpLaunchRpc } from '../lib/pump-launch-simulation';

/** Synthetic consistent receipt metadata only. No BPF, live provider, real wallet or send. */
export async function pumpGroupChainEffectsFixture(stock = false) {
  const f = await pumpLaunchGroupReviewFixture(stock);
  const signed = await verifyPumpLaunchGroupSignatures(
    f.review,
    await signSyntheticPumpGroup(f.review.packets, [
      f.fixture.f.f.payerSigner,
      f.fixture.f.f.mintSigner,
      ...f.fixture.holderSigners,
    ]),
  );
  const native = f.review.input.create.quoteMint === PUMP_NATIVE_QUOTE;
  const quote = native
    ? null
    : inspectPumpQuoteMint(f.fixture.input.create.quoteMintAccount!);
  const wallets = [
    f.review.input.create.payer,
    ...f.review.input.holders
      .filter((h) => h.kind !== 'none')
      .map((h) => h.address),
  ];
  const atas = await Promise.all(
    wallets
      .flatMap((owner) => [
        {
          owner,
          mint: f.review.input.create.mint,
          program: PUMP_TOKEN_2022,
          decimals: 6,
          base: true,
        },
        ...(!native
          ? [
              {
                owner,
                mint: f.review.input.create.quoteMint,
                program: quote!.tokenProgram,
                decimals: quote!.decimals,
                base: false,
              },
            ]
          : []),
      ])
      .map(async (t) => ({
        ...t,
        address: String(
          (
            await findAssociatedTokenPda({
              owner: address(t.owner),
              mint: address(t.mint),
              tokenProgram: address(t.program),
            })
          )[0],
        ),
      })),
  );
  const lamports = new Map<string, bigint>(),
    amounts = new Map<string, bigint>();
  for (const t of atas) {
    lamports.set(t.address, t.base ? 0n : 2000000n);
    amounts.set(t.address, t.base ? 0n : 1000000000000n);
  }
  const curve = String(
    (await pumpCreateAddresses(f.review.input.create.mint)).bondingCurve,
  );
  type Balance = {
    accountIndex: number;
    mint: string;
    owner: string;
    programId: string;
    uiTokenAmount: { amount: string; decimals: number };
  };
  const receipts = signed.packets.map((p) => {
    const tx = getTransactionDecoder().decode(
      Buffer.from(p.transaction, 'base64'),
    );
    const keys = getCompiledTransactionMessageDecoder()
      .decode(tx.messageBytes)
      .staticAccounts.map(String);
    const before = keys.map((k) => (lamports.get(k) ?? 1000000000n).toString());
    const after = before.map(BigInt);
    const tokenRows = (post: boolean): Balance[] =>
      atas.flatMap((t) => {
        const i = keys.indexOf(t.address);
        if (i < 0 || BigInt((post ? after : before)[i]) === 0n) return [];
        return [
          {
            accountIndex: i,
            mint: t.mint,
            owner: t.owner,
            programId: t.program,
            uiTokenAmount: {
              amount: amounts.get(t.address)!.toString(),
              decimals: t.decimals,
            },
          },
        ];
      });
    const preTokenBalances = tokenRows(false);
    after[0] -= 5000n;
    for (const t of atas.filter((t) => t.base && keys.includes(t.address))) {
      const holder = f.review.input.holders.find((h) => h.address === t.owner);
      const target =
        t.owner === f.review.input.create.payer
          ? f.review.input.developer?.tokenAmountRaw
          : holder?.kind === 'exact-base-output'
            ? holder.tokenAmountRaw
            : holder?.kind === 'exact-quote-input'
              ? holder.minimumTokenOutputRaw
              : undefined;
      if (target && amounts.get(t.address) === 0n) {
        amounts.set(t.address, BigInt(target));
        const i = keys.indexOf(t.address);
        if (after[i] === 0n) {
          after[i] = 2000000n;
          after[0] -= 2000000n;
        }
        if (native) {
          after[keys.indexOf(t.owner)] -= 1000n;
          after[keys.indexOf(curve)] += 1000n;
        } else {
          const q = atas.find((q) => !q.base && q.owner === t.owner)!;
          amounts.set(q.address, amounts.get(q.address)! - 1000n);
        }
      }
    }
    const postTokenBalances = tokenRows(true);
    keys.forEach((k, i) => lamports.set(k, after[i]));
    return {
      slot: String(f.review.simulation.maximumSlot + 10),
      transaction: [p.transaction, 'base64'],
      meta: {
        err: null as unknown,
        fee: '5000',
        preBalances: before,
        postBalances: after.map(String),
        preTokenBalances,
        postTokenBalances,
      },
    };
  });
  const rpc: PumpLaunchRpc = async (method, params) => {
    if (method === 'getGenesisHash') return SOLANA_MAINNET_GENESIS;
    if (method === 'getTransaction') {
      const i = signed.packets.findIndex((p) => p.signature === params[0]);
      if (i < 0) throw new Error('Unknown synthetic signature');
      return structuredClone(receipts[i]);
    }
    throw new Error('Unexpected read-only effects method');
  };
  return {
    ...f,
    signed,
    receipts,
    rpc,
    group: { review: f.review, signedEvidence: signed },
  };
}
