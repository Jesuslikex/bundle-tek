// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { WalletWarmupSessionV2 } from './wallet-warmup-session-v2';
import { warmupV2ClientFixture } from '@/test/warmup-session-v2-client-fixture';
let host: HTMLDivElement,
  root: Root,
  f: Awaited<ReturnType<typeof warmupV2ClientFixture>>,
  preview: Awaited<ReturnType<typeof f.preview>> | null,
  consent: ReturnType<typeof f.saved> | null,
  journal: Awaited<ReturnType<typeof f.journal>> | null,
  saveCount: number,
  controlCount: number,
  recordCount: number,
  lost: 'save' | 'control' | null,
  html: boolean;
const at = Date.parse('2026-10-21T12:00:00.000Z'),
  onBusy = () => {},
  key = () => 'bundle:warmup-v2:' + f.plan.id;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(at);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  sessionStorage.clear();
  f = await warmupV2ClientFixture(at);
  preview = null;
  consent = null;
  journal = null;
  saveCount = 0;
  controlCount = 0;
  recordCount = 0;
  lost = null;
  html = false;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (html)
        return new Response('<html>private parser details</html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        });
      const body = init?.body ? JSON.parse(init.body as string) : null;
      if (body?.operation === 'review') {
        preview = await f.preview(body.sessionExpiresAt);
        return Response.json(preview);
      }
      if (body?.operation === 'save') {
        saveCount++;
        expect(JSON.parse(sessionStorage.getItem(key())!).request.id).toBe(
          body.id,
        );
        consent = f.saved(body.id, preview!);
        if (lost === 'save') throw Error('Lost save response');
        return Response.json(consent);
      }
      if (body?.operation === 'record') {
        recordCount++;
        expect(JSON.parse(sessionStorage.getItem(key())!).request.id).toBe(
          body.id,
        );
        journal = await f.journal(body.id, consent!);
        return Response.json(journal);
      }
      if (body?.operation === 'control') {
        controlCount++;
        const marker = JSON.parse(sessionStorage.getItem(key())!);
        expect(
          (body.control === 'stop' && marker.stopRequest
            ? marker.stopRequest
            : marker.request
          ).id,
        ).toBe(body.id);
        journal = await f.control(journal!, body);
        if (lost === 'control') throw Error('Lost control response');
        return Response.json(journal);
      }
      if (url.includes('session-v2-consents'))
        return consent
          ? Response.json(consent)
          : Response.json({ error: 'not found' }, { status: 404 });
      if (url.includes('session-v2-journals'))
        return journal
          ? Response.json(journal)
          : Response.json({ error: 'not found' }, { status: 404 });
      throw Error('Unexpected endpoint');
    }),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const button = (name: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent === name)!;
async function done(check: () => void) {
  let error: unknown;
  for (let i = 0; i < 100; i++) {
    try {
      check();
      return;
    } catch (e) {
      error = e;
    }
    await act(async () => {
      await new Promise<void>((resolve) => nextTurn(resolve));
    });
  }
  throw error;
}
async function mount() {
  await act(async () =>
    root.render(
      <WalletWarmupSessionV2
        plan={f.plan}
        view={f.view}
        retained={f.retained}
        onBusyChange={onBusy}
      />,
    ),
  );
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function check(label: string) {
  const found = [...host.querySelectorAll('label')].find((l) =>
    l.textContent?.includes(label),
  );
  const input = found?.querySelector('input');
  if (!input) throw Error('Missing checkbox ' + label);
  await act(async () => input.click());
}
async function approve() {
  await click('Review session plan');
  await done(() => expect(host.textContent).toContain('finite read policy'));
  await check('I approve this exact plan');
  await click('Save session approval');
  await done(() =>
    expect(host.textContent).toContain('Plan approved · no trades running'),
  );
}
async function record() {
  await check('Record recoverable history');
  await click('Record session history');
  await done(() => expect(host.textContent).toContain('Saved progress:'));
}
it('requires separate unchecked approvals and displays saved state without claiming execution', async () => {
  await mount();
  expect(fetch).not.toHaveBeenCalled();
  expect(button('Review session plan').disabled).toBe(false);
  await click('Review session plan');
  await done(() => expect(host.textContent).toContain('finite read policy'));
  expect(button('Save session approval').disabled).toBe(true);
  await check('I approve this exact plan');
  await click('Save session approval');
  await done(() =>
    expect(host.textContent).toContain('Plan approved · no trades running'),
  );
  expect(button('Record session history').disabled).toBe(true);
  await record();
  expect(button('Review next action').disabled).toBe(true);
  await check('Apply the control I choose');
  await click('Review next action');
  await done(() => expect(host.textContent).toContain('Pending review: Buy'));
  expect(button('Stop session review').disabled).toBe(true);
  await check('Apply the control I choose');
  await click('Pause session review');
  await done(() =>
    expect(host.textContent).toContain('Saved progress: paused'),
  );
  await check('Apply the control I choose');
  await click('Stop session review');
  await done(() =>
    expect(host.textContent).toContain('Saved progress: stopped'),
  );
  expect(host.textContent).toContain('Pending review: Buy');
  expect(host.textContent).toContain('0 of');
  expect(saveCount).toBe(1);
  expect(recordCount).toBe(1);
  expect(controlCount).toBe(3);
  expect(host.querySelector('input[type="password"]')).toBeNull();
  expect(document.activeElement?.textContent).toContain(
    'Saved progress: stopped',
  );
});
it('recovers a committed save after a lost response using its original ID and no second POST', async () => {
  await mount();
  await click('Review session plan');
  await done(() => expect(host.textContent).toContain('finite read policy'));
  await check('I approve this exact plan');
  lost = 'save';
  await click('Save session approval');
  await done(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(saveCount).toBe(1);
  expect(JSON.parse(sessionStorage.getItem(key())!).request.kind).toBe(
    'consent',
  );
  await click('Recover saved approval');
  await done(() =>
    expect(host.textContent).toContain('Plan approved · no trades running'),
  );
  expect(saveCount).toBe(1);
  expect(JSON.parse(sessionStorage.getItem(key())!).request).toBeNull();
});
it('recovers a committed control after reopening without mount requests or repeating the control', async () => {
  await mount();
  await approve();
  await record();
  lost = 'control';
  await check('Apply the control I choose');
  await click('Review next action');
  await done(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(controlCount).toBe(1);
  const original = JSON.parse(sessionStorage.getItem(key())!);
  await act(async () => root.unmount());
  root = createRoot(host);
  const calls = vi.mocked(fetch).mock.calls.length;
  await mount();
  expect(vi.mocked(fetch).mock.calls.length).toBe(calls);
  await click('Recover saved approval');
  await done(() =>
    expect(host.textContent).toContain('Plan approved · no trades running'),
  );
  expect(button('Record session history')).toBeUndefined();
  await click('Recover saved history');
  await done(() => expect(host.textContent).toContain('Pending review: Buy'));
  expect(controlCount).toBe(1);
  expect(JSON.parse(sessionStorage.getItem(key())!).journalId).toBe(
    original.journalId,
  );
});
it('keeps late history recoverable while expired sessions disable new review but retain Stop', async () => {
  await mount();
  await approve();
  await record();
  await act(async () => {
    vi.setSystemTime(Date.parse(f.finish) + 1);
    vi.advanceTimersByTime(1000);
  });
  await check('Apply the control I choose');
  expect(button('Review next action').disabled).toBe(true);
  expect(button('Stop session review').disabled).toBe(false);
  await click('Stop session review');
  await done(() =>
    expect(host.textContent).toContain('Saved progress: stopped'),
  );
});
it('invalidates terms on receipt changes and never displays HTML parser text', async () => {
  await mount();
  await click('Review session plan');
  await done(() => expect(host.textContent).toContain('finite read policy'));
  await check('I approve this exact plan');
  await act(async () =>
    window.dispatchEvent(
      new CustomEvent('bundle:warmup-receipt-saved', {
        detail: { planId: f.plan.id },
      }),
    ),
  );
  // Use a storage event too, covering cross-tab invalidation independently of the event name.
  await act(async () => window.dispatchEvent(new Event('storage')));
  expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  expect(saveCount).toBe(0);
  await act(async () => root.unmount());
  root = createRoot(host);
  html = true;
  await mount();
  await click('Review session plan');
  await done(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(host.textContent).not.toContain('private parser details');
});
it('blocks replacement writes when another tab changed the local reminder', async () => {
  await mount();
  await click('Review session plan');
  await done(() => expect(host.textContent).toContain('finite read policy'));
  await check('I approve this exact plan');
  sessionStorage.setItem(key(), 'another-tab');
  await click('Save session approval');
  await done(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(saveCount).toBe(0);
  expect(sessionStorage.getItem(key())).toBe('another-tab');
});
it.each([409, 408])(
  'recovers an existing consent from a verified %s hint without issuing another save',
  async (status) => {
    await mount();
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const body = init?.body ? JSON.parse(init.body as string) : null;
      if (body?.operation === 'save') {
        saveCount++;
        consent = f.saved(crypto.randomUUID(), preview!);
        return Response.json(
          { error: 'Already saved', recoveryId: consent.consent.id },
          { status },
        );
      }
      return original(input, init);
    });
    await click('Review session plan');
    await done(() => expect(host.textContent).toContain('finite read policy'));
    await check('I approve this exact plan');
    await click('Save session approval');
    await done(() => expect(button('Recover existing approval')).toBeDefined());
    await click('Recover existing approval');
    await done(() =>
      expect(host.textContent).toContain('Plan approved · no trades running'),
    );
    expect(saveCount).toBe(1);
    expect(JSON.parse(sessionStorage.getItem(key())!).consentId).toBe(
      consent!.consent.id,
    );
  },
);
it('recovers an existing history from a conflict hint with exact consent binding', async () => {
  await mount();
  await approve();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (body?.operation === 'record') {
      recordCount++;
      journal = await f.journal(crypto.randomUUID(), consent!);
      return Response.json(
        { error: 'Already saved', recoveryId: journal.journal.id },
        { status: 409 },
      );
    }
    return original(input, init);
  });
  await check('Record recoverable history');
  await click('Record session history');
  await done(() =>
    expect(button('Recover existing session history')).toBeDefined(),
  );
  await click('Recover existing session history');
  await done(() => expect(host.textContent).toContain('Saved progress:'));
  expect(recordCount).toBe(1);
  expect(JSON.parse(sessionStorage.getItem(key())!).journalId).toBe(
    journal!.journal.id,
  );
});
it('recovers a newer head after proving an uncertain control cannot still commit', async () => {
  await mount();
  await approve();
  await record();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (body?.operation === 'control') {
      controlCount++;
      journal = await f.control(journal!, {
        id: crypto.randomUUID(),
        control: 'pause',
      });
      return Response.json({ error: 'Head advanced' }, { status: 409 });
    }
    if (
      (typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url
      ).includes('eventId=')
    ) {
      const result = structuredClone(journal!);
      result.journal.commandReceipt = null;
      return Response.json(result);
    }
    return original(input, init);
  });
  await check('Apply the control I choose');
  await click('Review next action');
  await done(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  await click('Recover session history');
  await done(() =>
    expect(host.textContent).toContain('its predecessor has advanced'),
  );
  expect(controlCount).toBe(1);
  expect(JSON.parse(sessionStorage.getItem(key())!).request).toBeNull();
  expect(button('Stop session review').disabled).toBe(true);
});
it('does not retire an absent control while its exact predecessor is still current', async () => {
  await mount();
  await approve();
  await record();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (body?.operation === 'control') {
      controlCount++;
      throw Error('Unknown transport failure');
    }
    return original(input, init);
  });
  await check('Apply the control I choose');
  await click('Review next action');
  await done(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  await click('Recover session history');
  await done(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  expect(JSON.parse(sessionStorage.getItem(key())!).request.kind).toBe(
    'control',
  );
  expect(controlCount).toBe(1);
  expect(button('Stop session review').disabled).toBe(true);
});
it('allows separately approved Stop after an original control never reached the server', async () => {
  await mount();
  await approve();
  await record();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (body?.operation === 'control' && body.control !== 'stop') {
      controlCount++;
      throw Error('Lost before server');
    }
    return original(input, init);
  });
  await check('Apply the control I choose');
  await click('Review next action');
  await done(() =>
    expect(button('Record Stop for pending state')).toBeDefined(),
  );
  expect(button('Record Stop for pending state').disabled).toBe(true);
  const pending = JSON.parse(sessionStorage.getItem(key())!);
  await check('I request Stop against the original pending state');
  await click('Record Stop for pending state');
  await done(() =>
    expect(host.textContent).toContain('Saved progress: stopped'),
  );
  expect(journal!.journal.commandReceipt!.previousSha256).toBe(
    pending.request.headSha256,
  );
  expect(journal!.journal.version).toBe(pending.request.version + 1);
  expect(controlCount).toBe(2);
  expect(JSON.parse(sessionStorage.getItem(key())!).request).toBeNull();
});
it('explicit pending Stop retries preserve both IDs and use the same Stop ID until confirmation', async () => {
  await mount();
  await approve();
  await record();
  const original = vi.mocked(fetch).getMockImplementation()!;
  let dropped = false;
  const stopIds: string[] = [];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (body?.operation === 'control') {
      if (body.control !== 'stop') {
        controlCount++;
        throw Error('Never delivered');
      }
      stopIds.push(body.id);
      if (!dropped) {
        dropped = true;
        controlCount++;
        throw Error('Stop not delivered');
      }
    }
    return original(input, init);
  });
  await check('Apply the control I choose');
  await click('Review next action');
  await done(() =>
    expect(button('Record Stop for pending state')).toBeDefined(),
  );
  const requestId = JSON.parse(sessionStorage.getItem(key())!).request.id;
  await check('I request Stop against the original pending state');
  await click('Record Stop for pending state');
  await done(() =>
    expect(button('Retry same pending Stop request')).toBeDefined(),
  );
  const retained = JSON.parse(sessionStorage.getItem(key())!);
  expect(retained.request.id).toBe(requestId);
  expect(retained.stopRequest.id).not.toBe(requestId);
  await check('I request Stop against the original pending state');
  await click('Retry same pending Stop request');
  await done(() =>
    expect(host.textContent).toContain('Saved progress: stopped'),
  );
  expect(new Set(stopIds).size).toBe(1);
  expect(journal!.journal.version).toBe(1);
});
it('archives a missing passive approval without claiming cancellation and restores its original IDs', async () => {
  await mount();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (body?.operation === 'save') {
      saveCount++;
      throw Error('Never received');
    }
    return original(input, init);
  });
  await click('Review session plan');
  await done(() => expect(host.textContent).toContain('finite read policy'));
  await check('I approve this exact plan');
  await click('Save session approval');
  await done(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  const raw = sessionStorage.getItem(key());
  expect(button('Keep reminder and reset panel').disabled).toBe(true);
  await click('Recover saved approval');
  await done(() =>
    expect(host.textContent).toContain('not found for this account'),
  );
  await check('I kept my recovery information');
  await click('Keep reminder and reset panel');
  expect(sessionStorage.getItem(key())).toBeNull();
  expect(host.textContent).toContain('uncertain outcome are unchanged');
  expect(saveCount).toBe(1);
  await click('Restore saved reminder 1');
  expect(sessionStorage.getItem(key())).toBe(raw);
  expect(saveCount).toBe(1);
  expect(host.textContent).toContain('nothing was resubmitted');
});
it('preserves an unreadable reminder locally before resetting the panel', async () => {
  sessionStorage.setItem(key(), 'unreadable-public-metadata');
  await mount();
  await done(() =>
    expect(host.textContent).toContain('reminder is unreadable'),
  );
  await check('I kept my recovery information');
  await click('Keep reminder and reset panel');
  expect(sessionStorage.getItem(key())).toBeNull();
  const backup = Object.keys(sessionStorage).find((k) =>
    k.startsWith(key() + ':archive:'),
  )!;
  expect(sessionStorage.getItem(backup)).toBe('unreadable-public-metadata');
  expect(fetch).not.toHaveBeenCalled();
});
it('recovers an existing same-review approval with a different saved finish buffer', async () => {
  await mount();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (body?.operation === 'save') {
      saveCount++;
      const alternate = await f.preview(
        new Date(Date.parse(body.sessionExpiresAt) + 120000).toISOString(),
      );
      consent = f.saved(crypto.randomUUID(), alternate);
      return Response.json(
        { error: 'Already saved', recoveryId: consent.consent.id },
        { status: 409 },
      );
    }
    return original(input, init);
  });
  await click('Review session plan');
  await done(() => expect(host.textContent).toContain('finite read policy'));
  await check('I approve this exact plan');
  await click('Save session approval');
  await done(() => expect(button('Recover existing approval')).toBeDefined());
  await click('Recover existing approval');
  await done(() =>
    expect(host.textContent).toContain('Plan approved · no trades running'),
  );
  expect(JSON.parse(sessionStorage.getItem(key())!).termsSha256).toBe(
    consent!.consent.termsSha256,
  );
  expect(saveCount).toBe(1);
});
it('ignores unrelated storage changes and fails before retaining an ID on unsupported browsers', async () => {
  await mount();
  await act(async () =>
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'unrelated-theme' }),
    ),
  );
  expect(button('Review session plan').disabled).toBe(false);
  vi.stubGlobal('AbortSignal', class {});
  await click('Review session plan');
  expect(host.textContent).toContain('Update your browser');
  expect(sessionStorage.getItem(key())).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
it('can review the original due action after capture expiry without renewing the approved finish', async () => {
  await mount();
  await approve();
  await record();
  const finish = consent!.consent.terms.sessionExpiresAt;
  await act(async () => {
    vi.setSystemTime(at + 61000);
    vi.advanceTimersByTime(1000);
  });
  await check('Apply the control I choose');
  expect(button('Review next action').disabled).toBe(false);
  await click('Review next action');
  await done(() => expect(host.textContent).toContain('Pending review: Buy'));
  expect(consent!.consent.terms.sessionExpiresAt).toBe(finish);
  expect(controlCount).toBe(1);
});
it('recovers a Stop that committed before its reply was lost with GET only', async () => {
  await mount();
  await approve();
  await record();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (body?.operation === 'control' && body.control !== 'stop') {
      controlCount++;
      throw Error('Not delivered');
    }
    return original(input, init);
  });
  await check('Apply the control I choose');
  await click('Review next action');
  await done(() =>
    expect(button('Record Stop for pending state')).toBeDefined(),
  );
  lost = 'control';
  await check('I request Stop against the original pending state');
  await click('Record Stop for pending state');
  await done(() =>
    expect(button('Retry same pending Stop request')).toBeDefined(),
  );
  expect(journal!.journal.snapshot.stopped).toBe(true);
  const writes = controlCount;
  await click('Recover session history');
  await done(() =>
    expect(host.textContent).toContain('Saved progress: stopped'),
  );
  expect(controlCount).toBe(writes);
  expect(JSON.parse(sessionStorage.getItem(key())!).request).toBeNull();
});
it('reports that Stop lost the race without falsely claiming the original control failed', async () => {
  await mount();
  await approve();
  await record();
  lost = 'control';
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (body?.operation === 'control' && body.control === 'stop') {
      controlCount++;
      return Response.json({ error: 'Head consumed' }, { status: 409 });
    }
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes('eventId=') && journal) {
      const next = structuredClone(journal);
      next.journal.commandReceipt = null;
      return Response.json(next);
    }
    return original(input, init);
  });
  await check('Apply the control I choose');
  await click('Review next action');
  await done(() =>
    expect(button('Record Stop for pending state')).toBeDefined(),
  );
  await check('I request Stop against the original pending state');
  await click('Record Stop for pending state');
  await done(() =>
    expect(button('Retry same pending Stop request')).toBeDefined(),
  );
  await click('Recover session history');
  await done(() => expect(host.textContent).toContain('Stop was not recorded'));
  expect(host.textContent).toContain('Pending review: Buy');
  expect(host.textContent).not.toContain(
    'The earlier control was not recorded',
  );
  expect(controlCount).toBe(2);
  expect(JSON.parse(sessionStorage.getItem(key())!).request).toBeNull();
});
it('requires recovered status before archiving a confirmed journal after reopening', async () => {
  await mount();
  await approve();
  await record();
  await check('Apply the control I choose');
  await click('Review next action');
  await done(() => expect(host.textContent).toContain('Pending review: Buy'));
  await act(async () => root.unmount());
  root = createRoot(host);
  await mount();
  await done(() =>
    expect(button('Keep reminder and reset panel')).toBeDefined(),
  );
  expect(button('Keep reminder and reset panel').disabled).toBe(true);
  const input = [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.includes('I kept my recovery information'))!
    .querySelector('input')!;
  expect(input.disabled).toBe(true);
  await click('Recover saved approval');
  await done(() =>
    expect(host.textContent).toContain('Plan approved · no trades running'),
  );
  await click('Recover session history');
  await done(() => expect(host.textContent).toContain('Pending review: Buy'));
  expect(input.disabled).toBe(true);
  await act(async () => {
    vi.setSystemTime(Date.parse(f.finish) + 60000);
    vi.advanceTimersByTime(1000);
  });
  // Client clock expiry alone does not prove the recovered server review expired.
  expect(input.disabled).toBe(true);
  await check('Apply the control I choose');
  await click('Stop session review');
  await done(() =>
    expect(host.textContent).toContain('Saved progress: stopped'),
  );
  expect(input.disabled).toBe(false);
});
it('does not treat an approval GET failure as absence of a pending history ID', async () => {
  await mount();
  await approve();
  const original = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const body = init?.body ? JSON.parse(init.body as string) : null,
      url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
    if (body?.operation === 'record') {
      recordCount++;
      throw Error('Never delivered');
    }
    if (!body && url.includes('session-v2-consents'))
      return Response.json(
        { error: 'No approval for this account' },
        { status: 404 },
      );
    return original(input, init);
  });
  await check('Record recoverable history');
  await click('Record session history');
  await done(() => expect(host.querySelector('[role="alert"]')).not.toBeNull());
  await click('Recover saved approval');
  await done(() =>
    expect(host.textContent).toContain('not found for this account'),
  );
  const checkbox = [...host.querySelectorAll('label')]
    .find((l) => l.textContent?.includes('I kept my recovery information'))!
    .querySelector('input')!;
  expect(checkbox.disabled).toBe(true);
  await click('Recover session history');
  await done(() => expect(checkbox.disabled).toBe(false));
  expect(recordCount).toBe(1);
});
it('preserves larger unreadable reminders and moves restored archives without accumulating duplicate slots', async () => {
  const marker = {
    format: 'wallet-warmup-v2-reminder-v1',
    planId: f.plan.id,
    consentId: f.consent.consent.id,
    termsSha256: f.consent.consent.termsSha256,
    journalId: null,
    request: null,
  };
  for (let i = 0; i < 26; i++)
    sessionStorage.setItem(
      key() + ':archive:' + i,
      JSON.stringify({ ...marker, consentId: crypto.randomUUID() }),
    );
  const raw = 'invalid-public-metadata'.repeat(2000);
  sessionStorage.setItem(key(), raw);
  await mount();
  await done(() =>
    expect(host.textContent).toContain('reminder is unreadable'),
  );
  await check('I kept my recovery information');
  await click('Keep reminder and reset panel');
  const keys = () =>
    Object.keys(sessionStorage).filter((k) =>
      k.startsWith(key() + ':archive:'),
    );
  expect(keys()).toHaveLength(27);
  expect(keys().some((k) => sessionStorage.getItem(k) === raw)).toBe(true);
  expect(button('Next reminders').disabled).toBe(false);
  await click('Restore saved reminder 1');
  expect(keys()).toHaveLength(26);
  expect(sessionStorage.getItem(key())).not.toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
