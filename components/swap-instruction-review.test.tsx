import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import { solanaTransferMessage } from '@/lib/solana-funding';
import { reviewSwapInstructions } from '@/lib/swap-instruction-review';
import { SwapInstructionReview } from './swap-instruction-review';
it('renders decoded actions and explicit review gaps with expandable instruction bytes', () => {
  const message = getCompiledTransactionMessageDecoder().decode(
    Uint8Array.from([
      128,
      ...solanaTransferMessage(
        '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi',
        '8phnoC6V8nwYnNUwobNBoWzWAmyP1nj9GyYZaMbU8z4',
        '11111111111111111111111111111111',
        9007199254740993n,
      ),
      0,
    ]),
  );
  const html = renderToStaticMarkup(
    <SwapInstructionReview review={reviewSwapInstructions(message)} />,
  );
  expect(html).toContain('Unsigned swap instruction review');
  expect(html).toContain('Native SOL transfer');
  expect(html).toContain('9007199254740993');
  expect(html).toContain('lamports');
  expect(html).toContain('Recognition is not execution clearance');
  expect(html).toContain('Review transaction instructions');
  expect(html).not.toContain('<button');
  expect(renderToStaticMarkup(<SwapInstructionReview />)).toContain(
    'unavailable',
  );
  const withTables = renderToStaticMarkup(
    <SwapInstructionReview
      review={reviewSwapInstructions(message)}
      lookupObservation={{
        slot: 100,
        recheckSlot: 102,
        tables: [
          {
            address: 'public-table',
            sha256: 'checked-fingerprint',
            lastExtendedSlot: '90',
          },
        ],
      }}
    />,
  );
  expect(withTables).toContain('Address-table observations');
  expect(withTables).toContain('rechecked slot');
  expect(withTables).toContain('checked-fingerprint');
});
