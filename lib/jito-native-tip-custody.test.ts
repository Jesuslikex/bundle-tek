import { expect, it } from 'vitest';
import { inspectJitoNativeTipCustody } from './jito-native-tip-custody';
function fixture() {
  const rent = Buffer.alloc(17);
  rent.writeBigUInt64LE(5080n);
  rent.writeDoubleLE(1, 8);
  rent[16] = 50;
  const before = [
    {
      owner: '11111111111111111111111111111111',
      lamports: '8000000',
      executable: false,
      data: ['', 'base64'],
    },
    {
      owner: 'T1pyyaTNZsKv2WcRAB8oVnk93mLJw2XzjtVYqCsaHqt',
      lamports: '1000000',
      executable: false,
      space: '8',
      data: ['ySH0dOBEYSg=', 'base64'],
    },
    null,
    {
      owner: 'Sysvar1111111111111111111111111111111111111',
      lamports: '1',
      executable: false,
      data: [rent.toString('base64'), 'base64'],
    },
  ];
  return {
    tip: '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    before,
    after: structuredClone(before),
  };
}
it.each(['690880', '2000000'])(
  'retains external tip change %s with exact payer and valid tip identity/rent',
  async (amount) => {
    const f = fixture();
    f.after[1]!.lamports = amount;
    expect(await inspectJitoNativeTipCustody(f)).toMatchObject({
      payerUnchanged: true,
      tipIdentityRentUnchanged: true,
      externalTipBalanceDelta: (BigInt(amount) - 1000000n).toString(),
      signingAllowed: false,
    });
  },
);
it.each(['payer', 'rent', 'owner', 'layout', 'under-rent', 'address'])(
  'refuses %s drift',
  async (kind) => {
    const f = fixture();
    if (kind === 'payer') f.after[0]!.lamports = '7999999';
    if (kind === 'rent') f.after[3]!.lamports = '2';
    if (kind === 'owner')
      f.after[1]!.owner = '11111111111111111111111111111111';
    if (kind === 'layout') f.after[1]!.data[0] = 'AAAAAAAAAAA=';
    if (kind === 'under-rent') f.after[1]!.lamports = '690879';
    if (kind === 'address') f.tip = '11111111111111111111111111111111';
    await expect(inspectJitoNativeTipCustody(f)).rejects.toThrow();
  },
);
