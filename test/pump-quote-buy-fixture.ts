// Synthetic fixed-amount buy with published account roles, not a live buy receipt.
import capture from './proxima-wrapped-pump-transactions.json';
import schema from '../lib/pump-quote-route-schema.json';
import type { TrackedTransaction } from '../lib/tracked-wallet-transaction';
import { movementInvocation } from '../lib/movement-invocation';
import bs58 from 'bs58';
export function pumpQuoteBuyFixture() {
  const tx = structuredClone(capture.transactions[0]) as TrackedTransaction;
  const old = tx.movementInstructions!.find((i) =>
    i.dataHex?.startsWith(schema.discriminator),
  )!;
  const branch = movementInvocation(tx.movementInstructions!, old).descendants;
  const role = (name: string) => old.accounts![schema.accounts.indexOf(name)];
  const base = tx.tokenChanges.find((t) => t.mint === capture.mint)!;
  const quote = tx.tokenChanges.find((t) => t.mint === role('quote_mint'))!;
  let cost = 0n;
  for (const i of branch.filter((i) => i.type === 'transferChecked')) {
    if (i.info!.mint === capture.mint) {
      i.info!.source = role('associated_base_bonding_curve');
      i.info!.destination = role('associated_base_user');
      i.info!.authority = role('bonding_curve');
    } else {
      cost += BigInt(i.info!.amount!);
      i.info!.source = role('associated_quote_user');
      i.info!.authority = tx.address;
      if (i.info!.destination === role('associated_quote_user'))
        i.info!.destination = role('associated_quote_bonding_curve');
    }
  }
  const amount = BigInt(base.afterRaw) - BigInt(base.beforeRaw);
  base.beforeRaw = '0';
  base.afterRaw = (-amount).toString();
  base.changeRaw = base.afterRaw;
  quote.beforeRaw = cost.toString();
  quote.afterRaw = '0';
  quote.changeRaw = (-cost).toString();
  const data = Buffer.alloc(25);
  Buffer.from(schema.buy.discriminator, 'hex').copy(data);
  data.writeBigUInt64LE(-amount, 8);
  data.writeBigUInt64LE(cost, 16);
  const root = {
    ...old,
    topLevel: true,
    outerInstructionIndex: 0,
    stackHeight: 1,
    dataHex: data.toString('hex'),
    accounts: schema.buy.accounts.map((name) =>
      name === 'global_volume_accumulator' ? role('global') : role(name),
    ),
  };
  delete root.innerInstructionIndex;
  tx.movementInstructions = [
    root,
    ...branch.map((i, n) => ({
      ...i,
      outerInstructionIndex: 0,
      innerInstructionIndex: n,
      stackHeight: i.stackHeight! - 1,
    })),
  ];
  tx.source = 'fixture.test';
  tx.signature = bs58.encode(new Uint8Array(64).fill(11));
  return tx;
}
