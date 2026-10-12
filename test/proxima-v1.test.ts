import { expect, it } from 'vitest';
import captures from './proxima-v1-transactions.json';
import { decodeTrackedTransaction } from '../lib/tracked-wallet-transaction';
import { classifyWalletMovement } from '../lib/wallet-movement-classification';
const mint = 'Ap1o2WJYUarJLjT5LQWGH1ztuiV4PcUyqEEfL8jbpump';
const decode = (capture = structuredClone(captures[1])) =>
  ({ ...decodeTrackedTransaction(capture.raw, capture.wallet, capture.signature),
    address: capture.wallet, signature: capture.signature, network: 'mainnet' as const,
    source: 'public-chain-fixture', observedAt: '2026-10-12T19:26:19.000Z',
    commitment: 'confirmed' as const });

it('decodes real v1 FLASH sell and buy receipts with scoped venue quotes', () => {
  captures.forEach((capture, index) => {
    const tx = decode(capture);
    expect(tx.transactionVersion).toBe(1);
    expect(tx.transactionConfig?.computeUnitLimit).toBe(550000);
    expect(classifyWalletMovement(tx, mint)).toMatchObject({
      kind: index === 0 ? 'sell' : 'buy',
      protocol: 'Pump.fun',
      quote: { scope: 'venue-transfer', raw: index === 0 ? '41225546' : '43001184' },
    });
  });
});

it.each(['config', 'priority-overflow', 'lookup', 'signer'] as const)(
  'rejects malformed v1 %s evidence', (mutation) => {
    const capture = structuredClone(captures[1]);
    const message = capture.raw.transaction.message;
    if (mutation === 'config') Object.assign(message.transactionConfig, { unknown: '1' });
    if (mutation === 'priority-overflow') message.transactionConfig.priorityFee = '18446744073709551616';
    if (mutation === 'lookup') message.accountKeys[1].source = 'lookupTable';
    if (mutation === 'signer') message.accountKeys[1].signer = !message.accountKeys[1].signer;
    expect(() => decode(capture)).toThrow();
  },
);

it.each(['rent-payer', 'rent-account', 'rent-owner', 'initialize-owner', 'callback', 'hidden-transfer'] as const)(
  'does not classify a buy with mismatched associated setup: %s', (mutation) => {
    const tx = decode();
    const rent = tx.movementInstructions!.find(i => i.type === 'createAccount')!;
    const init = tx.movementInstructions!.find(i => i.type === 'initializeAccount3')!;
    if (mutation === 'rent-payer') rent.info!.source = mint;
    if (mutation === 'rent-account') rent.info!.newAccount = mint;
    if (mutation === 'rent-owner') rent.info!.owner = mint;
    if (mutation === 'initialize-owner') init.info!.owner = mint;
    if (mutation === 'callback') rent.stackHeight = rent.stackHeight! + 1;
    if (mutation === 'hidden-transfer') rent.type = 'transfer';
    expect(classifyWalletMovement(tx, mint).kind).toBe('unknown');
  },
);
