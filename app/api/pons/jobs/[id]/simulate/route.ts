import { ponsRoute } from '@/lib/pons/server';
export const dynamic = 'force-dynamic';
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return ponsRoute(request, 'simulate', (await context.params).id);
}
