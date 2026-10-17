import { expect, it } from 'vitest';
import { validateIntent } from './intent';
import { ponsIntent, randomSalt, walletTransaction } from './client';

const wallet = '0x4EAb299482FC2a4606626B56601718F2a346C49F';
const draft = {
  name: 'Test',
  symbol: 'TEST',
  description: '',
  logo: '',
  website: '',
  twitter: '',
  telegram: '',
  buyEth: '0.01',
  maxTotalEth: '0.05',
  maxGasEth: '0.01',
  minTokensOut: '1',
  creatorTaxBps: 0,
};

it('builds an intent the server validator accepts', () => {
  const intent = ponsIntent(draft, wallet.toLowerCase(), randomSalt());
  expect(() => validateIntent(intent)).not.toThrow();
  expect(intent.quoteInWei).toBe('10000000000000000');
  expect(intent.recipient).toBe(wallet);
});

it('rejects zero amounts and fractional token minimums', () => {
  expect(() =>
    ponsIntent({ ...draft, buyEth: '0' }, wallet, randomSalt()),
  ).toThrow();
  expect(() =>
    ponsIntent({ ...draft, minTokensOut: '1.5' }, wallet, randomSalt()),
  ).toThrow();
});

it('maps the envelope exactly and refuses another wallet or chain', () => {
  const tx = {
    chainId: 4663,
    from: wallet,
    to: '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948',
    value: '10',
    data: '0xabcd',
    gas: '21000',
    gasPrice: '1000',
    nonce: 7,
  };
  expect(walletTransaction(tx, wallet.toLowerCase())).toMatchObject({
    value: '0xa',
    gas: '0x5208',
    gasPrice: '0x3e8',
    nonce: '0x7',
    data: '0xabcd',
  });
  expect(() =>
    walletTransaction(tx, '0x0000000000000000000000000000000000000001'),
  ).toThrow();
  expect(() => walletTransaction({ ...tx, chainId: 1 }, wallet)).toThrow();
});
