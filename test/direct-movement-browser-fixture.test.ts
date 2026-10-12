import { expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import schema from '../lib/movement-route-schema.json';
import { directMovementFixture } from './direct-movement-fixture';
import { classifyWalletMovement } from '../lib/wallet-movement-classification';
it('generates decoded synthetic movement cards for browser verification', async () => {
  const cards = schema.programs.flatMap((p, i) => p.variants.map((v, j) => {
    const tx = directMovementFixture(i, j), change = tx.tokenChanges[1];
    const classification = classifyWalletMovement(tx, change.mint);
    expect(classification.kind).toBe('buy');
    return { name: `${p.name} ${v.name}`, classification, changeRaw: change.changeRaw, decimals: change.decimals };
  }));
  const sell = directMovementFixture(0, 2), change = sell.tokenChanges[0];
  cards.push({ name: 'PumpSwap target-token sell', classification: classifyWalletMovement(sell, change.mint), changeRaw: change.changeRaw, decimals: change.decimals });
  await mkdir('work/direct-movement-qa', { recursive: true });
  await writeFile('work/direct-movement-qa/fixture.json', JSON.stringify(cards));
});
