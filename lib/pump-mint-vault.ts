import {
  createVault,
  generateVaultWallets,
  encryptVault,
  unlockVault,
  parseVaultEnvelope,
  type VaultSession,
} from './browser-wallet-vault';
export type PumpMintBackup = {
  format: 'bundle-pump-mint-v1';
  projectId: string;
  mint: string;
  encrypted: string;
};
export const pumpMintStorageKey = (projectId: string) =>
  'bundle.pump-mint.v1:' + projectId;
export function parsePumpMintBackup(
  value: string,
  projectId: string,
): PumpMintBackup {
  if (value.length > 400000) throw new Error('Mint backup is too large.');
  const v = JSON.parse(value) as PumpMintBackup;
  if (
    v.format !== 'bundle-pump-mint-v1' ||
    v.projectId !== projectId ||
    typeof v.mint !== 'string' ||
    typeof v.encrypted !== 'string'
  )
    throw new Error('Choose this project’s encrypted mint backup.');
  parseVaultEnvelope(v.encrypted);
  return v;
}
export async function createPumpMint(
  projectId: string,
  password: string,
): Promise<PumpMintBackup> {
  const session = generateVaultWallets(
    await createVault(password),
    'solana',
    1,
  );
  try {
    return {
      format: 'bundle-pump-mint-v1',
      projectId,
      mint: session.payload.wallets[0].address,
      encrypted: await encryptVault(session),
    };
  } finally {
    clearMintSession(session);
  }
}
export async function unlockPumpMint(backup: PumpMintBackup, password: string) {
  const session = await unlockVault(backup.encrypted, password);
  if (
    session.payload.wallets.length !== 1 ||
    session.payload.wallets[0].address !== backup.mint ||
    session.payload.wallets[0].family !== 'solana'
  ) {
    clearMintSession(session);
    throw new Error('Mint backup identity differs.');
  }
  return session;
}
export function clearMintSession(session: VaultSession) {
  for (const wallet of session.payload.wallets) wallet.seed = '';
}
export async function persistPumpMint(
  backup: PumpMintBackup,
  current: () => boolean,
) {
  const key = pumpMintStorageKey(backup.projectId);
  if (!navigator.locks)
    throw new Error('This browser does not support safe key storage.');
  await navigator.locks.request(key, () => {
    if (!current()) throw new Error('Project changed.');
    const existing = localStorage.getItem(key);
    if (existing && existing !== JSON.stringify(backup))
      throw new Error(
        'This project already has a mint key. Restore its existing backup.',
      );
    localStorage.setItem(key, JSON.stringify(backup));
  });
}
