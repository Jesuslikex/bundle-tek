import schema from '../lib/pump-native-route-schema.json';
import { directMovementFixture } from './direct-movement-fixture';
import { supplyWallet as address } from './supply-history-fixture';
export function nativePumpFixture(name = 'buy') {
  const tx = directMovementFixture(0, 0),
    variant = schema.instructions.find((i) => i.name === name)!;
  const accounts = variant.accounts.map((_, i) => address(40 + i));
  const set = (role: string, value: string) => {
    accounts[variant.accounts.indexOf(role)] = value;
  };
  const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    system = '11111111111111111111111111111111',
    mint = address(2),
    curve = address(3),
    fee = address(4),
    creator = address(5),
    userToken = address(6),
    curveToken = address(7);
  for (const [role, value] of Object.entries({
    user: tx.address,
    mint,
    bonding_curve: curve,
    fee_recipient: fee,
    creator_vault: creator,
    associated_user: userToken,
    associated_bonding_curve: curveToken,
    token_program: token,
    system_program: system,
    program: schema.program,
    fee_program: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',
  }))
    set(role, value);
  const sell = name === 'sell',
    bytes = new Uint8Array(sell ? 24 : 26);
  bytes.set(variant.discriminator.match(/../g)!.map((h) => parseInt(h, 16)));
  const view = new DataView(bytes.buffer);
  view.setBigUint64(8, name === 'buy_exact_sol_in' ? 110n : 1000n, true);
  view.setBigUint64(16, sell ? 100n : name === 'buy' ? 110n : 1000n, true);
  tx.tokenChanges = [
    {
      mint,
      program: token,
      decimals: 6,
      beforeRaw: sell ? '1000' : '0',
      afterRaw: sell ? '0' : '1000',
      changeRaw: sell ? '-1000' : '1000',
      accounts: [userToken],
    },
  ];
  tx.feeRaw = '5';
  tx.feePayer = tx.address;
  tx.nativeChangeRaw = sell ? '95' : '-115';
  tx.nativeAccountChanges = [
    {
      address: tx.address,
      beforeRaw: '1000',
      afterRaw: sell ? '1095' : '885',
      changeRaw: tx.nativeChangeRaw,
    },
    {
      address: curve,
      beforeRaw: '1000',
      afterRaw: sell ? '890' : '1100',
      changeRaw: sell ? '-110' : '100',
    },
    { address: fee, beforeRaw: '0', afterRaw: '5', changeRaw: '5' },
    { address: creator, beforeRaw: '0', afterRaw: '5', changeRaw: '5' },
  ];
  tx.movementInstructions = [
    {
      program: schema.program,
      topLevel: true,
      accounts,
      dataHex: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
        '',
      ),
    },
    {
      program: token,
      topLevel: false,
      type: 'transfer',
      info: {
        source: sell ? userToken : curveToken,
        destination: sell ? curveToken : userToken,
        amount: '1000',
      },
    },
  ];
  if (!sell)
    for (const [destination, lamports] of [
      [curve, '100'],
      [fee, '5'],
      [creator, '5'],
    ])
      tx.movementInstructions.push({
        program: system,
        topLevel: false,
        type: 'transfer',
        info: { source: tx.address, destination, lamports },
      });
  tx.programs = [...new Set(tx.movementInstructions.map((i) => i.program))];
  return tx;
}
