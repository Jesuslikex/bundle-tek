import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import {
  savedEvidenceRequest,
  SavedEvidenceRequestError,
  SavedEvidenceReadError,
} from '@/lib/marketplace-saved-evidence';
import {
  readMarketplaceSavedEvidence,
  SavedEvidenceStoredError,
} from '@/lib/marketplace-saved-evidence-server';
export const dynamic = 'force-dynamic';
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user)
      return json(
        { error: 'Sign in to inspect your saved wallet evidence.' },
        401,
      );
    if (request.signal.aborted)
      return json({ error: 'Saved evidence read cancelled.' }, 408);
    if (request.url.length > 4096)
      return json({ error: 'Choose a valid saved wallet evidence page.' }, 400);
    const input = savedEvidenceRequest(new URL(request.url).searchParams);
    return json(
      await readMarketplaceSavedEvidence(
        getD1(),
        user.userId,
        input,
        request.signal,
      ),
    );
  } catch (error) {
    if (request.signal.aborted)
      return json({ error: 'Saved evidence read cancelled.' }, 408);
    if (error instanceof SavedEvidenceRequestError)
      return json({ error: 'Choose a valid saved wallet evidence page.' }, 400);
    const status =
      error instanceof SavedEvidenceStoredError &&
      [404, 409].includes(error.status)
        ? error.status
        : 503;
    return json({ error: new SavedEvidenceReadError(status).message }, status);
  }
}
