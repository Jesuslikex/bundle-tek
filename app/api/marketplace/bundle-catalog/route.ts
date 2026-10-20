import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { readBundleCatalog } from '@/lib/marketplace-publication-storage';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json({ error: 'Sign in to browse Bundle inventory.' }, 401);
    if (new URL(request.url).search)
      return json(
        { error: 'Bundle inventory accepts no query parameters.' },
        400,
      );
    return json(await readBundleCatalog(getD1(), request.signal));
  } catch {
    return json(
      { error: 'Bundle inventory is unavailable. No purchase was authorized.' },
      request.signal.aborted ? 408 : 503,
    );
  }
}
