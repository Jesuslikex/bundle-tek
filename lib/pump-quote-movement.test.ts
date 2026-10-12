import { expect, it } from 'vitest';
import capture from '../test/proxima-wrapped-pump-transactions.json';
import type { TrackedTransaction } from './tracked-wallet-transaction';
import {
  classifyWalletMovement,
  requireMovementClassification,
} from './wallet-movement-classification';
import { movementInvocation } from './movement-invocation';
const fixture = () =>
  structuredClone(capture.transactions[0]) as TrackedTransaction;
const route = (tx: TrackedTransaction) =>
  tx.movementInstructions!.find((i) =>
    i.dataHex?.startsWith('5df6823ce7e940b2'),
  )!;
it('reconstructs only the Pump invocation rather than subsequent swap siblings', () => {
  const tx = fixture(),
    call = movementInvocation(tx.movementInstructions!, route(tx));
  expect(call.root.program).toBe(
    'GMGNreQcJFufBiCTLDBgKhYEfEe9B454UjpDr5CaSLA1',
  );
  expect(call.descendants).toHaveLength(7);
  expect(
    call.descendants.some(
      (i) => i.program === 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
    ),
  ).toBe(false);
});
it('verifies actual venue proceeds and preserves their non-settlement scope', () => {
  for (const value of capture.transactions) {
    const tx = value as TrackedTransaction,
      c = classifyWalletMovement(tx, capture.mint);
    expect(c.kind).toBe('sell');
    expect(c.quote?.scope).toBe('venue-transfer');
    expect(c.reason).toContain('final wallet proceeds');
    expect(() =>
      requireMovementClassification(c, tx.tokenChanges[0].changeRaw),
    ).not.toThrow();
  }
});
it.each([
  'missing-depth',
  'duplicate-ordinal',
  'depth-jump',
  'duplicate-root',
] as const)('withholds %s CPI attribution', (mutation) => {
  const tx = fixture(),
    facts = tx.movementInstructions!,
    call = route(tx);
  if (mutation === 'missing-depth')
    delete facts.find(
      (i) => i.innerInstructionIndex === 2 && i.outerInstructionIndex === 5,
    )!.stackHeight;
  if (mutation === 'duplicate-ordinal')
    facts.find(
      (i) => i.innerInstructionIndex === 2 && i.outerInstructionIndex === 5,
    )!.innerInstructionIndex = 1;
  if (mutation === 'depth-jump') call.stackHeight = 4;
  if (mutation === 'duplicate-root')
    facts.push({
      ...facts.find((i) => i.topLevel && i.outerInstructionIndex === 5)!,
    });
  expect(classifyWalletMovement(tx, capture.mint).kind).toBe('unknown');
});
it.each([
  'wrong-user',
  'wrong-source',
  'wrong-amount',
  'wrong-mint',
  'missing-quote',
  'token-fee-layout',
  'foreign-branch-program',
  'outside-base-operation',
] as const)('withholds %s transfer evidence', (mutation) => {
  const tx = fixture(),
    facts = tx.movementInstructions!,
    call = route(tx),
    base = tx.tokenChanges[0];
  const leg = facts.find(
    (i) => i.info?.mint === capture.mint && i.type === 'transferChecked',
  )!;
  if (mutation === 'wrong-user') call.accounts![13] = call.accounts![10];
  if (mutation === 'wrong-source') leg.info!.source = call.accounts![11];
  if (mutation === 'wrong-amount')
    leg.info!.amount = (BigInt(leg.info!.amount!) - 1n).toString();
  if (mutation === 'wrong-mint') leg.info!.mint = call.accounts![2];
  if (mutation === 'missing-quote')
    facts.splice(
      facts.findIndex(
        (i) =>
          i.info?.destination === call.accounts![15] &&
          i.type === 'transferChecked',
      ),
      1,
    );
  if (mutation === 'missing-quote')
    facts
      .filter((i) => !i.topLevel && i.outerInstructionIndex === 5)
      .forEach((i, n) => {
        i.innerInstructionIndex = n;
      });
  if (mutation === 'token-fee-layout') leg.type = 'transferCheckedWithFee';
  if (mutation === 'foreign-branch-program')
    leg.program = '11111111111111111111111111111111';
  if (mutation === 'outside-base-operation')
    facts.push({
      program: base.program,
      topLevel: true,
      type: 'burn',
      info: { account: base.accounts[0], amount: '1' },
    });
  expect(classifyWalletMovement(tx, capture.mint).kind).toBe('unknown');
});
it('does not trust a venue quote as a direct/native quote or accept missing scope', () => {
  const tx = fixture(),
    c = classifyWalletMovement(tx, capture.mint);
  for (const invalid of [
    { ...c, quote: { ...c.quote!, scope: undefined } },
    { ...c, basis: 'pump-native-and-token-transfers' as const },
    {
      ...c,
      basis: 'jupiter-route-and-transfers' as const,
      protocol: 'Jupiter' as const,
    },
    { ...c, kind: 'buy' as const },
  ])
    expect(() =>
      requireMovementClassification(invalid, tx.tokenChanges[0].changeRaw),
    ).toThrow();
});
it('classifies a direct sell_v2 invocation through its own CPI group', () => {
  const tx = fixture(),
    call = route(tx),
    invocation = movementInvocation(tx.movementInstructions!, call);
  const root = {
    ...call,
    topLevel: true,
    outerInstructionIndex: 0,
    stackHeight: 1,
  };
  delete root.innerInstructionIndex;
  tx.movementInstructions = [
    root,
    ...invocation.descendants.map((i, n) => ({
      ...i,
      outerInstructionIndex: 0,
      innerInstructionIndex: n,
      stackHeight: i.stackHeight! - 1,
    })),
  ];
  expect(classifyWalletMovement(tx, capture.mint)).toMatchObject({
    kind: 'sell',
    quote: { scope: 'venue-transfer' },
  });
});
it('rejects a conflicting minimum quote and overlapping account roles', () => {
  for (const mutation of ['minimum', 'overlap']) {
    const tx = fixture(),
      call = route(tx);
    if (mutation === 'overlap') call.accounts![15] = call.accounts![12];
    else {
      const minimum = Buffer.alloc(8);
      minimum.writeBigUInt64LE((1n << 64n) - 1n);
      call.dataHex = call.dataHex!.slice(0, 32) + minimum.toString('hex');
    }
    expect(classifyWalletMovement(tx, capture.mint).kind).toBe('unknown');
  }
});
