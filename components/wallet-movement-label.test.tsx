import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { WalletMovementLabel } from './wallet-movement-label';
import { classifyWalletMovement } from '@/lib/wallet-movement-classification';
import { directMovementFixture } from '../test/direct-movement-fixture';
import { nativePumpFixture } from '../test/pump-native-fixture';
import captured from '../test/proxima-wrapped-pump-transactions.json';
import type { TrackedTransaction } from '../lib/tracked-wallet-transaction';
import { pumpQuoteBuyFixture } from '../test/pump-quote-buy-fixture';
it('keeps unverified final wallet cost visible for a venue buy', () => {
  const tx = pumpQuoteBuyFixture();
  const html = renderToStaticMarkup(
    <WalletMovementLabel
      classification={classifyWalletMovement(tx, tx.tokenChanges[0].mint)}
      changeRaw={tx.tokenChanges[0].changeRaw}
      decimals={6}
    />,
  );
  expect(html).toContain('<strong>buy</strong>');
  expect(html).toContain('Final wallet cost is unverified');
  expect(html).not.toContain('Final wallet proceeds');
});
it('shows proven wrapped venue sells and keeps final-proceeds uncertainty visible', () => {
  const tx = captured.transactions[0] as TrackedTransaction;
  const html = renderToStaticMarkup(
    <WalletMovementLabel
      classification={classifyWalletMovement(tx, captured.mint)}
      changeRaw={tx.tokenChanges[0].changeRaw}
      decimals={6}
    />,
  );
  expect(html).toContain('<strong>sell</strong>');
  expect(html).toContain('Venue quote transfer:');
  expect(html).toContain('Final wallet proceeds are unverified');
  expect(html).not.toContain('Observed opposite leg:');
});
it('labels native Pump.fun SOL payments without presenting them as wrapped token units', () => {
  const tx = nativePumpFixture();
  const html = renderToStaticMarkup(
    <WalletMovementLabel
      classification={classifyWalletMovement(tx, tx.tokenChanges[0].mint)}
      changeRaw="1000"
      decimals={6}
    />,
  );
  expect(html).toContain('Pump.fun');
  expect(html).toContain('SOL');
  expect(html).not.toContain('units of');
  expect(html).not.toContain('https://solscan.io/token/');
});
it.each([
  [0, 'PumpSwap'],
  [2, 'Raydium CPMM'],
] as const)(
  'shows decoded %s protocol, exact quote units and disclosed counterparty account provenance',
  (program, protocol) => {
    const tx = directMovementFixture(program, 0),
      classification = classifyWalletMovement(tx, tx.tokenChanges[1].mint);
    const html = renderToStaticMarkup(
      <WalletMovementLabel
        classification={classification}
        changeRaw="1000"
        decimals={6}
      />,
    );
    for (const text of [
      'buy',
      '+0.001',
      protocol,
      'Observed opposite leg: 0.001',
      'Classification evidence',
      'without inferred wallet ownership',
    ])
      expect(html).toContain(text);
    expect(html).toContain('https://solscan.io/account/');
  },
);
it('explains legacy unknown evidence without inventing a protocol or quote', () => {
  const html = renderToStaticMarkup(
    <WalletMovementLabel changeRaw="1" decimals={9} />,
  );
  expect(html).toContain('unknown');
  expect(html).toContain('Inspect signatures again');
  expect(html).not.toContain('Observed opposite leg');
});
