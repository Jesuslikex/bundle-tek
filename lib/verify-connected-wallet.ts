import bs58 from 'bs58';

export async function verifyConnectedWallet(
  address: string,
  sign: (message: Uint8Array) => Promise<Uint8Array>,
  assertCurrent: () => void,
) {
  const challengeResponse = await fetch('/api/wallet/challenge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const challenge = (await challengeResponse.json()) as {
    id?: string;
    message?: string;
    error?: string;
    expiresAt?: string;
  };
  if (
    !challengeResponse.ok ||
    !challenge.id ||
    !challenge.message ||
    !challenge.message.startsWith('PulseForge wallet ownership\n') ||
    !challenge.message.includes(`\nAddress: ${address}\n`)
  )
    throw new Error(challenge.error || 'Ownership challenge unavailable.');
  assertCurrent();
  const signature = await sign(new TextEncoder().encode(challenge.message));
  assertCurrent();
  const response = await fetch('/api/wallet/verify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: challenge.id,
      address,
      signature: bs58.encode(signature),
    }),
  });
  const result = (await response.json()) as {
    verified?: boolean;
    error?: string;
    verifiedAt?: string;
  };
  if (!response.ok || !result.verified)
    throw new Error(result.error || 'Ownership verification failed.');
  assertCurrent();
  const expiresAt = Date.parse(result.verifiedAt ?? '') + 5 * 60_000;
  if (
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 5 * 60_000 + 60_000
  )
    throw new Error('Ownership verification time is invalid.');
  return expiresAt;
}
