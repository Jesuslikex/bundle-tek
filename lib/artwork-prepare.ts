import { MAX_ARTWORK_BYTES } from './artwork';

/** Largest edge for prepared token artwork. Launchpads display ~1000px or less. */
export const PREPARED_ARTWORK_EDGE = 1000;
/** Source images people paste or drop can be larger than the stored limit. */
export const MAX_SOURCE_ARTWORK_BYTES = 20 * 1024 * 1024;

export type ArtworkCrop = {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  width: number;
  height: number;
};

/**
 * Source rectangle and output size for the prepared image. `square` takes the
 * centred 1:1 region (as launchpads display token art); otherwise the whole
 * image is kept. Output is scaled down to `maxEdge`, never up.
 */
export function artworkCrop(
  width: number,
  height: number,
  square: boolean,
  maxEdge = PREPARED_ARTWORK_EDGE,
): ArtworkCrop {
  if (!(width >= 1 && height >= 1))
    throw new Error('Image dimensions could not be read.');
  const sw = square ? Math.min(width, height) : width;
  const sh = square ? Math.min(width, height) : height;
  const sx = Math.floor((width - sw) / 2);
  const sy = Math.floor((height - sh) / 2);
  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  return {
    sx,
    sy,
    sw,
    sh,
    width: Math.max(1, Math.round(sw * scale)),
    height: Math.max(1, Math.round(sh * scale)),
  };
}

export type ArtworkEncoder = (
  type: 'image/png' | 'image/jpeg',
  quality?: number,
) => Promise<Blob | null>;

/**
 * Encode to PNG first (keeps transparency); if that is over the stored limit,
 * step JPEG quality down until it fits.
 */
export async function encodeWithinLimit(
  encode: ArtworkEncoder,
  limit = MAX_ARTWORK_BYTES,
): Promise<Blob> {
  const png = await encode('image/png');
  if (png && png.size > 0 && png.size <= limit) return png;
  for (const quality of [0.92, 0.85, 0.75, 0.65, 0.5]) {
    const jpeg = await encode('image/jpeg', quality);
    if (jpeg && jpeg.size > 0 && jpeg.size <= limit) return jpeg;
  }
  throw new Error('Image is too detailed to fit in 512 KB. Try another one.');
}

/** First image file in a paste or drop, if any. */
export function imageFromTransfer(
  data: Pick<DataTransfer, 'files' | 'items'> | null | undefined,
): File | null {
  if (!data) return null;
  for (const file of Array.from(data.files ?? []))
    if (file.type.startsWith('image/')) return file;
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return null;
}

/**
 * Browser-only: decode any image the browser can read (PNG, JPEG, GIF first
 * frame, WebP…), optionally centre-crop to 1:1, scale to at most
 * PREPARED_ARTWORK_EDGE and re-encode as PNG/JPEG within the stored limit.
 */
export async function prepareArtwork(file: Blob, square: boolean) {
  if (file.size > MAX_SOURCE_ARTWORK_BYTES)
    throw new Error('Choose an image up to 20 MB.');
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('This file is not an image the browser can read.');
  }
  try {
    const crop = artworkCrop(bitmap.width, bitmap.height, square);
    const canvas = document.createElement('canvas');
    canvas.width = crop.width;
    canvas.height = crop.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image could not be prepared.');
    context.imageSmoothingQuality = 'high';
    context.drawImage(
      bitmap,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      0,
      0,
      crop.width,
      crop.height,
    );
    return await encodeWithinLimit((type, quality) => {
      let target = canvas;
      if (type === 'image/jpeg') {
        // JPEG has no alpha: flatten transparent areas onto white, not black.
        target = document.createElement('canvas');
        target.width = canvas.width;
        target.height = canvas.height;
        const flat = target.getContext('2d');
        if (!flat) return Promise.resolve(null);
        flat.fillStyle = '#ffffff';
        flat.fillRect(0, 0, target.width, target.height);
        flat.drawImage(canvas, 0, 0);
      }
      return new Promise((resolve) => target.toBlob(resolve, type, quality));
    });
  } finally {
    bitmap.close();
  }
}
