import {
  getExtensionDecoder,
  getExtensionEncoder,
  getTokenSize,
  type Extension,
} from '@solana-program/token-2022';
import { TOKEN_2022 } from './token-withdrawal-fee';
export function withdrawalExtensions(
  bytes: Uint8Array,
  program: string,
  mint: boolean,
): Extension[] {
  const base = mint ? 82 : 165;
  if (bytes.length === base) return [];
  if (
    program !== TOKEN_2022 ||
    bytes.length < 166 ||
    bytes.length > 16384 ||
    bytes[165] !== (mint ? 1 : 2) ||
    (mint && bytes.slice(82, 165).some((b) => b !== 0))
  )
    throw new Error('Token extension account layout differs.');
  const allowed = mint
    ? ['MetadataPointer', 'TokenMetadata', 'TransferFeeConfig']
    : ['ImmutableOwner', 'TransferFeeAmount'];
  const extensions: Extension[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 166; offset < bytes.length;) {
    // Token accounts can reserve zero-filled extension capacity. No unknown nonzero TLV is accepted.
    if (bytes.slice(offset).every((b) => b === 0)) break;
    if (offset + 4 > bytes.length)
      throw new Error('Truncated token extension.');
    const end = offset + 4 + view.getUint16(offset + 2, true);
    if (end > bytes.length) throw new Error('Truncated token extension.');
    const encoded = bytes.slice(offset, end);
    const extension = getExtensionDecoder().decode(encoded);
    if (
      !allowed.includes(extension.__kind) ||
      extensions.some((e) => e.__kind === extension.__kind)
    )
      throw new Error('Token extension requires a separate transfer adapter.');
    const canonical = getExtensionEncoder().encode(extension);
    if (
      canonical.length !== encoded.length ||
      canonical.some((b, i) => b !== encoded[i])
    )
      throw new Error('Noncanonical token extension.');
    extensions.push(extension);
    offset = end;
  }
  return extensions;
}
export function withdrawalTokenAccountSize(fee: boolean) {
  return getTokenSize([
    { __kind: 'ImmutableOwner' },
    ...(fee
      ? [{ __kind: 'TransferFeeAmount' as const, withheldAmount: 0n }]
      : []),
  ]);
}
