import { z } from 'zod';
import { ExchangeFundingError } from './exchange-funding-quote';
import { exchangeUiRequest } from './exchange-ui-request';
import {
  exchangeRefundAddress,
  exchangeProviderId,
} from './exchange-order-review';
import { exchangeSolLamports } from './exchange-funding-review';

const origin = 'https://api.changenow.io/v2/';
const maximumBytes = 65536;
const amountFields = new Set([
  'fromAmount',
  'toAmount',
  'expectedAmountFrom',
  'expectedAmountTo',
  'amountFrom',
  'amountTo',
]);
const request = z
  .object({
    currency: z.literal('sol'),
    network: z.literal('sol'),
    toAmount: z.string(),
    address: z.string(),
    refundAddress: z.string(),
    rateId: z.string().min(1).max(4096),
  })
  .strict();
const fail = (message: string, status = 503): never => {
  throw new ExchangeFundingError(message, status);
};

/** Internal adapter only. No application caller or environment-based enablement exists. */
export function createExchangeOrderTransport(options: {
  enabled?: boolean;
  key?: string;
  fetchImpl?: typeof fetch;
}) {
  if (
    options.enabled !== true ||
    !options.key ||
    options.key.length > 4096 ||
    /[\p{Cc}\s]/u.test(options.key)
  )
    return fail(
      'Exchange order transport is not configured. No provider request was made.',
    );
  const key = options.key,
    fetcher = options.fetchImpl ?? fetch;
  async function call(
    path: string,
    signal: AbortSignal,
    body?: z.infer<typeof request>,
  ) {
    try {
      return await exchangeUiRequest(
        signal,
        async (child) => {
          const response = await fetcher(origin + path, {
            method: body ? 'POST' : 'GET',
            headers: {
              'x-changenow-api-key': key,
              ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: child,
            redirect: 'manual',
            cache: 'no-store',
          });
          child.throwIfAborted();
          if (!response.ok)
            return fail(
              response.status === 429
                ? 'Exchange provider rate limit reached. Reconcile saved evidence before another request.'
                : 'Exchange provider response was refused. Reconcile the saved attempt; do not create another order.',
              response.status === 429 ? 429 : 503,
            );
          const reader = response.body?.getReader();
          if (!reader)
            return fail('Exchange provider returned an empty response.', 502);
          const chunks: Uint8Array[] = [];
          let total = 0;
          const cancel = () => {
            void reader.cancel().catch(() => {});
          };
          child.addEventListener('abort', cancel, { once: true });
          try {
            while (true) {
              child.throwIfAborted();
              const part = await reader.read();
              if (part.done) break;
              total += part.value.byteLength;
              if (total > maximumBytes)
                return fail(
                  'Exchange provider response exceeded its size limit.',
                  502,
                );
              chunks.push(part.value);
            }
            child.throwIfAborted();
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
                (
                  name: string,
                  value: unknown,
                  context?: { source?: string },
                ) => {
                  if (amountFields.has(name) && typeof value === 'number') {
                    if (
                      !context?.source ||
                      !/^(0|[1-9]\d{0,9})(\.\d{1,9})?$/.test(context.source)
                    )
                      throw Error('Unqualified numeric amount');
                    return context.source;
                  }
                  return value;
                },
              );
            } catch {
              return fail(
                'Exchange provider returned an unreadable or inexact response.',
                502,
              );
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
              return fail('Exchange provider response is incomplete.', 502);
            return parsed;
          } finally {
            child.removeEventListener('abort', cancel);
            cancel();
            reader.releaseLock();
          }
        },
        15000,
      );
    } catch (error) {
      if (error instanceof ExchangeFundingError) throw error;
      return fail(
        'Exchange provider request outcome is unavailable. Reconcile the saved attempt; do not create another order.',
      );
    }
  }
  return {
    async create(value: unknown, signal: AbortSignal) {
      const parsed = request.safeParse(value);
      if (!parsed.success)
        return fail(
          'Only an exact native SOL order request is supported.',
          400,
        );
      const body = parsed.data;
      try {
        exchangeSolLamports(body.toAmount);
        exchangeRefundAddress(body.address);
        exchangeRefundAddress(body.refundAddress);
        if (body.address === body.refundAddress || /\p{Cc}/u.test(body.rateId))
          throw Error();
      } catch {
        return fail(
          'Review the exact SOL payout and separate receiving/refund wallets.',
          400,
        );
      }
      signal.throwIfAborted();
      return call('private-transfer', signal, body);
    },
    async lookup(providerId: string, signal: AbortSignal) {
      if (!exchangeProviderId.safeParse(providerId).success)
        return fail('Choose a retained provider reference.', 400);
      signal.throwIfAborted();
      return call(
        'exchange/by-id?' + new URLSearchParams({ id: providerId }),
        signal,
      );
    },
  };
}
