export const WARMUP_SESSION_REVIEW_FORMAT = 'wallet-warmup-session-review-v1';
export const WARMUP_SESSION_SOURCE_FORMAT = 'wallet-warmup-session-source-v1';
export const WARMUP_SESSION_DOCUMENT_BYTES = 1048576;
export const WARMUP_SESSION_SOURCE_BYTES = 1048576;
export const WARMUP_SESSION_ROW_BYTES = 1572864;
/** A digest is a content binding, never a signing or submission capability. */
export async function walletWarmupSessionDigest(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
    ),
    (byte) => byte.toString(16).padStart(2, '0'),
  ).join('');
}
