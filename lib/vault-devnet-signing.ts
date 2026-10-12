import { chainQuoteAssets } from './quote-catalog';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import {
  address,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  getCompiledTransactionMessageDecoder,
  type Transaction,
  type SignatureBytes,
} from '@solana/kit';
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import type { VaultSession } from './browser-wallet-vault';
import {
  operationDocument,
  UUID,
  type WalletOperation,
} from './wallet-operation';
import { createWalletChallenge } from './wallet-verification';
import { toBaseUnits } from './distribution-plan';

const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const COMPUTE = 'ComputeBudget111111111111111111111111111111';
const ATA = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export type VaultDevnetReview = {
  kind: 'memo' | 'spl' | 'sol';
  wallet: string;
  operationId: string;
  amount: string | null;
  mint: string | null;
  recipient: string | null;
  createsAccount: boolean;
  maximumNetworkFeeLamports: string;
};
export async function inspectVaultDevnetTransaction(
  tx: Transaction,
  operation: WalletOperation,
  wallet: string,
): Promise<VaultDevnetReview> {
  assertIsTransactionWithBlockhashLifetime(tx);
  assertIsTransactionWithinSizeLimit(tx);
  if (
    !UUID.test(operation.id) ||
    operation.walletAddress !== wallet ||
    operation.state !== 'awaiting_signature' ||
    operation.signature ||
    !operation.armedAt ||
    !Number.isSafeInteger(operation.minimumSlot) ||
    operation.minimumSlot === null ||
    operation.minimumSlot < 0
  )
    throw new Error('No unsigned pending operation matches this wallet.');
  const intent = await operationDocument(JSON.parse(operation.document));
  if (intent.wallet !== wallet) throw new Error('Operation wallet mismatch.');
  const message = getCompiledTransactionMessageDecoder().decode(
    tx.messageBytes,
  );
  if (
    message.version === 1 ||
    (message.version === 0 && message.addressTableLookups?.length) ||
    message.header.numSignerAccounts !== 1 ||
    message.header.numReadonlySignerAccounts !== 0 ||
    message.staticAccounts[0] !== wallet ||
    message.lifetimeToken !== tx.lifetimeConstraint.blockhash ||
    message.instructions.length > 8
  )
    throw new Error('Unsupported vault transaction message.');
  const account = (index: number) => {
    const value = message.staticAccounts[index];
    if (!value) throw new Error('Unresolved transaction account.');
    return value;
  };
  const core: typeof message.instructions = [];
  let units = 200000n,
    price = 0n;
  const limits = new Set<number>();
  for (const instruction of message.instructions) {
    if (account(instruction.programAddressIndex) !== COMPUTE) {
      core.push(instruction);
      continue;
    }
    const bytes = new Uint8Array(instruction.data || []),
      view = new DataView(bytes.buffer);
    if (instruction.accountIndices?.length || limits.has(bytes[0]))
      throw new Error('Unexpected compute budget.');
    limits.add(bytes[0]);
    if (bytes[0] === 2 && bytes.length === 5)
      units = BigInt(view.getUint32(1, true));
    else if (bytes[0] === 3 && bytes.length === 9)
      price = view.getBigUint64(1, true);
    else throw new Error('Unsupported compute budget.');
    if (units < 1n || units > 1400000n || price > 1000000n)
      throw new Error('Compute fee exceeds the vault review limit.');
  }
  let amount: string | null = null,
    mint: string | null = null,
    recipient: string | null = null,
    createsAccount = false;
  if (intent.kind === 'memo') {
    if (
      core.length !== 1 ||
      account(core[0].programAddressIndex) !== MEMO ||
      core[0].accountIndices?.some((index) => account(index) !== wallet) ||
      !new TextDecoder('utf-8', { fatal: true })
        .decode(new Uint8Array(core[0].data || []))
        .startsWith('PulseForge verified devnet wallet ')
    )
      throw new Error('Only the reviewed devnet memo can be signed.');
  } else if (intent.kind === 'sol') {
    amount = intent.amount;
    recipient = intent.recipient;
    const transfer = core[0],
      bytes = new Uint8Array(transfer?.data || []);
    if (
      core.length !== 1 ||
      account(transfer.programAddressIndex) !==
        '11111111111111111111111111111111' ||
      (transfer.accountIndices || []).map(account).join(',') !==
        [wallet, recipient].join(',') ||
      bytes.length !== 12 ||
      new DataView(bytes.buffer).getUint32(0, true) !== 2 ||
      new DataView(bytes.buffer).getBigUint64(4, true) !==
        toBaseUnits(amount, 9)
    )
      throw new Error(
        'Native SOL transfer differs from the pending funding operation.',
      );
  } else {
    const row = intent.distribution.recipients.find(
      (row) => row.address === intent.recipient,
    )!;
    amount = row.amount;
    mint = intent.distribution.mint;
    recipient = intent.recipient;
    const [source] = await findAssociatedTokenPda({
      owner: address(wallet),
      mint: address(mint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const [destination] = await findAssociatedTokenPda({
      owner: address(recipient),
      mint: address(mint),
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const transfers = core.filter(
      (ix) => account(ix.programAddressIndex) === TOKEN_PROGRAM_ADDRESS,
    );
    if (transfers.length !== 1 || core.length > 2)
      throw new Error('Expected one reviewed standard SPL transfer.');
    const transfer = transfers[0],
      bytes = new Uint8Array(transfer.data || []),
      accounts = (transfer.accountIndices || []).map(account);
    if (
      bytes.length !== 10 ||
      bytes[0] !== 12 ||
      (intent.funding &&
        bytes[9] !==
          chainQuoteAssets('Solana').find((asset) => asset.address === mint)
            ?.decimals) ||
      accounts.join(',') !== [source, mint, destination, wallet].join(',') ||
      new DataView(bytes.buffer).getBigUint64(1, true) !==
        toBaseUnits(amount, bytes[9])
    )
      throw new Error('Token transfer differs from the pending operation.');
    for (const ix of core) {
      if (ix === transfer) continue;
      if (
        account(ix.programAddressIndex) !== ATA ||
        ix.data?.length !== 1 ||
        ix.data[0] !== 1 ||
        (ix.accountIndices || []).map(account).join(',') !==
          [
            wallet,
            destination,
            recipient,
            mint,
            '11111111111111111111111111111111',
            TOKEN_PROGRAM_ADDRESS,
          ].join(',') ||
        core.indexOf(ix) > core.indexOf(transfer)
      )
        throw new Error('Unsupported instruction in vault transfer.');
      createsAccount = true;
    }
  }
  if (!limits.has(2)) units = BigInt(core.length) * 200000n;
  return {
    kind: intent.kind,
    wallet,
    operationId: operation.id,
    amount,
    mint,
    recipient,
    createsAccount,
    maximumNetworkFeeLamports: (
      5000n +
      (units * price + 999999n) / 1000000n
    ).toString(),
  };
}
export function inspectVaultDevnetOwnership(
  messageBytes: Uint8Array,
  wallet: string,
  origin: string,
  now = Date.now(),
) {
  if (messageBytes.length > 4096)
    throw new Error('Ownership message is too large.');
  const message = new TextDecoder('utf-8', { fatal: true }).decode(
      messageBytes,
    ),
    lines = message.split('\n');
  const id = lines[3]?.slice('Challenge: '.length),
    issuedAt = lines[4]?.slice('Issued: '.length),
    account = lines[7]?.slice('Account: '.length);
  if (
    !id ||
    !UUID.test(id) ||
    !issuedAt ||
    new Date(issuedAt).toISOString() !== issuedAt ||
    Date.parse(issuedAt) > now + 30000 ||
    Date.parse(issuedAt) <= now - 300000 ||
    !account ||
    account.length > 200 ||
    message !==
      createWalletChallenge(wallet, id, issuedAt) +
        `\nOrigin: ${origin}\nAccount: ${account}`
  )
    throw new Error(
      'Only a current ownership challenge for this origin and wallet can be signed.',
    );
  return { account, message };
}
function signVaultDevnetBytes(
  session: VaultSession,
  walletAddress: string,
  messageBytes: Uint8Array,
  assertCurrent: () => void,
): SignatureBytes {
  assertCurrent();
  const wallet = session.payload.wallets.find(
    (wallet) => wallet.family === 'solana' && wallet.address === walletAddress,
  );
  if (!wallet || !/^[a-f0-9]{64}$/.test(wallet.seed))
    throw new Error('This Solana key is not in the unlocked vault.');
  const seed = Uint8Array.from(wallet.seed.match(/../g)!, (part) =>
      parseInt(part, 16),
    ),
    pair = nacl.sign.keyPair.fromSeed(seed);
  try {
    if (bs58.encode(pair.publicKey) !== walletAddress)
      throw new Error('Vault key does not match the reviewed wallet.');
    assertCurrent();
    return nacl.sign.detached(messageBytes, pair.secretKey) as SignatureBytes;
  } finally {
    seed.fill(0);
    pair.secretKey.fill(0);
  }
}
export async function signVaultDevnetTransaction(
  session: VaultSession,
  wallet: string,
  tx: Transaction,
  operation: WalletOperation,
  assertCurrent: () => void,
) {
  assertCurrent();
  await inspectVaultDevnetTransaction(tx, operation, wallet);
  return signVaultDevnetBytes(
    session,
    wallet,
    new Uint8Array(tx.messageBytes),
    assertCurrent,
  );
}
export function signVaultDevnetOwnership(
  session: VaultSession,
  wallet: string,
  message: Uint8Array,
  origin: string,
  assertCurrent: () => void,
) {
  inspectVaultDevnetOwnership(message, wallet, origin);
  return signVaultDevnetBytes(session, wallet, message, assertCurrent);
}
