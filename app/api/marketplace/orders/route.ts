import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { getD1 } from '@/db';
import { env } from '@/lib/server-env';
import { walletRequest } from '@/lib/wallet-request';
import { getSolanaRpcEndpoint } from '@/lib/solana-rpc';
import { balanceRpc } from '@/lib/wallet-balances';
import { MarketplaceReservationError } from '@/lib/marketplace-reservation-storage';
import {
  MarketplaceOrderError,
  cancelMarketplaceOrder,
  createMarketplaceOrder,
  createOrderRequest,
  deliverMarketplaceOrder,
  listMarketplaceOrders,
  pendingMarketplaceDeliveries,
  recoverMarketplaceOrder,
  registerMarketplaceOrder,
  submitMarketplaceOrder,
  type OrderRpc,
} from '@/lib/marketplace-order-storage';
import { orderDelivery } from '@/lib/marketplace-order';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const id = z.uuid();
const actions = z.discriminatedUnion('action', [
  createOrderRequest.extend({ action: z.literal('create') }),
  z
    .object({
      action: z.literal('register'),
      id,
      transaction: z.string().max(1700),
    })
    .strict(),
  z.object({ action: z.enum(['submit', 'recover', 'cancel']), id }).strict(),
  z
    .object({
      action: z.literal('deliver'),
      id,
      deliveries: z.array(orderDelivery).min(1).max(200),
    })
    .strict(),
]);
const sendable = new Set([
  'getGenesisHash',
  'getLatestBlockhash',
  'getBalance',
  'getTransaction',
  'getBlockHeight',
]);
function rpc(signal: AbortSignal, canSend: boolean): OrderRpc {
  const endpoint = getSolanaRpcEndpoint('mainnet');
  return (method, params) => {
    signal.throwIfAborted();
    if (!sendable.has(method) && !(canSend && method === 'sendTransaction'))
      throw new Error('Unsupported checkout RPC.');
    return balanceRpc(endpoint, method, params, signal, fetch);
  };
}
function failure(error: unknown) {
  if (
    error instanceof MarketplaceOrderError ||
    error instanceof MarketplaceReservationError
  )
    return json({ error: error.message }, error.status);
  if (error instanceof z.ZodError)
    return json({ error: 'Checkout request differs.' }, 400);
  return json(
    {
      error:
        'Checkout unavailable. Recover this order before another payment; nothing is resent.',
    },
    503,
  );
}

export async function GET(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: 'Sign in to see your orders.' }, 401);
    const params = new URL(request.url).searchParams;
    const db = getD1();
    if (params.get('deliveries') === '1')
      return json({
        pending: await pendingMarketplaceDeliveries(db, user.userId),
      });
    return json({ orders: await listMarketplaceOrders(db, user.userId) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getChatGPTUser();
    if (!user) return json({ error: 'Sign in to check out.' }, 401);
    if (request.headers.get('origin') !== new URL(request.url).origin)
      return json({ error: 'Same-origin request required.' }, 403);
    if (
      request.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase() !== 'application/json'
    )
      return json({ error: 'JSON required.' }, 415);
    const input = actions.parse(await walletRequest(request, 65536));
    const db = getD1();
    const signal = AbortSignal.any([
      request.signal,
      AbortSignal.timeout(25000),
    ]);
    switch (input.action) {
      case 'create': {
        const { action: _action, ...body } = input;
        return json({
          order: await createMarketplaceOrder(
            db,
            user.userId,
            body,
            (env as unknown as Record<string, string | undefined>)
              .MARKETPLACE_PAYOUT_ADDRESS,
            rpc(signal, false),
            signal,
          ),
        });
      }
      case 'register':
        return json({
          order: await registerMarketplaceOrder(
            db,
            user.userId,
            input.id,
            input.transaction,
          ),
        });
      case 'submit':
        return json({
          order: await submitMarketplaceOrder(
            db,
            user.userId,
            input.id,
            rpc(AbortSignal.timeout(25000), true),
          ),
        });
      case 'recover':
        return json({
          order: await recoverMarketplaceOrder(
            db,
            user.userId,
            input.id,
            rpc(signal, false),
          ),
        });
      case 'cancel':
        return json({
          order: await cancelMarketplaceOrder(db, user.userId, input.id),
        });
      case 'deliver':
        return json({
          pending: await deliverMarketplaceOrder(
            db,
            user.userId,
            input.id,
            input.deliveries,
          ),
        });
    }
  } catch (error) {
    return failure(error);
  }
}
