export const MAX_ARTWORK_BYTES = 512 * 1024;
export const MAX_ARTWORK_COUNT = 100;
export const MAX_ARTWORK_STORAGE = 25 * 1024 * 1024;
export type SavedArtwork = {
  id: string;
  url: string;
  mime: string;
  bytes: number;
  createdAt: string;
  activeProjects: number;
  archivedProjects: number;
  archived: boolean;
  revision: number;
  updatedAt: string;
};
export const artworkIdValid = (id: string) => /^[a-f0-9]{64}$/.test(id);
export const isUploadedArtwork = (url: string) =>
  /^\/api\/artwork\/[a-f0-9]{64}$/.test(url);

export function inspectArtwork(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > MAX_ARTWORK_BYTES)
    throw new Error('Choose an image up to 512 KB.');
  let width = 0,
    height = 0,
    mime = '';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 33 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b) &&
    view.getUint32(8) === 13 &&
    String.fromCharCode(...bytes.slice(12, 16)) === 'IHDR'
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
    mime = 'image/png';
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218 || offset + 2 > bytes.length) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        size >= 8
      ) {
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        mime = 'image/jpeg';
        break;
      }
      offset += size;
    }
  }
  if (!mime || width < 1 || height < 1 || width > 4096 || height > 4096)
    throw new Error(
      'Use a PNG or JPEG image with dimensions from 1 to 4096 pixels.',
    );
  return { mime, width, height };
}
