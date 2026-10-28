/** A context marker only. The server's verified session remains the authority. */
export const JITO_OWNER_SCOPE_HEADER = 'x-jito-owner-scope';

export async function jitoOwnerScope(ownerId: string): Promise<string> {
  if (typeof ownerId !== 'string' || ownerId.length < 1 || ownerId.length > 128)
    throw new Error('Jito account scope unavailable.');
  for (let i = 0; i < ownerId.length; i++) {
    const code = ownerId.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = ownerId.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new Error('Jito account scope unavailable.');
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error('Jito account scope unavailable.');
    }
  }
  const encoded = new TextEncoder().encode(
    JSON.stringify(['jito-bundle-owner-scope-v1', ownerId]),
  );
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
