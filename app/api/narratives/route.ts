import { getChatGPTUser } from '@/app/chatgpt-auth';
import {
  collectNarrativeSignals,
  rankNarratives,
  type NarrativeFeed,
} from '@/lib/narratives';

// Trending narratives from public feeds. Read-only and shared by all users,
// so one cached read serves everyone instead of each visit hitting the feeds.
export const dynamic = 'force-dynamic';
const CACHE_MS = 120_000;
const TIMEOUT_MS = 8_000;
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

let cached: { at: number; feed: NarrativeFeed } | null = null;
let inflight: Promise<NarrativeFeed> | null = null;

async function load() {
  const { signals, sources } = await collectNarrativeSignals(
    AbortSignal.timeout(TIMEOUT_MS),
  );
  return {
    observedAt: new Date().toISOString(),
    narratives: rankNarratives(signals),
    sources,
  };
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: 'Sign in to see trending narratives.' }, 401);
  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  // A refresh can skip the cache, but not more often than every 20 seconds.
  const maxAge = refresh ? 20_000 : CACHE_MS;
  if (cached && Date.now() - cached.at < maxAge) return json(cached.feed);
  inflight ??= load().finally(() => {
    inflight = null;
  });
  const feed = await inflight;
  if (!feed.sources.some((s) => s.ok))
    return json({ error: 'Trending feeds are unavailable right now.' }, 503);
  cached = { at: Date.now(), feed };
  return json(feed);
}
