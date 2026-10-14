import { headers } from 'next/headers';
import { getAuth } from '@/lib/auth';
export type ChatGPTUser = { userId: string; email: string };
/** Compatibility name; Vercel identity comes only from a verified session cookie. */
export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const session = await getAuth().api.getSession({ headers: await headers() });
  return session
    ? { userId: session.user.id, email: session.user.email }
    : null;
}
