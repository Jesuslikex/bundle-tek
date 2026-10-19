'use client';
import { useEffect, useRef, useState } from 'react';
import { inspectArtwork, MAX_ARTWORK_BYTES } from '@/lib/artwork';
import { imageFromTransfer, prepareArtwork } from '@/lib/artwork-prepare';

/** Text fields keep normal paste behaviour unless only an image was copied. */
function pastingText(event: ClipboardEvent) {
  const target = event.target as HTMLElement | null;
  const editable =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target?.isContentEditable;
  return Boolean(editable && event.clipboardData?.getData('text/plain'));
}

export function ArtworkUpload({
  onUploaded,
}: {
  onUploaded: (url: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [square, setSquare] = useState(true);
  const [dragging, setDragging] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const latest = useRef<(file: Blob) => void>(() => {});
  useEffect(() => () => pending.current?.abort(), []);
  // Ctrl/Cmd+V an image anywhere on the token form, like Proxima.
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      if (pastingText(event)) return;
      const file = imageFromTransfer(event.clipboardData);
      if (!file) return;
      event.preventDefault();
      latest.current(file);
    }
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, []);
  async function pasteFromClipboard() {
    setError('');
    try {
      if (!navigator.clipboard?.read)
        throw new Error('Press Ctrl+V (Cmd+V on Mac) to paste the image.');
      for (const item of await navigator.clipboard.read()) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) return void upload(await item.getType(type));
      }
      throw new Error('No image on the clipboard. Copy an image first.');
    } catch (error) {
      setError(
        error instanceof Error && error.name !== 'NotAllowedError'
          ? error.message
          : 'Clipboard access was blocked. Press Ctrl+V (Cmd+V on Mac) instead.',
      );
    }
  }
  latest.current = (file) => void upload(file);
  async function upload(source: Blob) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setError('');
    setNotice('');
    setUploading(true);
    try {
      const file = await prepareArtwork(source, square);
      if (controller.signal.aborted) return;
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
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Drop zone convenience; the file input and Paste button are the keyboard paths.
    <section
      className="artwork-upload"
      aria-label="Upload token artwork"
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        const file = imageFromTransfer(event.dataTransfer);
        if (!file) return;
        event.preventDefault();
        void upload(file);
      }}
    >
      <label htmlFor="token-artwork-file">Upload artwork</label>
      <input
        id="token-artwork-file"
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        disabled={uploading}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
          event.target.value = '';
        }}
      />
      <div className="artwork-upload-actions">
        <button
          type="button"
          className="artwork-paste"
          disabled={uploading}
          onClick={() => void pasteFromClipboard()}
        >
          Paste image
        </button>
        <label className="artwork-square">
          <input
            type="checkbox"
            checked={square}
            onChange={(event) => setSquare(event.target.checked)}
          />
          Crop to square (1:1)
        </label>
      </div>
      <p className="source-note">
        Choose a file, drop it here, or copy an image and press Ctrl+V (Cmd+V on
        Mac). PNG, JPEG, GIF or WebP up to 20 MB; it is cropped to 1:1 and
        resized to fit 512 KB. GIFs keep their first frame. Uploaded artwork is
        private to your account.
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
