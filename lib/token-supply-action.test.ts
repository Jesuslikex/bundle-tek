import { describe, expect, it } from 'vitest';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { getCompiledTransactionMessageDecoder } from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import {
  encodeBase64,
  decodeBase64,
  generateLockMetadataKey,
  unsignedSupplyPacket,
  inspectSupplyAction,
  sha256Hex,
  signSupplyAction,
  streamflowLockAccounts,
  streamflowLockName,
  supplyActionInput,
  supplyActionInstructions,
  supplyActionMessage,
  validatedSupplyAction,
  type TokenSupplyReview,
} from './token-supply-action';
import { TOKEN_2022 } from './token-withdrawal-fee';
import type { VaultSession } from './browser-wallet-vault';

// Captured from @streamflow/stream 13.4.0: createStreamInstruction (the SDK's
// default path) with buildLockParams({ recipient: sender, unlockDate: 1800000000,
// amount: 123456789000 }) for the fixed sender/mint/metadata below, Token-2022.
const SDK = {
  sender: 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx',
  mint: 'cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN',
  unlockAt: 1800000000,
  metadata: 'YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf',
  escrow: 'CHZYVMsQ2QMroX9zLEKEJ55Arfef4tv4XYfQu1cWinrc',
  treasuryTokens: '96MotiKcXLtDRp2yk8cYnhcf2NvfwqPxj6YAdV1B92Z8',
  data: '181ec828051c077700d2496b00000000081a99be1c0000000100000000000000010000000000000000d2496b00000000081a99be1c00000000000000000042756e646c65206c6f636b20634766486943364b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000100010000000000000000000000',
  keys: [
    'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx:s:w',
    'GkszU3JvM7uPsFGpazjSHDDAgbKdDeUdBNkZB94k3FCX:w',
    'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx:w',
    'YMN9Qj5jPNp7j14VPcML1B6xGgcPWVZUGLFU3Mnyfaf:s:w',
    'CHZYVMsQ2QMroX9zLEKEJ55Arfef4tv4XYfQu1cWinrc:w',
    'GkszU3JvM7uPsFGpazjSHDDAgbKdDeUdBNkZB94k3FCX:w',
    '5SEpbdjFK5FxwTvfsGMXVQTD2v4M2c5tyRTxhdsPkgDw:w',
    '96MotiKcXLtDRp2yk8cYnhcf2NvfwqPxj6YAdV1B92Z8:w',
    'wdrwhnCv4pzW8beKsbPa4S2UDZrXenjg16KJdKSpb5u:w',
    'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx:w',
    'GkszU3JvM7uPsFGpazjSHDDAgbKdDeUdBNkZB94k3FCX:w',
    'cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN',
    'B743wFVk2pCYhV91cn287e1xY7f1vt4gdY48hhNiuQmT',
    'SysvarRent111111111111111111111111111111111',
    'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m',
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    '11111111111111111111111111111111',
  ],
};
const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('Streamflow lock encoding', () => {
  it('matches the Streamflow SDK create lock instruction byte for byte', async () => {
    const accounts = await streamflowLockAccounts({
      mint: SDK.mint,
      program: TOKEN_2022,
      metadata: SDK.metadata,
    });
    expect(accounts).toEqual({
      escrow: SDK.escrow,
      treasuryTokens: SDK.treasuryTokens,
    });
    const { instructions } = await supplyActionInstructions({
      kind: 'lock',
      wallet: SDK.sender,
      mint: SDK.mint,
      program: TOKEN_2022,
      decimals: 6,
      amountRaw: '123456789000',
      lock: {
        unlockAt: SDK.unlockAt,
        durationSeconds: 86400,
        metadata: SDK.metadata,
        ...accounts,
        name: streamflowLockName(SDK.mint),
      },
    });
    const [ix] = instructions;
    expect(hex(ix.data as Uint8Array)).toBe(SDK.data);
    expect(
      ix.accounts!.map(
        (a) =>
          a.address +
          (a.role === 3
            ? ':s:w'
            : a.role === 1
              ? ':w'
              : a.role === 2
                ? ':s'
                : ''),
      ),
    ).toEqual(SDK.keys);
  });
});

const seed = new Uint8Array(32).fill(5);
const pair = nacl.sign.keyPair.fromSeed(seed);
const WALLET = bs58.encode(pair.publicKey);
const MINT = bs58.encode(new Uint8Array(32).fill(9));
const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(4));
const LOCK_KEY = generateLockMetadataKey();

async function review(
  kind: 'burn' | 'lock',
  overrides: Partial<TokenSupplyReview> = {},
): Promise<TokenSupplyReview> {
  const preparedAt = new Date(Date.now() - 1000);
  preparedAt.setMilliseconds(0);
  const lock =
    kind === 'lock'
      ? {
          unlockAt: Math.floor(preparedAt.getTime() / 1000) + 86400,
          durationSeconds: 86400,
          metadata: LOCK_KEY.address,
          ...(await streamflowLockAccounts({
            mint: MINT,
            program: TOKEN_PROGRAM_ADDRESS,
            metadata: LOCK_KEY.address,
          })),
          name: streamflowLockName(MINT),
        }
      : undefined;
  const base: TokenSupplyReview = {
    id: crypto.randomUUID(),
    network: 'mainnet',
    kind,
    wallet: WALLET,
    walletRevision: 1,
    mint: MINT,
    program: TOKEN_PROGRAM_ADDRESS,
    decimals: 6,
    supplyRaw: '1000000000000000',
    percentPpm: '10000',
    amountRaw: '10000000000000',
    amount: '10000000',
    sourceAccount: '',
    ...(lock ? { lock } : {}),
    blockhash: BLOCKHASH,
    lastValidBlockHeight: '1000',
    slot: 10,
    feeLamports: '5000',
    tokenDebitRaw: kind === 'lock' ? '10019000000000' : '10000000000000',
    solDebitLamports: '95000',
    reserveLamports: '890880',
    transaction: '',
    sha256: '',
    preparedAt: preparedAt.toISOString(),
    expiresAt: new Date(preparedAt.getTime() + 60_000).toISOString(),
    source: 'rpc.test',
    ...overrides,
  };
  const { source, signers, message } = await supplyActionMessage(base);
  base.sourceAccount = source;
  base.transaction = encodeBase64(unsignedSupplyPacket(signers, message));
  base.sha256 = await sha256Hex(decodeBase64(base.transaction));
  return base;
}
const session = {
  payload: {
    version: 1,
    wallets: [{ family: 'solana', address: WALLET, seed: hex(seed) }],
  },
} as unknown as VaultSession;

describe('supply action packets', () => {
  it('builds a one-signer BurnChecked packet from the reviewed wallet', async () => {
    const r = await review('burn');
    const { message } = await inspectSupplyAction(r, r.transaction, false);
    const compiled = getCompiledTransactionMessageDecoder().decode(
      message,
    ) as unknown as {
      header: { numSignerAccounts: number };
      staticAccounts: string[];
      instructions: { data?: Uint8Array }[];
    };
    expect(compiled.header.numSignerAccounts).toBe(1);
    expect(compiled.staticAccounts[0]).toBe(WALLET);
    expect(compiled.instructions).toHaveLength(1);
    // BurnChecked = 15, amount u64, decimals u8
    const data = compiled.instructions[0].data!;
    expect(data[0]).toBe(15);
    expect(
      new DataView(data.buffer, data.byteOffset).getBigUint64(1, true),
    ).toBe(10000000000000n);
    expect(data[9]).toBe(6);
  });
  it('signs only the exact reviewed packet and verifies the signature', async () => {
    for (const kind of ['burn', 'lock'] as const) {
      const r = await review(kind);
      const signed = await signSupplyAction(
        session,
        r,
        () => {},
        kind === 'lock' ? LOCK_KEY.secretKey : undefined,
      );
      const inspected = await inspectSupplyAction(r, signed.transaction, true);
      expect(inspected.signature).toBe(signed.signature);
    }
  });
  it('builds the lock with the browser metadata key as second signer', async () => {
    const r = await review('lock');
    const { message } = await inspectSupplyAction(r, r.transaction, false);
    const compiled = getCompiledTransactionMessageDecoder().decode(message);
    expect(compiled.header.numSignerAccounts).toBe(2);
    expect(compiled.staticAccounts.slice(0, 2)).toEqual([
      WALLET,
      LOCK_KEY.address,
    ]);
    await expect(signSupplyAction(session, r, () => {})).rejects.toThrow(
      /no longer in this tab/,
    );
    const other = generateLockMetadataKey();
    await expect(
      signSupplyAction(session, r, () => {}, other.secretKey),
    ).rejects.toThrow(/no longer in this tab/);
  });
  it('rejects tampered terms, packets and signatures', async () => {
    const r = await review('burn');
    await expect(
      inspectSupplyAction(
        { ...r, amountRaw: '20000000000000' },
        r.transaction,
        false,
      ),
    ).rejects.toThrow(/amount differs/);
    await expect(
      inspectSupplyAction({ ...r, tokenDebitRaw: '1' }, r.transaction, false),
    ).rejects.toThrow(/token debit/);
    const bytes = decodeBase64(r.transaction);
    bytes[bytes.length - 1] ^= 1;
    await expect(
      inspectSupplyAction(r, encodeBase64(bytes), false),
    ).rejects.toThrow();
    const forged = decodeBase64(r.transaction);
    forged.set(new Uint8Array(64).fill(1), 1);
    await expect(
      inspectSupplyAction(r, encodeBase64(forged), true),
    ).rejects.toThrow(/signature/);
    const lock = await review('lock');
    await expect(
      inspectSupplyAction(
        { ...lock, lock: { ...lock.lock!, unlockAt: lock.lock!.unlockAt - 1 } },
        lock.transaction,
        false,
      ),
    ).rejects.toThrow(/Lock terms/);
  });
  it('refuses to sign for a wallet outside the vault or after expiry', async () => {
    const r = await review('burn');
    await expect(
      signSupplyAction(
        { payload: { version: 1, wallets: [] } } as unknown as VaultSession,
        r,
        () => {},
      ),
    ).rejects.toThrow(/not in this vault/);
    const stale = await review('burn', {
      preparedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await expect(signSupplyAction(session, stale, () => {})).rejects.toThrow(
      /expired/,
    );
  });
  it('validates retained history rows and receipts', async () => {
    const r = await review('burn');
    const row = {
      id: r.id,
      wallet: r.wallet,
      walletRevision: 1,
      kind: 'burn' as const,
      mint: r.mint,
      state: 'finalized' as const,
      signature: bs58.encode(new Uint8Array(64).fill(2)),
      document: r,
      receipt: {
        network: 'mainnet' as const,
        commitment: 'finalized' as const,
        signature: bs58.encode(new Uint8Array(64).fill(2)),
        failed: false,
        error: null,
        slot: 20,
        blockTime: null,
        networkFeeLamports: '5000',
        walletLamportsChange: '-5000',
        tokenChangeRaw: '-10000000000000',
        supplyChangeRaw: '-10000000000000',
        observedAt: new Date().toISOString(),
      },
      createdAt: r.preparedAt,
      updatedAt: r.preparedAt,
    };
    await expect(validatedSupplyAction(row)).resolves.toBe(row);
    await expect(
      validatedSupplyAction({
        ...row,
        receipt: { ...row.receipt, tokenChangeRaw: '-1' },
      }),
    ).rejects.toThrow(/units differ/);
    await expect(
      validatedSupplyAction({ ...row, state: 'signing' }),
    ).rejects.toThrow();
  });
});

describe('supplyActionInput', () => {
  const ok = {
    kind: 'lock',
    wallet: WALLET,
    walletRevision: 2,
    mint: MINT,
    percent: '5',
    durationSeconds: 30 * 86400,
    lockMetadata: LOCK_KEY.address,
    acknowledgeIrreversible: true,
  };
  it('accepts a lock and a burn', () => {
    expect(supplyActionInput(ok)).toMatchObject({
      kind: 'lock',
      percentPpm: 50_000n,
      durationSeconds: 2592000,
    });
    expect(
      supplyActionInput({
        ...ok,
        kind: 'burn',
        durationSeconds: undefined,
        lockMetadata: undefined,
      }),
    ).toMatchObject({ kind: 'burn', durationSeconds: undefined });
  });
  it('requires the irreversible acknowledgement and sane terms', () => {
    expect(() =>
      supplyActionInput({ ...ok, acknowledgeIrreversible: false }),
    ).toThrow(/cannot be undone/);
    expect(() => supplyActionInput({ ...ok, durationSeconds: 60 })).toThrow(
      /duration/,
    );
    expect(() => supplyActionInput({ ...ok, kind: 'burn' })).toThrow(
      /no duration/,
    );
    expect(() => supplyActionInput({ ...ok, lockMetadata: WALLET })).toThrow(
      /fresh Streamflow/,
    );
    expect(() => supplyActionInput({ ...ok, mint: WALLET })).toThrow();
    expect(() => supplyActionInput({ ...ok, percent: '0' })).toThrow();
  });
});
