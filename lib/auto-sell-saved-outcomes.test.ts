import { expect, it, vi } from 'vitest';
import {
  autoSellOutcomePage,
  autoSellOutcomeReference as ref,
} from '../test/auto-sell-outcome-fixture';
import {
  AUTO_SELL_SAVED_RESPONSE_BYTES,
  autoSellSavedOutcomePage as project,
  autoSellSavedSelection,
  readAutoSellSavedResponse as read,
} from './auto-sell-saved-outcomes';
const selection = { projectId: ref.projectId, mint: ref.mint };
function pageOf(count: number) {
  const page = autoSellOutcomePage(),
    original = page.intents[0];
  page.intents = Array.from({ length: count }, (_, n) => {
    const row = structuredClone(original);
    row.id = `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`;
    row.document.id = row.id;
    return row;
  });
  page.nextCursor = count === 50 ? page.intents.at(-1)!.id : null;
  return page;
}
it('projects detached saved status only without unsigned packet, receipt or execution authority', () => {
  const page = autoSellOutcomePage(),
    before = structuredClone(page),
    result = project(page, selection);
  expect(result.rows[0]).toMatchObject({
    intentId: ref.intentId,
    wallet: ref.wallet,
    state: 'submitted',
    inputRaw: ref.inputRaw,
    finalityVerified: false,
    signingAllowed: false,
    submissionAllowed: false,
  });
  expect(result).toMatchObject({
    scanned: 1,
    nextCursor: null,
    finalityVerified: false,
    signingAllowed: false,
    submissionAllowed: false,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.rows)).toBe(true);
  expect(Object.isFrozen(result.rows[0])).toBe(true);
  expect(JSON.stringify(result)).not.toContain('SYNTHETIC-UNSIGNED');
  expect(JSON.stringify(result)).not.toContain('transaction');
  expect(page).toEqual(before);
  page.intents[0].wallet = ref.mint;
  expect(result.rows[0].wallet).toBe(ref.wallet);
});
it.each([
  'awaiting_signature',
  'signed',
  'submitted',
  'cancelled',
  'failed',
  'finalized',
] as const)(
  'never treats saved %s status as finality or permission',
  (state) => {
    const page = autoSellOutcomePage();
    page.intents[0].state = state;
    if (state === 'awaiting_signature' || state === 'cancelled')
      page.intents[0].signature = null;
    expect(project(page, selection).rows[0]).toMatchObject({
      state,
      finalityVerified: false,
      signingAllowed: false,
      submissionAllowed: false,
    });
  },
);
it('distinguishes scanned records from matching rows, keeping pagination even on an empty filtered page', () => {
  const page = pageOf(50);
  page.intents.forEach((row) => {
    row.side = 'Buy';
    row.document.inputMint = ref.mint;
  });
  expect(project(page, selection)).toMatchObject({
    scanned: 50,
    rows: [],
    nextCursor: page.nextCursor,
  });
  const nonSol = autoSellOutcomePage();
  nonSol.intents[0].document.outputMint = ref.wallet;
  expect(project(nonSol, selection).rows).toEqual([]);
});
it.each([
  'project',
  'mint',
  'wallet',
  'zero',
  'overflow',
  'signature',
  'updated',
  'document',
  'state',
  'duplicate',
] as const)(
  'refuses malformed or foreign %s evidence before displaying it',
  (kind) => {
    const page = autoSellOutcomePage(),
      row = page.intents[0];
    if (kind === 'project') page.projectId = ref.preparationId;
    if (kind === 'mint') row.document.inputMint = ref.wallet;
    if (kind === 'wallet') {
      row.wallet = '<script>';
      row.document.wallet = row.wallet;
    }
    if (kind === 'zero') row.document.inputRaw = '0';
    if (kind === 'overflow') row.document.inputRaw = '18446744073709551616';
    if (kind === 'signature') row.signature = 'a'.repeat(82);
    if (kind === 'updated') row.updatedAt = 'bad-date';
    if (kind === 'document') row.document.preparationId = ref.intentId;
    if (kind === 'state') row.state = 'unrecognized';
    if (kind === 'duplicate') page.intents.push(structuredClone(row));
    expect(() => project(page, selection)).toThrow();
  },
);
it('binds an exact ID read to one original owned row and no cursor', () => {
  const page = autoSellOutcomePage();
  expect(
    project(page, { ...selection, intentId: ref.intentId }).rows,
  ).toHaveLength(1);
  expect(() =>
    project(page, { ...selection, intentId: ref.preparationId }),
  ).toThrow();
  expect(() =>
    project(page, {
      ...selection,
      intentId: ref.intentId,
      cursor: ref.preparationId,
    }),
  ).toThrow();
});
it.each(['Buy', 'non-SOL'] as const)(
  'keeps an exact %s approval lookup informational with no matching rows',
  (kind) => {
    const page = autoSellOutcomePage();
    if (kind === 'Buy') page.intents[0].side = 'Buy';
    else page.intents[0].document.outputMint = ref.wallet;
    expect(
      project(page, { ...selection, intentId: ref.intentId }),
    ).toMatchObject({ scanned: 1, rows: [], nextCursor: null });
  },
);
it.each(['short', 'last-row', 'same-cursor'] as const)(
  'refuses a non-progressing %s page cursor',
  (kind) => {
    const page = pageOf(kind === 'short' ? 1 : 50);
    if (kind !== 'same-cursor') page.nextCursor = ref.intentId;
    expect(() =>
      project(page, {
        ...selection,
        cursor: kind === 'same-cursor' ? page.nextCursor : null,
      }),
    ).toThrow();
  },
);
it('refuses a repeated anchor inside an otherwise progressing page', () => {
  const page = pageOf(50);
  expect(() =>
    project(page, { ...selection, cursor: page.intents[0].id }),
  ).toThrow();
});
it('turns an already locked body into a controlled read failure', async () => {
  const response = Response.json({});
  const reader = response.body!.getReader();
  try {
    await expect(read(response, new AbortController().signal)).rejects.toThrow(
      'Saved Sell history is unavailable',
    );
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
});
it.each(['project', 'mint', 'intent', 'cursor'] as const)(
  'refuses invalid %s selection',
  (kind) => {
    const changed = {
      ...selection,
      intentId: null as string | null,
      cursor: null as string | null,
    };
    if (kind === 'project') changed.projectId = 'not-a-project';
    if (kind === 'mint') changed.mint = 'https://example.invalid';
    if (kind === 'intent') changed.intentId = '../other';
    if (kind === 'cursor') changed.cursor = 'malformed';
    expect(() => autoSellSavedSelection(changed)).toThrow();
  },
);
it('reads real bounded JSON streams and never exposes parser diagnostics', async () => {
  expect(
    await read(
      Response.json(autoSellOutcomePage()),
      new AbortController().signal,
    ),
  ).toEqual(autoSellOutcomePage());
  await expect(
    read(
      new Response('<html>PRIVATE diagnostic</html>'),
      new AbortController().signal,
    ),
  ).rejects.toThrow('Saved Sell history is unavailable');
});
it.each(['declared', 'actual', 'utf8'] as const)(
  'refuses %s response violations and cancels the reader',
  async (kind) => {
    const cancel = vi.fn(),
      bytes =
        kind === 'utf8'
          ? new Uint8Array([0xc3, 0x28])
          : new Uint8Array(AUTO_SELL_SAVED_RESPONSE_BYTES + 1);
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
        },
        cancel,
      }),
      {
        headers:
          kind === 'declared' ? { 'content-length': String(bytes.length) } : {},
      },
    );
    await expect(
      read(response, new AbortController().signal),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  },
);
it('cancels a stalled response body on abort without waiting for more bytes', async () => {
  const cancel = vi.fn(),
    controller = new AbortController();
  const reading = read(
    new Response(new ReadableStream({ cancel })),
    controller.signal,
  );
  controller.abort();
  await expect(reading).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
});
it('decodes a UTF8 character split between chunks and cancels an already-aborted read', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ data: 'é' }));
  const at = bytes.indexOf(0xc3);
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, at + 1));
        controller.enqueue(bytes.slice(at + 1));
        controller.close();
      },
    }),
  );
  expect(await read(response, new AbortController().signal)).toEqual({
    data: 'é',
  });
  const cancel = vi.fn(),
    controller = new AbortController();
  controller.abort();
  await expect(
    read(new Response(new ReadableStream({ cancel })), controller.signal),
  ).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
});
it('controls an empty 204 response body', async () => {
  await expect(
    read(new Response(null, { status: 204 }), new AbortController().signal),
  ).rejects.toThrow('Saved Sell history is unavailable');
});
it('accepts the exact byte bound and rejects an over-bound UTF8 body even when its character count is smaller', async () => {
  const baseBytes = new TextEncoder().encode(
    JSON.stringify({ data: '' }),
  ).length;
  const available = AUTO_SELL_SAVED_RESPONSE_BYTES - baseBytes;
  const exact = {
    data: 'é'.repeat(Math.floor(available / 2)) + 'x'.repeat(available % 2),
  };
  const json = JSON.stringify(exact);
  expect(new TextEncoder().encode(json)).toHaveLength(
    AUTO_SELL_SAVED_RESPONSE_BYTES,
  );
  expect(await read(new Response(json), new AbortController().signal)).toEqual(
    exact,
  );
  const oversized = JSON.stringify({ data: exact.data + 'é' });
  expect(oversized.length).toBeLessThan(AUTO_SELL_SAVED_RESPONSE_BYTES);
  await expect(
    read(new Response(oversized), new AbortController().signal),
  ).rejects.toThrow();
});
