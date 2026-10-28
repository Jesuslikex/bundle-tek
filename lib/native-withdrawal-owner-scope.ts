/** Context marker only. The server's verified session remains the authority. */
export const WITHDRAWAL_OWNER_SCOPE_HEADER = 'x-withdrawal-owner-scope';

export async function withdrawalOwnerScope(ownerId: string): Promise<string> {
  if (typeof ownerId !== 'string' || ownerId.length < 1 || ownerId.length > 128)
    throw new Error('Withdrawal account scope unavailable.');
  for (let i = 0; i < ownerId.length; i++) {
    const code = ownerId.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = ownerId.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error('Withdrawal account scope unavailable.');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('Withdrawal account scope unavailable.');
    }
  }
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify(['native-withdrawal-owner-scope-v1', ownerId]),
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
