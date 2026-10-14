import { expect, it } from 'vitest';
import { pumpHolderSettlementFixture as fixture } from '../test/pump-holder-settlement-fixture';
for (const [stock, token22, developer, quoteInput] of [
  [false, false, true, true],
  [true, false, true, true],
  [true, true, true, true],
  [false, false, false, true],
  [true, false, false, false],
])
  it(`reconciles the entire synthetic holder packet (stock=${stock}, token22=${token22}, developer=${developer}, quoteInput=${quoteInput})`, async () => {
    const f = await fixture(stock, token22, developer, quoteInput),
      result = await f.run();
    expect(result).toMatchObject({
      accountingValidated: true,
      rpcCollectionRequired: true,
      signingAllowed: false,
      executionAllowed: false,
      completeLaunch: false,
      buybackSplitRoundingAttested: false,
      packetSha256: f.packet.packetSha256,
    });
    expect(result.wallets).toHaveLength(developer ? 3 : 2);
    expect(new Set(result.rentAccounts.map((r) => r.payer))).toEqual(
      new Set([
        f.input.create.payer,
        ...f.input.holders
          .filter((h) => h.kind !== 'none')
          .map((h) => h.address),
      ]),
    );
  });
it('rejects missing final wallets, changed packet order and incomplete creation evidence', async () => {
  const f = await fixture();
  f.evidence.after.pop();
  await expect(f.run()).rejects.toThrow('mapping');
  const g = await fixture();
  g.evidence.addresses.reverse();
  await expect(g.run()).rejects.toThrow('mapping');
  const h = await fixture();
  h.evidence.creationAccountHashes = [];
  await expect(h.run()).rejects.toThrow('evidence is incomplete');
});
it('rejects a holder output shortfall and wrong destination owner', async () => {
  for (const offset of [64, 32]) {
    const f = await fixture(),
      buyer = f.packet.buyerAccounts[1];
    f.change(buyer.userBaseAccount, (a) => {
      const b = Buffer.from(a.data[0], 'base64');
      b[offset] ^= 1;
      a.data[0] = b.toString('base64');
    });
    await expect(f.run()).rejects.toThrow();
  }
});
it('rejects quote overspending, unexplained SOL debit and too-small per-holder rent approval', async () => {
  const f = await fixture();
  f.change(f.input.holders[1].address, (a) => {
    a.lamports = (BigInt(a.lamports) - 1n).toString();
  });
  await expect(f.run()).rejects.toThrow('quote debit exceeds');
  const g = await fixture(true);
  g.change(g.input.holders[0].address, (a) => {
    a.lamports = (BigInt(a.lamports) - 1n).toString();
  });
  await expect(g.run()).rejects.toThrow('SOL debit differs');
  const h = await fixture();
  h.limits.holders[0].feeAndRentLimitRaw = '1';
  await expect(h.run()).rejects.toThrow('fee/rent debit');
});
it('rejects migration and retained fee/reserve changes even when a provider reports success', async () => {
  for (const patch of [
    { complete: true },
    { real_token_reserves: 1n },
    { protocol_fees: 0n },
    { creator_fee: 0n },
  ]) {
    const f = await fixture();
    f.change(f.curveKey, (a) => {
      a.data[0] = Buffer.from(
        f.f.f.config('BondingCurve', { ...f.curveFields, ...patch }),
      ).toString('base64');
    });
    await expect(f.run()).rejects.toThrow();
  }
});
it('rejects rent underfunding, unrelated creation changes and readonly mutations', async () => {
  const f = await fixture();
  f.evidence.minimumRentBySize = {};
  await expect(f.run()).rejects.toThrow();
  const g = await fixture();
  g.change(g.input.create.global.address, (a) => {
    a.lamports = '1';
  });
  await expect(g.run()).rejects.toThrow('readonly');
  const h = await fixture();
  h.change(h.input.create.mint, (a) => {
    a.data[0] = '';
  });
  await expect(h.run()).rejects.toThrow('mint metadata');
});
