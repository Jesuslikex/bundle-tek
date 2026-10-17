'use client';
import { useEffect, useRef, useState } from 'react';
import { Button } from './ui/button';
import {
  draftFromNarrative,
  type Narrative,
  type NarrativeDraft,
  type NarrativeFeed,
} from '@/lib/narratives';

/**
 * Trending meme narratives from public feeds, each one a click away from a
 * pre-filled launch draft. It only fills draft text: launching still goes
 * through the normal review and wallet approval.
 */
async function fetchFeed(refresh: boolean, signal: AbortSignal) {
  const response = await fetch(
    `/api/narratives${refresh ? '?refresh=1' : ''}`,
    { cache: 'no-store', signal },
  );
  const body = (await response.json().catch(() => ({}))) as NarrativeFeed & {
    error?: string;
  };
  if (!response.ok)
    throw new Error(body.error || 'Trending narratives unavailable.');
  return body;
}

export function NarrativeFinder({
  onDraft,
}: {
  onDraft: (draft: NarrativeDraft, keyword: string) => void;
}) {
  const [feed, setFeed] = useState<NarrativeFeed | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<{
    keyword: string;
    variant: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const pending = useRef<AbortController | null>(null);

  function read(refresh: boolean) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const current = () => pending.current === controller;
    fetchFeed(refresh, controller.signal)
      .then(
        (body) => {
          if (current()) setFeed(body);
        },
        (e: unknown) => {
          if (!controller.signal.aborted && current())
            setError(
              e instanceof Error
                ? e.message
                : 'Trending narratives unavailable.',
            );
        },
      )
      .finally(() => {
        if (current()) {
          pending.current = null;
          setLoading(false);
        }
      });
  }
  function load(refresh: boolean) {
    setLoading(true);
    setError('');
    read(refresh);
  }
  useEffect(() => {
    read(false);
    return () => pending.current?.abort();
  }, []);

  const narrative = feed?.narratives.find(
    (n) => n.keyword === selected?.keyword,
  );
  const draft =
    narrative && selected
      ? draftFromNarrative(narrative, selected.variant)
      : null;
  const down = feed?.sources.filter((s) => !s.ok).map((s) => s.source) ?? [];

  return (
    <section
      aria-labelledby="narratives-heading"
      className="narrative-finder min-w-0 space-y-3"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="narratives-heading">Trending narratives</h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading}
          onClick={() => load(true)}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>
      <p className="source-note">
        Themes shared by tokens trending on DexScreener, CoinGecko and pump.fun
        right now. Pick one to start a launch draft; nothing launches until you
        review and approve it.
      </p>
      {error && <p role="alert">{error}</p>}
      {feed && (
        <>
          <p className="source-note">
            Read {new Date(feed.observedAt).toLocaleTimeString()}.
            {down.length > 0 && <> Unavailable: {down.join(', ')}.</>}
          </p>
          {feed.narratives.length === 0 ? (
            <p>No shared themes in the feeds right now. Try again shortly.</p>
          ) : (
            <ol className="narrative-list space-y-2">
              {feed.narratives.map((n) => (
                <NarrativeRow
                  key={n.keyword}
                  narrative={n}
                  active={n.keyword === selected?.keyword}
                  onPick={() => {
                    setCopied(false);
                    setSelected({ keyword: n.keyword, variant: 0 });
                  }}
                />
              ))}
            </ol>
          )}
        </>
      )}
      {draft && narrative && selected && (
        <div
          className="narrative-draft space-y-2"
          aria-label={`Draft for ${narrative.keyword}`}
        >
          <h4>
            {draft.tokenName} <small>${draft.ticker}</small>
          </h4>
          <p>{draft.description}</p>
          <p className="source-note">
            Image prompt: <span>{draft.imagePrompt}</span>
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => onDraft(draft, narrative.keyword)}
            >
              Start launch draft
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCopied(false);
                setSelected({ ...selected, variant: selected.variant + 1 });
              }}
            >
              Another name
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void navigator.clipboard.writeText(draft.imagePrompt).then(
                  () => setCopied(true),
                  () => setCopied(false),
                )
              }
            >
              {copied ? 'Prompt copied' : 'Copy image prompt'}
            </Button>
          </div>
          <p className="source-note">
            Check the name and ticker are not already taken on your launchpad
            before you launch.
          </p>
        </div>
      )}
    </section>
  );
}

function NarrativeRow({
  narrative,
  active,
  onPick,
}: {
  narrative: Narrative;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <li className="narrative-row">
      <div className="flex flex-wrap items-baseline gap-2">
        <strong>{narrative.keyword}</strong>
        <small>score {narrative.score}</small>
        <small>{narrative.sources.join(' · ')}</small>
        <Button
          type="button"
          size="sm"
          variant={active ? 'default' : 'outline'}
          onClick={onPick}
        >
          {active ? 'Selected' : 'Draft from this'}
        </Button>
      </div>
      <p className="source-note">
        {narrative.tokens.map((t, i) => (
          <span key={`${t.source}:${t.url}`}>
            {i > 0 && ', '}
            <a href={t.url} target="_blank" rel="noopener noreferrer nofollow">
              {t.name} (${t.symbol})
            </a>
          </span>
        ))}
        {narrative.related.length > 0 && (
          <> · also {narrative.related.join(', ')}</>
        )}
      </p>
    </li>
  );
}
