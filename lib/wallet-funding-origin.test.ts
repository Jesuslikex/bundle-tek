import { expect, it } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { address } from '@solana/kit';
import { fundingOriginFixture as fixture } from '../test/wallet-funding-origin-fixture';
import { decodeWalletFundingOrigin } from './wallet-funding-origin';
const SYSTEM = '11111111111111111111111111111111';
const now = 1800000000000;
it.each([
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [true, true, true],
])(
  'authenticates native batch=%s multiple signers=%s compute=%s and conserves the entire receipt',
  (batch, signers, compute) => {
    const f = fixture(batch, signers, compute);
    const result = decodeWalletFundingOrigin(
      f.wallet,
      f.history,
      f.receipt,
      now,
    );
    expect(result.reason).toBeNull();
    expect(result.funding).toMatchObject({
      signature: f.history.data[0].signature,
      slot: 100,
      transactionIndex: 0,
      blockTime: 1700000000,
      recipientChangeRaw: signers ? '30000' : '10000',
      funders: signers ? [f.from, f.from2].sort() : [f.from],
    });
    expect(result).toMatchObject({
      scope: 'oldest-provider-reported-transaction',
      historyComplete: false,
      signingAllowed: false,
      executionAllowed: false,
    });
  },
);
it.each([
  'slot',
  'blockTime',
  'signature',
  'confirmationStatus',
  'err',
  'transactionIndex',
])('refuses missing or mismatched history %s', (key) => {
  const f = fixture();
  const row = f.history.data[0] as Record<string, unknown>;
  row[key] =
    key === 'err'
      ? { InstructionError: [0, 'failed'] }
      : key === 'signature'
        ? bs58.encode(new Uint8Array(64))
        : key === 'confirmationStatus'
          ? 'confirmed'
          : key === 'transactionIndex'
            ? '-1'
            : '101';
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).funding,
  ).toBeNull();
});
it('does not use a later history record when the first is unsupported', () => {
  const f = fixture();
  f.history.data.push({ ...f.history.data[0] });
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).reason,
  ).toBe('unavailable-oldest-evidence');
});
it.each([
  'fee',
  'preBalances',
  'postBalances',
  'meta',
  'timestamp',
  'version',
  'inner',
  'packet',
  'signature',
])('refuses altered receipt %s', (kind) => {
  const f = fixture(true, true, true);
  if (kind === 'fee') f.receipt.meta.fee = '10001';
  if (kind === 'preBalances') f.receipt.meta.preBalances[0] = '1000000001';
  if (kind === 'postBalances') f.receipt.meta.postBalances[3] = '30001';
  if (kind === 'meta') f.receipt.meta.err = { failure: true };
  if (kind === 'timestamp') {
    f.receipt.blockTime = '1800000001';
    f.history.data[0].blockTime = '1800000001';
  }
  if (kind === 'version') f.receipt.version = '0';
  if (kind === 'inner')
    f.receipt.meta.innerInstructions = [{ index: 0, instructions: [] }];
  if (kind === 'packet') f.receipt.transaction[0] += 'AA==';
  if (kind === 'signature') {
    const bytes = Uint8Array.from(atob(f.receipt.transaction[0]), (c) =>
      c.charCodeAt(0),
    );
    bytes[70] ^= 1;
    f.receipt.transaction[0] = btoa(String.fromCharCode(...bytes));
  }
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).funding,
  ).toBeNull();
});
it('refuses a funded-again wallet even when the incoming transfer itself is valid', () => {
  const f = fixture();
  f.receipt.meta.preBalances[1] = '1';
  f.receipt.meta.postBalances[1] = '10001';
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).reason,
  ).toBe('not-zero-to-positive-funding');
});
it('does not admit unknown native instruction bytes by program ID alone', () => {
  const f = fixture();
  new DataView(f.message.instructions[0].data.buffer).setUint32(0, 3, true);
  f.resign();
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).reason,
  ).toBe('unsupported-native-transaction');
});
it('refuses readonly recipients and duplicate Compute Budget setters', () => {
  for (const duplicate of [false, true]) {
    const f = fixture(false, false, true);
    if (duplicate) f.message.instructions.unshift(f.message.instructions[0]);
    else f.message.header.numReadonlyNonSignerAccounts++;
    f.resign();
    expect(
      decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).funding,
    ).toBeNull();
  }
});
it('preserves exact integers above Number precision and refuses rounded numeric evidence', () => {
  const f = fixture();
  f.receipt.meta.preBalances[0] = '10000000000000000';
  f.receipt.meta.postBalances[0] = '9999999999985000';
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).funding,
  ).not.toBeNull();
  (f.receipt.meta.preBalances as unknown[])[0] = 10000000000000000;
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).funding,
  ).toBeNull();
});
it('reports absent oldest evidence without inventing a funding time', () => {
  const f = fixture();
  expect(
    decodeWalletFundingOrigin(f.wallet, { data: [] }, null, now).reason,
  ).toBe('no-returned-history');
  expect(decodeWalletFundingOrigin(f.wallet, f.history, null, now).reason).toBe(
    'unavailable-oldest-evidence',
  );
});

it('supports a static-only v0 message but refuses any address-table dependency', () => {
  const f = fixture();
  Object.assign(f.message, { version: 0, addressTableLookups: [] });
  f.receipt.version = '0';
  f.resign();
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).funding,
  ).not.toBeNull();
  Object.assign(f.message, {
    addressTableLookups: [
      {
        lookupTableAddress: address(bs58.encode(new Uint8Array(32).fill(5))),
        writableIndexes: [0],
        readonlyIndexes: [],
      },
    ],
  });
  f.resign();
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).reason,
  ).toBe('unsupported-native-transaction');
});
it('fully decodes Compute Budget unit-price bytes without treating the program ID as sufficient', () => {
  const f = fixture(false, false, true);
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, 1000n, true);
  f.receipt.meta.fee = '5800';
  f.receipt.meta.postBalances[0] = '999984200';
  f.message.instructions.unshift({
    programAddressIndex: 3,
    accountIndices: [],
    data,
  });
  f.resign();
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).funding,
  ).not.toBeNull();
  f.message.instructions[0].data = new Uint8Array([3, 1]);
  f.resign();
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).reason,
  ).toBe('unsupported-native-transaction');
});

it('admits explicit null recording only after proving a complete legacy native-transfer-only packet', () => {
  const f = fixture();
  (f.receipt.meta as Record<string, unknown>).innerInstructions = null;
  Object.assign(f.receipt.meta, {
    loadedAddresses: { writable: [], readonly: [] },
    logMessages: [`Program ${SYSTEM} invoke [1]`, `Program ${SYSTEM} success`],
  });
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).funding,
  ).not.toBeNull();
  (f.receipt.meta as Record<string, unknown>).innerInstructions = undefined;
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).reason,
  ).toBe('unsupported-native-transaction');
  delete (f.receipt.meta as Record<string, unknown>).innerInstructions;
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).reason,
  ).toBe('unsupported-native-transaction');
});
it('does not inherit null-recording admission for v0, compute or unsupported native programs', () => {
  for (const kind of ['v0', 'compute', 'unknown', 'cpi-log']) {
    const f = fixture(false, false, kind === 'compute');
    (f.receipt.meta as Record<string, unknown>).innerInstructions = null;
    if (kind === 'v0') {
      Object.assign(f.message, { version: 0, addressTableLookups: [] });
      f.receipt.version = '0';
    }
    if (kind === 'unknown')
      new DataView(f.message.instructions[0].data.buffer).setUint32(0, 3, true);
    if (kind === 'cpi-log')
      Object.assign(f.receipt.meta, {
        logMessages: [`Program ${SYSTEM} invoke [2]`],
      });
    f.resign();
    expect(
      decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).funding,
    ).toBeNull();
  }
});
it.each([
  'innerInstructions',
  'preTokenBalances',
  'postTokenBalances',
  'rewards',
  'loadedAddresses',
])('refuses nonempty or malformed metadata %s', (key) => {
  const f = fixture();
  (f.receipt.meta as Record<string, unknown>)[key] =
    key === 'loadedAddresses' ? { writable: [f.wallet], readonly: [] } : [{}];
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).funding,
  ).toBeNull();
});
it('keeps null timestamps and invalid wallet/time context explicit', () => {
  const f = fixture();
  (f.history.data[0] as Record<string, unknown>).blockTime = null;
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).reason,
  ).toBe('unavailable-oldest-evidence');
  expect(() =>
    decodeWalletFundingOrigin('invalid', f.history, f.receipt, now),
  ).toThrow('Funding origin context is invalid');
  expect(() =>
    decodeWalletFundingOrigin(
      f.wallet,
      f.history,
      f.receipt,
      Number.MAX_SAFE_INTEGER,
    ),
  ).toThrow('Funding origin context is invalid');
});

it.each([
  'zero-signature',
  'flipped-signature',
  'noncanonical-count',
  'trailing-bytes',
])('refuses malformed authenticated packet %s', (kind) => {
  const f = fixture();
  let bytes = Uint8Array.from(atob(f.receipt.transaction[0]), (c) =>
    c.charCodeAt(0),
  );
  if (kind === 'zero-signature') bytes.fill(0, 1, 65);
  if (kind === 'flipped-signature') bytes[1] ^= 1;
  if (kind === 'noncanonical-count')
    bytes = Uint8Array.from([129, 0, ...bytes.slice(1)]);
  if (kind === 'trailing-bytes') bytes = Uint8Array.from([...bytes, 0]);
  f.receipt.transaction[0] = btoa(String.fromCharCode(...bytes));
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).funding,
  ).toBeNull();
});
it.each([
  'zero',
  'self',
  'extra-account',
  'non-signer-source',
  'unknown-program',
])('refuses unsupported transfer role or shape %s', (kind) => {
  const f = fixture();
  if (kind === 'zero')
    new DataView(f.message.instructions[0].data.buffer).setBigUint64(
      4,
      0n,
      true,
    );
  if (kind === 'self') f.message.instructions[0].accountIndices = [0, 0];
  if (kind === 'extra-account')
    f.message.instructions[0].accountIndices.push(2);
  if (kind === 'non-signer-source')
    f.message.instructions[0].accountIndices = [1, 0];
  if (kind === 'unknown-program')
    f.message.staticAccounts[2] = address(
      bs58.encode(
        nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey,
      ),
    );
  f.resign();
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).funding,
  ).toBeNull();
});

it('refuses a readonly signer debit and a writable program role', () => {
  const readonly = fixture(false, true, false);
  readonly.message.header.numReadonlySignerAccounts = 1;
  readonly.resign();
  expect(
    decodeWalletFundingOrigin(
      readonly.wallet,
      readonly.history,
      readonly.receipt,
      now,
    ).funding,
  ).toBeNull();
  const writable = fixture();
  writable.message.header.numReadonlyNonSignerAccounts = 0;
  writable.resign();
  expect(
    decodeWalletFundingOrigin(
      writable.wallet,
      writable.history,
      writable.receipt,
      now,
    ).funding,
  ).toBeNull();
});

it('labels absent-wallet association as unavailable rather than a claim of no funding', () => {
  const f = fixture();
  const absent = bs58.encode(
    nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(8)).publicKey,
  );
  expect(
    decodeWalletFundingOrigin(absent, f.history, f.receipt, now).reason,
  ).toBe('unavailable-oldest-evidence');
});
it('labels a co-signing zero-to-positive recipient as unsupported, not unfunded', () => {
  const f = fixture(false, true, false);
  f.message.instructions.splice(1);
  f.message.instructions[0].accountIndices = [0, 1];
  f.receipt.meta.preBalances[1] = '0';
  f.receipt.meta.postBalances = ['999980000', '10000', '0', '1'];
  f.resign();
  expect(
    decodeWalletFundingOrigin(f.from2, f.history, f.receipt, now).reason,
  ).toBe('unsupported-native-transaction');
});
it('reconciles provider balances before deciding a funded-again reason', () => {
  const f = fixture();
  f.receipt.meta.preBalances[1] = '1';
  expect(
    decodeWalletFundingOrigin(f.wallet, f.history, f.receipt, now).reason,
  ).toBe('unavailable-oldest-evidence');
});
