import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { PUMP_GROUP_JITO_TIP_ACCOUNTS } from './pump-group-broadcast';
import {
  inspectJitoTipReceiver,
  JITO_TIP_PAYMENT_OWNER,
} from './jito-tip-account-evidence';

function fixture(oldRent = false) {
  const b = Buffer.alloc(17);
  b.writeBigUInt64LE(oldRent ? 3480n : 5080n);
  b.writeDoubleLE(oldRent ? 2 : 1, 8);
  b[16] = 50;
  return {
    address: PUMP_GROUP_JITO_TIP_ACCOUNTS[0] as string,
    account: {
      owner: JITO_TIP_PAYMENT_OWNER,
      executable: false,
      lamports: oldRent ? '946560' : '690880',
      space: '8',
      data: ['ySH0dOBEYSg=', 'base64'],
    },
    rentAccount: {
      owner: 'Sysvar1111111111111111111111111111111111111',
      executable: false,
      lamports: '1',
      data: [b.toString('base64'), 'base64'],
    },
  };
}

it('accepts all eight reviewed destinations only after checking their singleton PDAs', async () => {
  const evidence = await Promise.all(
    PUMP_GROUP_JITO_TIP_ACCOUNTS.map((address) =>
      inspectJitoTipReceiver({ ...fixture(), address }),
    ),
  );
  expect(evidence.map((e) => e.seedIndex).sort((a, b) => a - b)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 7,
  ]);
  for (const e of evidence)
    expect(e).toMatchObject({
      accountBytes: 8,
      requiredRentLamports: '690880',
      pdaAndLayoutChecked: true,
      sourceAuthenticated: false,
      bankVerified: false,
      programApproved: false,
      signingAllowed: false,
      executionAllowed: false,
    });
  expect(
    Buffer.from(
      createHash('sha256')
        .update('account:TipPaymentAccount')
        .digest()
        .subarray(0, 8),
    ).toString('base64'),
  ).toBe('ySH0dOBEYSg=');
});

it.each([false, true])(
  'uses the actual eight-byte Rent minimum, old profile=%s',
  async (old) => {
    const f = fixture(old);
    expect((await inspectJitoTipReceiver(f)).requiredRentLamports).toBe(
      f.account.lamports,
    );
    f.account.lamports = (BigInt(f.account.lamports) - 1n).toString();
    await expect(inspectJitoTipReceiver(f)).rejects.toThrow();
  },
);

it.each([
  'system',
  'program',
  'data',
  'trailing',
  'executable',
  'space',
  'overflow',
  'numeric',
  'destination',
  'rent',
])('refuses %s account substitution', async (kind) => {
  const f = fixture();
  if (kind === 'system') {
    f.account.owner = '11111111111111111111111111111111';
    f.account.data[0] = '';
  }
  if (kind === 'program')
    f.account.owner = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  if (kind === 'data') f.account.data[0] = Buffer.alloc(8).toString('base64');
  if (kind === 'trailing')
    f.account.data[0] = Buffer.concat([
      Buffer.from('ySH0dOBEYSg=', 'base64'),
      Buffer.alloc(1),
    ]).toString('base64');
  if (kind === 'executable') f.account.executable = true;
  if (kind === 'space') f.account.space = '0';
  if (kind === 'overflow') f.account.lamports = (1n << 64n).toString();
  if (kind === 'numeric') Object.assign(f.account, { lamports: 690880 });
  if (kind === 'destination') f.address = '11111111111111111111111111111111';
  if (kind === 'rent') f.rentAccount.owner = JITO_TIP_PAYMENT_OWNER;
  await expect(inspectJitoTipReceiver(f)).rejects.toThrow();
});

it('snapshots supplied account and rent data before asynchronous PDA checks', async () => {
  const f = fixture();
  const pending = inspectJitoTipReceiver(f);
  f.account.owner = 'changed';
  f.account.lamports = '0';
  f.rentAccount.data[0] = '';
  expect(await pending).toMatchObject({
    owner: JITO_TIP_PAYMENT_OWNER,
    lamports: '690880',
  });
});
