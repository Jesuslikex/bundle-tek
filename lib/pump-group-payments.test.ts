import { beforeAll, expect, it } from 'vitest';
import {
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit-v1';
import { getTransferSolInstructionDataEncoder } from '@solana-program/system';
import bs58 from 'bs58';
import { pumpGroupPaymentFixture } from '../test/pump-group-payment-fixture';
import {
  collectPumpGroupReceiptEvidence,
  parsePumpGroupReceiptEvidence,
} from './pump-group-receipt-evidence';
import { projectVerifiedPumpGroupPayments } from './pump-group-payments';
import { validatedAccountLaunchPayments } from './account-launch-payments';
import type { PumpLaunchRpc } from './pump-launch-simulation';
import { PUMP_LAUNCH_PROGRAM } from './pump-launch-config';
let f: Awaited<ReturnType<typeof pumpGroupPaymentFixture>>, stock: typeof f;
const signal = () => new AbortController().signal;
beforeAll(async () => {
  f = await pumpGroupPaymentFixture();
  stock = await pumpGroupPaymentFixture(true);
}, 120000);
async function analysis(fixture = f, rpc: PumpLaunchRpc = fixture.rpc) {
  const captured = await collectPumpGroupReceiptEvidence(
    fixture.group,
    signal(),
    rpc,
  );
  const parsed = await parsePumpGroupReceiptEvidence(
    captured,
    fixture.group,
    signal(),
  );
  return {
    evidence: parsed,
    value: await projectVerifiedPumpGroupPayments(
      parsed,
      fixture.group,
      signal(),
    ),
  };
}
const changed =
  (
    edit: (r: (typeof f.receipts)[number], index: number) => void,
    fixture = f,
  ): PumpLaunchRpc =>
  async (m, p, s) => {
    const v = await fixture.rpc(m, p, s);
    if (m === 'getTransaction' && v !== null)
      edit(
        v as (typeof f.receipts)[number],
        fixture.signed.packets.findIndex((t) => t.signature === p[0]),
      );
    return v;
  };
it('separates exact native purchase payments, creation funding and payer fees for all18 active buyers', async () => {
  const { value } = await analysis();
  expect(value.complete).toBe(true);
  expect(value.purchaseQuoteSubtotalRaw).toBe('18000');
  expect(value.accountFundingSubtotalLamports).toBe('70500000');
  expect(value.knownNetworkFeeLamports).toBe(
    String(f.signed.packets.length * 5000),
  );
  const buys = value.packets.flatMap((p) => p.wallets).filter((w) => w.hasBuy);
  expect(buys).toHaveLength(18);
  expect(
    buys.every(
      (w) => w.purchaseQuoteRaw === '1000' && BigInt(w.acquiredRaw) > 0n,
    ),
  ).toBe(true);
  expect(
    value.packets
      .flatMap((p) => p.wallets)
      .filter((w) => w.wallet === f.review.input.create.payer)
      .reduce((s, w) => s + BigInt(w.accountFundingLamports), 0n),
  ).toBe(11000000n);
  expect(buys.some((w) => w.wallet === f.review.input.create.payer)).toBe(true);
  expect(f.review.input.holders.filter((h) => h.kind === 'none')).toHaveLength(
    1,
  );
  expect(
    buys
      .filter((w) => w.wallet !== f.review.input.create.payer)
      .every(
        (w) =>
          w.accountFundingLamports === '3500000' &&
          w.networkFeeLamports === '0',
      ),
  ).toBe(true);
  expect(value).toMatchObject({
    rentRecoveryVerified: false,
    venueFeeSplitVerified: false,
    acquisitionBasisVerified: false,
    tipIncluded: false,
    executionAllowed: false,
  });
});
it('keeps token-quote debit in its exact units, separate from SOL setup and network costs', async () => {
  const { value } = await analysis(stock);
  expect(value.complete).toBe(true);
  expect(value.quoteMint).toBe(stock.review.input.create.quoteMint);
  expect(value.quoteDecimals).toBe(stock.built.quote.decimals);
  expect(value.purchaseQuoteSubtotalRaw).toBe('18000');
  expect(value.accountFundingSubtotalLamports).toBe('74500000');
  expect(
    value.packets
      .flatMap((p) => p.wallets)
      .filter((w) => w.hasBuy)
      .every((w) => w.purchaseQuoteRaw === '1000'),
  ).toBe(true);
  expect(value.acquisitionBasisVerified).toBe(false);
});
it('does not charge pre-existing account funding again when prefunded creation has no payer', async () => {
  const prefunded = await pumpGroupPaymentFixture(false, 'prefund', f);
  const { value } = await analysis(prefunded);
  expect(value.complete).toBe(true);
  expect(value.purchaseQuoteSubtotalRaw).toBe('18000');
  expect(value.accountFundingSubtotalLamports).toBe('34500000');
  expect(
    value.packets
      .flatMap((p) => p.wallets)
      .filter((w) => w.hasBuy)
      .every((w) => w.preTokenBalanceRecovered),
  ).toBe(true);
  const { value: missingOwner } = await analysis(
    prefunded,
    changed((r, i) => {
      if (i !== 0) return;
      const row = r.meta.postTokenBalances.find(
        (t) =>
          t.owner === f.built.packets[0].buyerAccounts[0].payer &&
          t.mint === f.review.input.create.mint,
      )!;
      delete (row as { owner?: string }).owner;
    }, prefunded),
  );
  expect(missingOwner.packets[0].verified).toBe(false);
  expect(missingOwner.packets[0].reason).toBe('balance-metadata-missing');
  const { value: contradictoryPre } = await analysis(
    prefunded,
    changed((r, i) => {
      if (i !== 0) return;
      const row = structuredClone(
        r.meta.postTokenBalances.find(
          (t) =>
            t.owner === f.built.packets[0].buyerAccounts[0].payer &&
            t.mint === f.review.input.create.mint,
        )!,
      );
      row.uiTokenAmount.amount = '0';
      r.meta.preTokenBalances.push(row);
    }, prefunded),
  );
  expect(contradictoryPre.packets[0].verified).toBe(false);
  expect(contradictoryPre.packets[0].reason).toBe('setup-funding-unclassified');
});
it('reconciles transfer, allocate and assign setup without treating it as a buy payment', async () => {
  const split = await pumpGroupPaymentFixture(false, 'split', f),
    { value } = await analysis(split);
  expect(value.complete).toBe(true);
  expect(value.accountFundingSubtotalLamports).toBe('70500000');
  expect(value.purchaseQuoteSubtotalRaw).toBe('18000');
});
it('keeps missing instruction metadata unavailable while retaining known packet fees', async () => {
  const { value } = await analysis(
    f,
    changed((r) => {
      delete (r.meta as Record<string, unknown>).innerInstructions;
    }),
  );
  expect(value.verifiedPacketCount).toBe(0);
  expect(value.complete).toBe(false);
  expect(
    value.packets.every(
      (p) => p.reason === 'instruction-metadata-missing' && !p.wallets.length,
    ),
  ).toBe(true);
  expect(value.knownNetworkFeeLamports).toBe(
    String(f.signed.packets.length * 5000),
  );
});
it('preserves checked later packets when the first receipt is missing', async () => {
  const { value } = await analysis(f, async (m, p, s) =>
    m === 'getTransaction' && p[0] === f.signed.packets[0].signature
      ? null
      : f.rpc(m, p, s),
  );
  expect(value.complete).toBe(false);
  expect(value.packets[0].reason).toBe('receipt-unobserved');
  expect(value.packets.slice(1).every((p) => p.verified)).toBe(true);
  expect(BigInt(value.purchaseQuoteSubtotalRaw)).toBeGreaterThan(0n);
  expect(BigInt(value.purchaseQuoteSubtotalRaw)).toBeLessThan(18000n);
});
it('refuses duplicate or missing call-depth metadata without borrowing a simulated amount', async () => {
  for (const edit of [
    (r: (typeof f.receipts)[number]) => {
      r.meta.innerInstructions.push(
        structuredClone(r.meta.innerInstructions[0]),
      );
    },
    (r: (typeof f.receipts)[number]) => {
      (
        r.meta.innerInstructions[0].instructions[0] as unknown as {
          stackHeight: null;
        }
      ).stackHeight = null;
    },
  ]) {
    const { value } = await analysis(
      f,
      changed((r, i) => {
        if (i === 0) edit(r);
      }),
    );
    expect(value.packets[0].verified).toBe(false);
    expect(value.packets[0].reason).toBe('instruction-scope-differs');
    expect(value.packets[0].wallets).toEqual([]);
    expect(value.packets.slice(1).every((p) => p.verified)).toBe(true);
  }
});
it('refuses wrong setup payers, missing allocation and unsupported native operations', async () => {
  for (const mode of ['payer', 'allocation', 'unsupported'] as const) {
    const { value } = await analysis(
      f,
      changed((r, i) => {
        if (i !== 0) return;
        const message = getCompiledTransactionMessageDecoder().decode(
            getTransactionDecoder().decode(
              Buffer.from(r.transaction[0], 'base64'),
            ).messageBytes,
          ),
          keys = message.staticAccounts.map(String),
          system = keys.indexOf('11111111111111111111111111111111');
        const outer = r.meta.innerInstructions.find(
          (group) =>
            f.built.packets[i].instructions[group.index].programAddress ===
              'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL' &&
            String(
              f.built.packets[i].instructions[group.index].accounts![0].address,
            ) !== f.review.input.create.payer,
        )!;
        const target = outer.instructions.find(
          (ix) => ix.programIdIndex === system,
        )!;
        if (mode === 'payer') target.accounts[0] = 0;
        if (mode === 'allocation') {
          target.data = bs58.encode(
            Uint8Array.from(
              getTransferSolInstructionDataEncoder().encode({
                amount: 2000000n,
              }),
            ),
          );
        }
        if (mode === 'unsupported')
          target.data = bs58.encode(Uint8Array.of(5, 0, 0, 0));
      }),
    );
    expect(value.packets[0].verified).toBe(false);
    expect(value.packets[0].wallets).toEqual([]);
    expect(value.packets[0].reason).toBe(
      mode === 'payer'
        ? 'instruction-scope-differs'
        : mode === 'unsupported'
          ? 'native-instruction-unsupported'
          : 'setup-funding-unclassified',
    );
  }
});
it('refuses unsupported purchase destinations and unexplained wallet debits', async () => {
  for (const mode of ['destination', 'amount'] as const) {
    const { value } = await analysis(
      f,
      changed((r, i) => {
        if (i !== 0) return;
        const packet = f.built.packets[i],
          root = r.meta.innerInstructions.find(
            (group) =>
              packet.instructions[group.index].data?.length === 25 &&
              String(packet.instructions[group.index].programAddress) ===
                PUMP_LAUNCH_PROGRAM,
          )!;
        const message = getCompiledTransactionMessageDecoder().decode(
            getTransactionDecoder().decode(
              Buffer.from(r.transaction[0], 'base64'),
            ).messageBytes,
          ),
          keys = message.staticAccounts.map(String),
          system = keys.indexOf('11111111111111111111111111111111');
        const payment = root.instructions.find(
          (ix) => ix.programIdIndex === system && bs58.decode(ix.data)[0] === 2,
        )!;
        if (mode === 'destination')
          payment.accounts[1] = keys.indexOf(
            String(packet.instructions[root.index].accounts![12].address),
          );
        else
          payment.data = bs58.encode(
            Uint8Array.from(
              getTransferSolInstructionDataEncoder().encode({ amount: 951n }),
            ),
          );
      }),
    );
    expect(value.packets[0].verified).toBe(false);
    expect(value.packets[0].reason).toBe(
      mode === 'destination'
        ? 'setup-funding-unclassified'
        : 'native-flow-unexplained',
    );
  }
});
it('counts only the fee from a failed packet, ignoring rolled-back CPI transfers and token effects', async () => {
  const last = f.signed.packets.length - 1;
  const { value } = await analysis(
    f,
    changed((r, i) => {
      if (i !== last) return;
      r.meta.err = { InstructionError: [0, { Custom: 42 }] };
      r.meta.postBalances = [...r.meta.preBalances];
      r.meta.postBalances[0] = (
        BigInt(r.meta.postBalances[0]) - 5000n
      ).toString();
      r.meta.postTokenBalances = structuredClone(r.meta.preTokenBalances);
    }),
  );
  expect(value.complete).toBe(true);
  expect(value.packets[last]).toMatchObject({
    verified: true,
    outcome: 'failed',
    wallets: [
      {
        hasBuy: false,
        purchaseQuoteRaw: '0',
        accountFundingLamports: '0',
        networkFeeLamports: '5000',
      },
    ],
  });
  expect(BigInt(value.purchaseQuoteSubtotalRaw)).toBeLessThan(18000n);
  expect(value.acquisitionBasisVerified).toBe(false);
});

it('does not mistake gross transfers for net spending when a wallet receives an unattributed native refund', async () => {
  const { value } = await analysis(
    f,
    changed((r, i) => {
      if (i !== 0) return;
      const packet = f.built.packets[i],
        root = r.meta.innerInstructions.find(
          (g) =>
            packet.instructions[g.index].data?.length === 25 &&
            String(packet.instructions[g.index].programAddress) ===
              PUMP_LAUNCH_PROGRAM,
        )!;
      const keys = getCompiledTransactionMessageDecoder()
          .decode(
            getTransactionDecoder().decode(
              Buffer.from(r.transaction[0], 'base64'),
            ).messageBytes,
          )
          .staticAccounts.map(String),
        outer = packet.instructions[root.index].accounts!;
      const from = keys.indexOf(String(outer[13].address)),
        to = keys.indexOf(String(outer[8].address));
      root.instructions.push({
        programIdIndex: keys.indexOf('11111111111111111111111111111111'),
        accounts: [from, to],
        data: bs58.encode(
          Uint8Array.from(
            getTransferSolInstructionDataEncoder().encode({ amount: 100n }),
          ),
        ),
        stackHeight: 2,
      });
      r.meta.postBalances[from] = (
        BigInt(r.meta.postBalances[from]) - 100n
      ).toString();
      r.meta.postBalances[to] = (
        BigInt(r.meta.postBalances[to]) + 100n
      ).toString();
    }),
  );
  expect(value.packets[0].verified).toBe(false);
  expect(value.packets[0].reason).toBe('native-flow-unexplained');
  expect(value.packets[0].wallets).toEqual([]);
});
it('validates evidence identity, exact totals and authority flags before display', async () => {
  const { value, evidence } = await analysis(),
    context = {
      reviewId: f.review.id,
      mint: value.mint,
      evidenceSha256: evidence.sha256,
    };
  expect(validatedAccountLaunchPayments(value, context)).toEqual(value);
  for (const patch of [
    { evidenceSha256: '0'.repeat(64) },
    { purchaseQuoteSubtotalRaw: '19001' },
    { knownNetworkFeeLamports: '0' },
    { complete: false },
    { acquisitionBasisVerified: true },
    { executionAllowed: true },
  ])
    expect(() =>
      validatedAccountLaunchPayments({ ...value, ...patch }, context),
    ).toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(
    projectVerifiedPumpGroupPayments(evidence, f.group, controller.signal),
  ).rejects.toThrow();
});
