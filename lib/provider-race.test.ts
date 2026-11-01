import { expect, it, vi } from 'vitest';
import { RACE_PROVIDERS, raceSendTransaction } from './provider-race';

const base = {
  primary: 'https://primary.example',
  transaction: 'AQID',
  signature: 'Sig1',
  signal: new AbortController().signal,
};

it('without racing sends only to the primary RPC', async () => {
  const send = vi.fn().mockResolvedValue('Sig1');
  await expect(
    raceSendTransaction({ ...base, race: false, send }),
  ).resolves.toEqual({ signature: 'Sig1', endpoint: base.primary });
  expect(send).toHaveBeenCalledOnce();
});

it('racing sends identical bytes to every provider and accepts the first echo', async () => {
  const send = vi.fn(async (url: string, ..._rest: unknown[]) => {
    if (url === base.primary) throw new Error('down');
    return 'Sig1';
  });
  const out = await raceSendTransaction({ ...base, race: true, send });
  expect(out.signature).toBe('Sig1');
  expect(send).toHaveBeenCalledTimes(1 + RACE_PROVIDERS.length);
  for (const call of send.mock.calls) {
    expect(call[1]).toBe('sendTransaction');
    expect((call[2] as unknown[])[0]).toBe('AQID');
  }
});

it('rejects when no provider returns the exact signature', async () => {
  const send = vi.fn().mockResolvedValue('Other');
  await expect(
    raceSendTransaction({ ...base, race: true, send }),
  ).rejects.toBeInstanceOf(AggregateError);
});

it('does not send twice to the same endpoint', async () => {
  const send = vi.fn().mockResolvedValue('Sig1');
  await raceSendTransaction({
    ...base,
    primary: RACE_PROVIDERS[0],
    race: true,
    send,
  });
  expect(send).toHaveBeenCalledTimes(RACE_PROVIDERS.length);
});
