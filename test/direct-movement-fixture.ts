import schema from '../lib/movement-route-schema.json';
import { supplyWallet as address } from './supply-history-fixture';
import type { TrackedTransaction } from '../lib/tracked-wallet-transaction';
export function directMovementFixture(
  programIndex: number,
  variantIndex: number,
): TrackedTransaction {
  const program = schema.programs[programIndex],
    variant = program.variants[variantIndex];
  const accounts = Array.from({ length: variant.accountCount }, (_, i) =>
    address(20 + i),
  );
  const wallet = address(1),
    source = address(2),
    destination = address(3),
    inputMint = address(4),
    outputMint = address(5);
  accounts[variant.authority] = wallet;
  accounts[variant.source] = source;
  accounts[variant.destination] = destination;
  for (const index of variant.tokenPrograms)
    accounts[index] = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  if ('inputMint' in variant) accounts[variant.inputMint] = inputMint;
  if ('outputMint' in variant) accounts[variant.outputMint] = outputMint;
  const data = Uint8Array.from(
    variant.discriminator.match(/../g)!.map((h) => parseInt(h, 16)),
  );
  const bytes = new Uint8Array(variant.bytes);
  bytes.set(data);
  const view = new DataView(bytes.buffer),
    offset = data.length;
  const bound = (kind: string) =>
    kind === 'input-exact'
      ? 1000000n
      : kind === 'input-maximum'
        ? 1000100n
        : kind === 'output-exact'
          ? 1000n
          : 990n;
  view.setBigUint64(offset, bound(variant.first), true);
  view.setBigUint64(offset + 8, bound(variant.second), true);
  const token = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  return {
    address: wallet,
    network: 'mainnet',
    signature: 'fixture',
    slot: 100,
    blockTime: null,
    failed: false,
    feeRaw: '5000',
    feePayer: wallet,
    walletSigner: true,
    nativeChangeRaw: '-9999999',
    tokensComplete: true,
    programs: [program.program, token],
    innerInstructionsAvailable: true,
    observedAt: new Date().toISOString(),
    source: 'fixture',
    commitment: 'confirmed',
    tokenChanges: [
      {
        mint: inputMint,
        program: token,
        decimals: 9,
        beforeRaw: '1000000',
        afterRaw: '0',
        changeRaw: '-1000000',
        accounts: [source],
      },
      {
        mint: outputMint,
        program: token,
        decimals: 6,
        beforeRaw: '0',
        afterRaw: '1000',
        changeRaw: '1000',
        accounts: [destination],
      },
    ],
    movementInstructions: [
      {
        program: program.program,
        topLevel: true,
        accounts,
        dataHex: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
          '',
        ),
      },
      {
        program: token,
        topLevel: false,
        type: 'transferChecked',
        info: {
          source,
          destination: accounts[variant.outgoing[0]],
          mint: inputMint,
          amount: '1000000',
        },
      },
      {
        program: token,
        topLevel: false,
        type: 'transferChecked',
        info: {
          source: accounts[variant.incoming[0]],
          destination,
          mint: outputMint,
          amount: '1000',
        },
      },
    ],
  };
}
