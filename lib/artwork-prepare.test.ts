import { describe, expect, it } from 'vitest';
import {
  artworkCrop,
  encodeWithinLimit,
  imageFromTransfer,
} from './artwork-prepare';

describe('artworkCrop', () => {
  it('centre-crops landscape and portrait to 1:1', () => {
    expect(artworkCrop(1200, 800, true)).toEqual({
      sx: 200,
      sy: 0,
      sw: 800,
      sh: 800,
      width: 800,
      height: 800,
    });
    expect(artworkCrop(300, 501, true)).toMatchObject({
      sx: 0,
      sy: 100,
      sw: 300,
      sh: 300,
    });
  });
  it('scales large images down to the edge limit, never up', () => {
    expect(artworkCrop(4000, 3000, true)).toMatchObject({
      sw: 3000,
      width: 1000,
      height: 1000,
    });
    expect(artworkCrop(4000, 2000, false)).toMatchObject({
      sx: 0,
      sy: 0,
      width: 1000,
      height: 500,
    });
    expect(artworkCrop(64, 32, false)).toMatchObject({ width: 64, height: 32 });
  });
  it('rejects unreadable dimensions', () => {
    expect(() => artworkCrop(0, 10, true)).toThrow();
  });
});

describe('encodeWithinLimit', () => {
  const blob = (size: number, type: string) =>
    new Blob([new Uint8Array(size)], { type });
  it('keeps PNG when it fits', async () => {
    const result = await encodeWithinLimit(
      async (type) => blob(100, type),
      200,
    );
    expect(result.type).toBe('image/png');
  });
  it('falls back to lower JPEG quality until it fits', async () => {
    const calls: Array<[string, number | undefined]> = [];
    const result = await encodeWithinLimit(async (type, quality) => {
      calls.push([type, quality]);
      if (type === 'image/png') return blob(500, type);
      return blob(quality! > 0.7 ? 300 : 150, type);
    }, 200);
    expect(result.type).toBe('image/jpeg');
    expect(calls.map((c) => c[1])).toEqual([undefined, 0.92, 0.85, 0.75, 0.65]);
  });
  it('fails clearly when nothing fits', async () => {
    await expect(
      encodeWithinLimit(async (type) => blob(500, type), 200),
    ).rejects.toThrow('512 KB');
  });
});

describe('imageFromTransfer', () => {
  it('finds an image in files or items and ignores other data', () => {
    const image = new File([new Uint8Array(1)], 'a.png', { type: 'image/png' });
    const text = new File(['x'], 'a.txt', { type: 'text/plain' });
    expect(
      imageFromTransfer({ files: [text, image] as never, items: [] as never }),
    ).toBe(image);
    expect(
      imageFromTransfer({
        files: [] as never,
        items: [
          { kind: 'string', type: 'text/html', getAsFile: () => null },
          { kind: 'file', type: 'image/gif', getAsFile: () => image },
        ] as never,
      }),
    ).toBe(image);
    expect(
      imageFromTransfer({ files: [text] as never, items: [] as never }),
    ).toBeNull();
    expect(imageFromTransfer(null)).toBeNull();
  });
});
