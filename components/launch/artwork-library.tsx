'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { isUploadedArtwork, type SavedArtwork } from '@/lib/artwork';
const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(1)} KB`;
export function ArtworkLibrary({
  selectedUrl,
  onSelected,
}: {
  selectedUrl: string;
  onSelected: (url: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [items, setItems] = useState<SavedArtwork[]>([]),
    [view, setView] = useState<'active' | 'archived'>('active'),
    [notice, setNotice] = useState(''),
    [failed, setFailed] = useState<Record<string, boolean>>({}),
    [usage, setUsage] = useState<{
      count: number;
      bytes: number;
      maxCount: number;
      maxBytes: number;
    } | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  async function refresh(nextView: 'active' | 'archived' = view) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setFailed({});
    try {
      const response = await fetch(`/api/artwork?view=${nextView}`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      const body = (await response.json()) as {
        artwork?: SavedArtwork[];
        usage?: {
          count: number;
          bytes: number;
          maxCount: number;
          maxBytes: number;
        };
        error?: string;
      };
      if (!response.ok || !Array.isArray(body.artwork) || !body.usage)
        throw new Error(body.error || 'Artwork library unavailable.');
      if (
        body.artwork.some(
          (item) =>
            !isUploadedArtwork(item.url) ||
            item.archived !== (nextView === 'archived') ||
            !Number.isSafeInteger(item.revision) ||
            item.revision < 1,
        )
      )
        throw new Error('Invalid saved artwork reference.');
      if (!controller.signal.aborted) {
        setItems(body.artwork);
        setUsage(body.usage);
        setView(nextView);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Artwork library unavailable.',
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  async function manage(item: SavedArtwork) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/artwork', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          id: item.id,
          expectedRevision: item.revision,
          action: item.archived ? 'restore' : 'archive',
        }),
      });
      const data = (await response.json()) as {
        id: string;
        revision: number;
        archived: boolean;
        error?: string;
      };
      if (
        !response.ok ||
        data.id !== item.id ||
        data.revision !== item.revision + 1 ||
        data.archived !== !item.archived
      )
        throw new Error(data.error || 'Artwork change unavailable.');
      if (!controller.signal.aborted) {
        setNotice(
          item.archived
            ? 'Artwork restored.'
            : 'Artwork archived. Draft selection and saved project references remain available.',
        );
        await refresh(view);
      }
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : 'Artwork change unavailable.',
        );
    } finally {
      if (pending.current === controller && !controller.signal.aborted)
        setBusy(false);
    }
  }
  return (
    <section className="artwork-library" aria-label="Saved artwork library">
      <Button
        type="button"
        variant="outline"
        aria-expanded={open}
        onClick={() => {
          if (open) {
            pending.current?.abort();
            setOpen(false);
            setBusy(false);
          } else {
            setOpen(true);
            void refresh();
          }
        }}
      >
        {open ? 'Hide artwork library' : 'Browse saved artwork'}
      </Button>
      {open && (
        <>
          <div className="artwork-library-heading">
            <h3>Your saved artwork</h3>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void refresh()}
            >
              Reload artwork
            </Button>
          </div>
          <div className="artwork-library-heading" aria-label="Artwork views">
            <Button
              variant="outline"
              disabled={busy}
              aria-pressed={view === 'active'}
              onClick={() => void refresh('active')}
            >
              Active artwork
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              aria-pressed={view === 'archived'}
              onClick={() => void refresh('archived')}
            >
              Archived artwork
            </Button>
          </div>
          <p className="source-note">
            Private to your account. Selecting an image updates this draft. Save
            the project to keep it. Usage counts include saved projects only.{' '}
            Archiving hides images from the active library. Existing references
            keep working. Archived images still count toward storage limits.
          </p>
          <div aria-live="polite">
            {busy && <p>Loading artwork…</p>}
            {notice && <output>{notice}</output>}
            {error && (
              <p role="alert" className="inspection-error">
                {error}
              </p>
            )}
            {usage && (
              <p>
                {usage.count}/{usage.maxCount} images · {size(usage.bytes)} of{' '}
                {size(usage.maxBytes)}
              </p>
            )}
            {usage && !items.length && (
              <p>
                {view === 'archived'
                  ? 'No archived artwork.'
                  : 'No active artwork. Upload an image or restore one from the archive.'}
              </p>
            )}
          </div>
          <div className="artwork-library-grid">
            {items.map((item) => (
              <article
                key={item.id}
                className={selectedUrl === item.url ? 'selected' : ''}
              >
                {/* oxlint-disable-next-line next/no-img-element -- Authenticated private images stay on the same origin. */}
                <img
                  src={item.url}
                  alt={`Saved artwork ${item.id.slice(0, 8)}`}
                  loading="lazy"
                  width={120}
                  height={120}
                  onError={() =>
                    setFailed((current) => ({ ...current, [item.id]: true }))
                  }
                />
                <p>
                  {item.mime === 'image/png' ? 'PNG' : 'JPEG'} ·{' '}
                  {size(item.bytes)}
                </p>
                <p>
                  {item.activeProjects} active · {item.archivedProjects}{' '}
                  archived projects
                </p>
                {failed[item.id] && <p>Preview unavailable.</p>}
                {!item.archived && (
                  <Button
                    type="button"
                    variant="outline"
                    aria-label={`Use artwork ${item.id.slice(0, 8)}`}
                    aria-pressed={selectedUrl === item.url}
                    disabled={busy || failed[item.id]}
                    onClick={() => onSelected(item.url)}
                  >
                    {selectedUrl === item.url ? 'Selected' : 'Use artwork'}
                  </Button>
                )}
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  aria-label={`${item.archived ? 'Restore' : 'Archive'} artwork ${item.id.slice(0, 8)}`}
                  onClick={() => void manage(item)}
                >
                  {item.archived ? 'Restore artwork' : 'Archive artwork'}
                </Button>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
