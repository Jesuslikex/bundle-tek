import { expect, it, vi } from 'vitest';
import {
  readBoundedPanelJson,
  PANEL_JSON_RESPONSE_BYTES,
} from './read-bounded-panel-json';
it('keeps the exact byte limit and fatal JSON/UTF8/type refusal', async () => {
  const signal = new AbortController().signal;
  expect(
    await readBoundedPanelJson(Response.json({ wallets: [] }), signal),
  ).toEqual({ wallets: [] });
  const exact = '"' + 'x'.repeat(PANEL_JSON_RESPONSE_BYTES - 2) + '"';
  expect(
    (
      (await readBoundedPanelJson(
        new Response(exact, {
          headers: { 'content-type': 'application/json' },
        }),
        signal,
      )) as string
    ).length,
  ).toBe(PANEL_JSON_RESPONSE_BYTES - 2);
  for (const response of [
    new Response('<html>private</html>'),
    new Response(' '.repeat(PANEL_JSON_RESPONSE_BYTES + 1), {
      headers: { 'content-type': 'application/json' },
    }),
    new Response(new Uint8Array([255]), {
      headers: { 'content-type': 'application/json' },
    }),
    new Response('{', { headers: { 'content-type': 'application/json' } }),
  ]) {
    await expect(readBoundedPanelJson(response, signal)).rejects.toThrow(
      'The panel response is unavailable.',
    );
  }
});
it('cancels before a read and during a stalled body without retaining a reader lock', async () => {
  for (const before of [true, false]) {
    const cancelled = vi.fn(),
      controller = new AbortController();
    const response = new Response(
      new ReadableStream({
        start(s) {
          s.enqueue(new TextEncoder().encode('{'));
        },
        cancel: cancelled,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    if (before) controller.abort();
    const read = readBoundedPanelJson(response, controller.signal),
      refused = expect(read).rejects.toMatchObject({ name: 'AbortError' });
    if (!before) {
      await Promise.resolve();
      controller.abort();
    }
    await refused;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(response.body!.locked).toBe(false);
  }
});
