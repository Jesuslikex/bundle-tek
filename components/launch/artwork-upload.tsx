'use client';
import { useEffect, useRef, useState } from 'react';
import { inspectArtwork, MAX_ARTWORK_BYTES } from '@/lib/artwork';

export function ArtworkUpload({
  onUploaded,
}: {
  onUploaded: (url: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function upload(file: File) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setError('');
    setNotice('');
    setUploading(true);
    try {
      if (file.size > MAX_ARTWORK_BYTES)
        throw new Error('Choose an image up to 512 KB.');
      const buffer = await file.arrayBuffer();
      const image = inspectArtwork(new Uint8Array(buffer));
      if (controller.signal.aborted) return;
      const bitmap = await createImageBitmap(file);
      const valid =
        bitmap.width === image.width && bitmap.height === image.height;
      bitmap.close();
      if (!valid) throw new Error('Image dimensions could not be verified.');
      if (controller.signal.aborted) return;
      const response = await fetch('/api/artwork', {
        method: 'POST',
        headers: { 'content-type': image.mime },
        body: buffer,
        signal: controller.signal,
      });
      const body = (await response.json()) as {
        artwork?: { url: string; archived?: boolean };
        error?: string;
      };
      if (!response.ok || !body.artwork)
        throw new Error(body.error || 'Artwork upload failed.');
      if (!controller.signal.aborted && pending.current === controller) {
        onUploaded(body.artwork.url);
        setNotice(
          body.artwork.archived
            ? 'Existing archived artwork selected. Restore it in the library to show it among active images. Save your project to keep this selection.'
            : 'Artwork uploaded. Save your project to keep this selection.',
        );
      }
    } catch (error) {
      if (!controller.signal.aborted && pending.current === controller)
        setError(
          error instanceof Error ? error.message : 'Image could not be read.',
        );
    } finally {
      if (pending.current === controller) {
        setUploading(false);
        pending.current = null;
      }
    }
  }
  return (
    <section className="artwork-upload" aria-label="Upload token artwork">
      <label htmlFor="token-artwork-file">Upload artwork</label>
      <input
        id="token-artwork-file"
        type="file"
        accept="image/png,image/jpeg"
        disabled={uploading}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = '';
        }}
      />
      <p className="source-note">
        PNG or JPEG, up to 512 KB and 4096 pixels. Uploaded artwork is private
        to your account.
      </p>
      <div aria-live="polite">
        {uploading && <p>Uploading artwork…</p>}
        {notice && <p>{notice}</p>}
        {error && (
          <p role="alert" className="inspection-error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
