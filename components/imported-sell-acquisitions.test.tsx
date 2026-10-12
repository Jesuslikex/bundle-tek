import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ImportedSellAcquisitionChoices,
  ImportedSellAcquisitions,
} from './imported-sell-acquisitions';
import { importedSellAcquisitions } from '@/lib/imported-sell-acquisitions';
import {
  acquisitionFixture,
  acquisitionWallet,
  acquisitionId,
} from '../test/imported-sell-acquisition-fixture';
it('renders bounded same-wallet choices and blocks a handed-off source until its complete accounting history is read', () => {
  const page = acquisitionFixture();
  const rows = renderToStaticMarkup(
    <ImportedSellAcquisitionChoices
      choices={importedSellAcquisitions(page, acquisitionWallet)}
      decimals={0}
      symbol="QA"
      selectedId={acquisitionId(56)}
      locked={false}
      onSelect={() => {}}
    />,
  );
  expect(rows).toContain('aria-pressed="true"');
  expect(rows.match(/<tbody>[\s\S]*?<\/tbody>/)![0].match(/<tr/g)).toHaveLength(
    50,
  );
  const project = {
    id: page.projectId,
    revision: 60,
    archived: false,
    document: {
      token: { chain: 'Solana', address: page.mint, decimals: 0, symbol: 'QA' },
    },
  } as Parameters<typeof ImportedSellAcquisitions>[0]['project'];
  const wallet = { address: acquisitionWallet, revision: 1 } as Parameters<
    typeof ImportedSellAcquisitions
  >[0]['wallet'];
  const html = renderToStaticMarkup(
    <ImportedSellAcquisitions
      project={project}
      wallet={wallet}
      amount="3"
      locked={false}
      initialBuyReceiptId={acquisitionId(2)}
      onAmountChange={() => {}}
    />,
  );
  expect(html).toContain(
    'Review recorded acquisitions before preparing this sell.',
  );
  expect(html).toMatch(
    /<button[^>]*disabled[^>]*>Prepare unsigned swap<\/button>/,
  );
  expect(html).toContain('not current holdings');
  expect(html).not.toContain('Assigned buy cost');
});
