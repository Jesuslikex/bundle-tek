import { inspectRobinhoodToken } from '@/lib/robinhood-token';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
 const address = new URL(request.url).searchParams.get('address') ?? '';
 const headers = { 'cache-control': 'no-store' };
 if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return Response.json({ error: 'Enter 0x followed by 40 hexadecimal characters.' }, { status: 400, headers });
 try { return Response.json({ token: await inspectRobinhoodToken(address) }, { headers }); }
 catch { return Response.json({ error: 'Inspection unavailable. Check the contract address; the public RPC may be rate-limited or the contract may not expose standard token metadata.' }, { status: 502, headers }); }
}
