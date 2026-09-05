import { ponsRoute } from '@/lib/pons/server';
export const dynamic = 'force-dynamic';
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return ponsRoute(request, 'get', (await context.params).id);
}
