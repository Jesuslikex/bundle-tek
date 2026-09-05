import { ponsRoute } from '@/lib/pons/server';
export const dynamic = 'force-dynamic';
export function POST(request: Request) {
  return ponsRoute(request, 'create');
}
