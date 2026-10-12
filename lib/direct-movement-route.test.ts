import { expect, it } from 'vitest';
import { directMovementFixture } from '../test/direct-movement-fixture';
import schema from './movement-route-schema.json';
import {
  classifyWalletMovement,
  requireMovementClassification,
} from './wallet-movement-classification';
import { supplyWallet as address } from '../test/supply-history-fixture';
import { decodeDirectMovementRoute } from './direct-movement-route';
import { decodeTrackedTransaction } from './tracked-wallet-transaction';
import bs58 from 'bs58';
it('requires exact CPMM account, mint, vault and amount boundaries including fee-adjusted output', () => {
  const p = schema.programs.findIndex((value) => value.name === 'Raydium CPMM');
  for (let v = 0; v < 2; v++) {
    const tx = directMovementFixture(p, v),
      instruction = tx.movementInstructions![0];
    expect(decodeDirectMovementRoute(instruction)).toMatchObject({
      protocol: 'Raydium CPMM',
      authority: tx.address,
      inputMint: tx.tokenChanges[0].mint,
      outputMint: tx.tokenChanges[1].mint,
    });
    for (const accounts of [
      instruction.accounts!.slice(0, 12),
      [...instruction.accounts!, address(98)],
    ])
      expect(
        decodeDirectMovementRoute({ ...instruction, accounts }),
      ).toBeNull();
    for (const index of [8, 9]) {
      const wrong = structuredClone(instruction);
      wrong.accounts![index] = address(99);
      expect(decodeDirectMovementRoute(wrong)).toBeNull();
    }
    for (const index of [10, 11]) {
      const wrong = structuredClone(tx);
      wrong.movementInstructions![0].accounts![index] = address(99);
      expect(
        classifyWalletMovement(wrong, wrong.tokenChanges[1].mint).kind,
      ).toBe('unknown');
    }
    const feeAdjusted = structuredClone(tx);
    feeAdjusted.tokenChanges[1].afterRaw = '990';
    feeAdjusted.tokenChanges[1].changeRaw = '990';
    expect(
      classifyWalletMovement(feeAdjusted, feeAdjusted.tokenChanges[1].mint)
        .kind,
    ).toBe('unknown');
    const token2022 = structuredClone(tx);
    for (const index of [8, 9])
      token2022.movementInstructions![0].accounts![index] =
        'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    for (const change of token2022.tokenChanges)
      change.program = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    for (const leg of token2022.movementInstructions!.slice(1))
      leg.program = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
    expect(
      classifyWalletMovement(token2022, token2022.tokenChanges[1].mint),
    ).toMatchObject({ kind: 'buy', protocol: 'Raydium CPMM' });
  }
});
it('decodes Raydium optional target orders without shifting the wallet or vault roles', () => {
  const programIndex = schema.programs.findIndex(
    (p) => p.name === 'Raydium AMM v4',
  );
  for (const opcode of ['09', '0b']) {
    const variantIndex = schema.programs[programIndex].variants.findIndex(
      (v) => v.discriminator === opcode && v.accountCount === 18,
    );
    const tx = directMovementFixture(programIndex, variantIndex);
    const instruction = tx.movementInstructions![0];
    const full = decodeDirectMovementRoute(instruction);
    const shorter = structuredClone(tx);
    shorter.movementInstructions![0].accounts!.splice(4, 1);
    expect(decodeDirectMovementRoute(shorter.movementInstructions![0])).toEqual(
      full,
    );
    expect(
      classifyWalletMovement(shorter, shorter.tokenChanges[1].mint).kind,
    ).toBe('buy');
    const wrong = structuredClone(tx);
    wrong.movementInstructions![0].accounts!.splice(5, 1);
    expect(classifyWalletMovement(wrong, wrong.tokenChanges[1].mint).kind).toBe(
      'unknown',
    );
    for (const accounts of [
      instruction.accounts!.slice(0, 16),
      [...instruction.accounts!, address(97)],
    ])
      expect(
        decodeDirectMovementRoute({ ...instruction, accounts }),
      ).toBeNull();
  }
});
for (let p = 0; p < schema.programs.length; p++)
  for (let v = 0; v < schema.programs[p].variants.length; v++) {
    const protocol = schema.programs[p].name,
      variant = schema.programs[p].variants[v];
    it(`classifies ${protocol} ${variant.name} only with authorized reconciled token legs`, () => {
      const tx = directMovementFixture(p, v);
      for (const [mint, kind] of [
        [tx.tokenChanges[1].mint, 'buy'],
        [tx.tokenChanges[0].mint, 'sell'],
      ]) {
        const classification = classifyWalletMovement(tx, mint);
        expect(classification).toMatchObject({
          kind,
          protocol,
          basis: 'protocol-route-and-transfers',
        });
        expect(() =>
          requireMovementClassification(
            classification,
            tx.tokenChanges.find((t) => t.mint === mint)!.changeRaw,
          ),
        ).not.toThrow();
      }
      for (const mutate of [
        (t: typeof tx) => {
          t.walletSigner = false;
        },
        (t: typeof tx) => {
          t.failed = true;
        },
        (t: typeof tx) => {
          t.movementInstructions![0].accounts![variant.authority] = address(90);
        },
        (t: typeof tx) => {
          t.movementInstructions![1].info!.destination = address(91);
        },
        (t: typeof tx) => {
          t.movementInstructions![2].info!.source = address(92);
        },
        (t: typeof tx) => {
          t.movementInstructions![1].info!.mint = address(93);
        },
        (t: typeof tx) => {
          t.tokenChanges[1].changeRaw = '999';
        },
        (t: typeof tx) => {
          t.movementInstructions!.push({
            program: address(94),
            topLevel: true,
          });
        },
        (t: typeof tx) => {
          t.movementInstructions!.push(t.movementInstructions![0]);
        },
      ]) {
        const changed = structuredClone(tx);
        mutate(changed);
        expect(
          classifyWalletMovement(changed, changed.tokenChanges[1].mint).kind,
        ).toBe('unknown');
      }
    });
  }
it('counts PumpSwap quote fees only when they use decoded fee accounts and fit the approved bound', () => {
  const tx = directMovementFixture(0, 0),
    variant = schema.programs[0].variants[0];
  tx.movementInstructions![1].info!.amount = '990000';
  tx.movementInstructions!.push({
    ...tx.movementInstructions![1],
    info: {
      ...tx.movementInstructions![1].info,
      amount: '10000',
      destination: tx.movementInstructions![0].accounts![variant.outgoing[1]],
    },
  });
  expect(classifyWalletMovement(tx, tx.tokenChanges[1].mint).quote?.raw).toBe(
    '1000000',
  );
  tx.movementInstructions!.at(-1)!.info!.destination = address(99);
  expect(classifyWalletMovement(tx, tx.tokenChanges[1].mint).kind).toBe(
    'unknown',
  );
});
it('rejects malformed sizes, option booleans, account roles and out-of-bound input/output amounts', () => {
  const tx = directMovementFixture(0, 0),
    route = tx.movementInstructions![0];
  expect(
    decodeDirectMovementRoute({ ...route, dataHex: route.dataHex! + '00' }),
  ).toBeNull();
  expect(
    decodeDirectMovementRoute({
      ...route,
      dataHex: route.dataHex!.slice(0, -2) + '02',
    }),
  ).toBeNull();
  expect(
    decodeDirectMovementRoute({
      ...route,
      accounts: route.accounts!.slice(0, 10),
    }),
  ).toBeNull();
  const foreignMint = structuredClone(tx);
  foreignMint.movementInstructions![0].accounts![3] = address(99);
  expect(
    classifyWalletMovement(foreignMint, tx.tokenChanges[1].mint).kind,
  ).toBe('unknown');
  tx.movementInstructions![1].info!.amount = '1000101';
  expect(classifyWalletMovement(tx, tx.tokenChanges[1].mint).kind).toBe(
    'unknown',
  );
});
it('keeps legacy Jupiter classifications readable while rejecting protocol/basis substitution', () => {
  expect(() =>
    requireMovementClassification(
      {
        kind: 'buy',
        basis: 'jupiter-route-and-transfers',
        reason: 'Earlier evidence',
        counterpartyAccounts: [],
        quote: { mint: address(4), raw: '1000', decimals: 9 },
      },
      '1000',
    ),
  ).not.toThrow();
  const tx = directMovementFixture(0, 0),
    classification = classifyWalletMovement(tx, tx.tokenChanges[1].mint);
  expect(() =>
    requireMovementClassification(
      { ...classification, protocol: 'Jupiter' },
      '1000',
    ),
  ).toThrow();
});
it('retains raw protocol bytes and parsed CPI legs through the real RPC transaction decoder', () => {
  for (let p = 0; p < schema.programs.length; p++)
    for (let v = 0; v < schema.programs[p].variants.length; v++) {
      const f = directMovementFixture(p, v),
        route = f.movementInstructions![0];
      const signature = bs58.encode(new Uint8Array(64).fill(1));
      const keys = [
        ...new Set([
          f.address,
          ...route.accounts!,
          route.program,
          ...f.programs,
          ...f.tokenChanges.map((t) => t.mint),
        ]),
      ];
      const balances = (after: boolean) =>
        f.tokenChanges.map((t) => ({
          accountIndex: String(keys.indexOf(t.accounts[0])),
          mint: t.mint,
          owner: f.address,
          programId: t.program,
          uiTokenAmount: {
            amount: after ? t.afterRaw : t.beforeRaw,
            decimals: String(t.decimals),
          },
        }));
      const raw = {
        slot: '100',
        blockTime: null,
        version: '0',
        transaction: {
          signatures: [signature],
          message: {
            accountKeys: keys.map((pubkey) => ({
              pubkey,
              signer: pubkey === f.address,
              writable: true,
              source: 'transaction',
            })),
            instructions: [
              {
                programId: route.program,
                accounts: route.accounts,
                data: bs58.encode(
                  Uint8Array.from(route.dataHex!.match(/../g)!, (h) =>
                    parseInt(h, 16),
                  ),
                ),
              },
            ],
          },
        },
        meta: {
          err: null,
          fee: '5000',
          preBalances: keys.map((_, i) => (i === 0 ? '1000000000' : '0')),
          postBalances: keys.map((_, i) => (i === 0 ? '999995000' : '0')),
          preTokenBalances: balances(false),
          postTokenBalances: balances(true),
          innerInstructions: [
            {
              index: '0',
              instructions: f.movementInstructions!.slice(1).map((i) => ({
                programId: i.program,
                parsed: { type: i.type, info: i.info },
              })),
            },
          ],
        },
      };
      const decoded = decodeTrackedTransaction(raw, f.address, signature);
      expect(decoded.movementInstructions?.[0].dataHex).toBe(route.dataHex);
      const tx = { ...f, ...decoded, signature };
      expect(classifyWalletMovement(tx, f.tokenChanges[1].mint)).toMatchObject({
        kind: 'buy',
        protocol: schema.programs[p].name,
      });
      const altered = structuredClone(raw);
      altered.meta.innerInstructions[0].instructions[0].parsed.info!.source =
        address(99);
      expect(() =>
        decodeTrackedTransaction(altered, f.address, signature),
      ).toThrow('missing');
    }
});
