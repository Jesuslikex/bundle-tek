import { expect, it, vi } from 'vitest';
import { marketplaceFilters } from './marketplace-catalog';
import { readMarketplaceCatalog } from './marketplace-provider';
import { marketplaceFixture } from '../test/marketplace-fixture';
const now = Date.parse('2026-10-17T12:00:00Z'),
  filters = marketplaceFilters.parse({});
const signal = () => new AbortController().signal;
const configuration = {
  MARKETPLACE_CATALOG_URL: 'https://inventory.example.com/bundle/catalog',
  MARKETPLACE_CATALOG_TOKEN: 'fixture-secret',
};
it('filters optional reported regions through the same one-GET public catalog transport', async () => {
  const inventory = marketplaceFixture(now);
  inventory.listings[0].region = 'Europe';
  inventory.listings[1].region = 'Asia';
  const transport = vi.fn<typeof fetch>(async () => Response.json(inventory));
  const result = await readMarketplaceCatalog(
    marketplaceFilters.parse({ regions: ['Europe'] }),
    signal(),
    { configuration, transport, now: () => now },
  );
  expect(transport).toHaveBeenCalledOnce();
  expect(result.listings.map((row) => row.id)).toEqual(['wallet-1']);
  expect(result.regions).toEqual(['Asia', 'Europe']);
  expect(result.purchaseEnabled).toBe(false);
  expect(JSON.stringify(result)).not.toMatch(
    /fixture-secret|inventory.example.com/,
  );
});
it('rejects a misleading provider region instead of silently dropping its row or retrying', async () => {
  const inventory = marketplaceFixture(now);
  inventory.listings[0].region = 'Not reported';
  const transport = vi.fn<typeof fetch>(async () => Response.json(inventory));
  await expect(
    readMarketplaceCatalog(filters, signal(), {
      configuration,
      transport,
      now: () => now,
    }),
  ).rejects.toMatchObject({ status: 502 });
  expect(transport).toHaveBeenCalledOnce();
});
it('performs no network request when no provider is connected', async () => {
  const transport = vi.fn();
  await expect(
    readMarketplaceCatalog(filters, signal(), { configuration: {}, transport }),
  ).rejects.toMatchObject({ status: 503 });
  expect(transport).not.toHaveBeenCalled();
});
it('keeps credentials server-side, bounds the fetch and returns only validated public inventory', async () => {
  const transport = vi.fn<typeof fetch>(async () =>
    Response.json(marketplaceFixture(now)),
  );
  const result = await readMarketplaceCatalog(filters, signal(), {
    configuration,
    transport,
    now: () => now,
  });
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0][1]).toMatchObject({
    redirect: 'error',
    cache: 'no-store',
    headers: { authorization: 'Bearer fixture-secret' },
  });
  expect(JSON.stringify(result)).not.toMatch(
    /fixture-secret|inventory.example.com/,
  );
  expect(result.purchaseEnabled).toBe(false);
});
it('does not retry a 429 or leak HTML, response bodies or exception messages', async () => {
  for (const status of [429, 500, 200]) {
    const transport = vi.fn<typeof fetch>(
      async () =>
        new Response('<html>secret failure</html>', {
          status,
          headers: { 'content-type': 'text/html' },
        }),
    );
    await expect(
      readMarketplaceCatalog(filters, signal(), { configuration, transport }),
    ).rejects.toMatchObject({ status: status === 429 ? 429 : 502 });
    expect(transport).toHaveBeenCalledOnce();
  }
  const transport = vi.fn<typeof fetch>(async () => {
    throw new Error('secret failure');
  });
  await expect(
    readMarketplaceCatalog(filters, signal(), { configuration, transport }),
  ).rejects.not.toThrow('secret failure');
});
it('refuses credential URLs, local/IP destinations, redirects and oversized bodies', async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({}));
  for (const url of [
    'http://inventory.example.com',
    'https://127.0.0.1/catalog',
    'https://[::1]/catalog',
    'https://a:b@inventory.example.com',
    'https://inventory.example.com?key=secret',
  ])
    await expect(
      readMarketplaceCatalog(filters, signal(), {
        configuration: { MARKETPLACE_CATALOG_URL: url },
        transport,
      }),
    ).rejects.toMatchObject({ status: 502 });
  expect(transport).not.toHaveBeenCalled();
  for (const response of [
    new Response(null, { status: 302 }),
    new Response('x'.repeat(262145), {
      headers: { 'content-type': 'application/json' },
    }),
  ])
    await expect(
      readMarketplaceCatalog(filters, signal(), {
        configuration,
        transport: async () => response,
      }),
    ).rejects.toMatchObject({ status: 502 });
});
it('cancels an unfinished streamed response when the caller aborts', async () => {
  const controller = new AbortController(),
    cancelled = vi.fn();
  const stream = new ReadableStream({ cancel: cancelled });
  const transport = vi.fn<typeof fetch>(
    async () =>
      new Response(stream, { headers: { 'content-type': 'application/json' } }),
  );
  const result = readMarketplaceCatalog(filters, controller.signal, {
    configuration,
    transport,
  });
  await vi.waitFor(() => expect(transport).toHaveBeenCalledOnce());
  controller.abort();
  await expect(result).rejects.toMatchObject({ status: 502 });
  expect(cancelled).toHaveBeenCalled();
});
