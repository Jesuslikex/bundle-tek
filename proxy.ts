import { NextRequest, NextResponse } from 'next/server';
/** Cookie-authenticated writes must come from this deployment's own UI. */
export function proxy(request: NextRequest) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (origin !== new URL(request.url).origin)
      return NextResponse.json(
        { error: 'Untrusted request origin.' },
        { status: 403 },
      );
  }
  return NextResponse.next();
}
export const config = { matcher: '/api/:path*' };
