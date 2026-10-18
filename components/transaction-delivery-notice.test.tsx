import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TransactionDeliveryNotice } from './transaction-delivery-notice';
it('distinguishes configured RPC delivery without guessing provider privacy or protection', () => {
  const html = renderToStaticMarkup(
    <TransactionDeliveryNotice transport="rpc" />,
  );
  expect(html).toContain('configured Solana RPC');
  expect(html).toContain('submitted individually');
  expect(html).toContain('does not request dedicated sandwich protection');
  expect(html).not.toContain('Delivery: Jito');
  expect(html).not.toContain('public RPC');
  expect(html).not.toContain('private RPC');
});
it('explains Jito limits without claiming dedicated sandwich protection', () => {
  const html = renderToStaticMarkup(
    <TransactionDeliveryNotice transport="jito-bundle" />,
  );
  expect(html).toContain('Jito bundle');
  expect(html).toContain('does not guarantee protection');
  expect(html).toContain('has not been verified');
  expect(html).toContain(
    'https://docs.jito.wtf/lowlatencytxnsend/#sandwich-mitigation',
  );
  expect(html).toContain('noopener noreferrer');
});
it.each(['rpc', 'jito-bundle'] as const)(
  'cannot grant approval or initiate delivery for %s',
  (transport) => {
    const html = renderToStaticMarkup(
      <TransactionDeliveryNotice transport={transport} />,
    );
    expect(html).toContain('aria-label="Transaction delivery"');
    expect(html).not.toMatch(/<(input|button|form|script)\b/);
  },
);
