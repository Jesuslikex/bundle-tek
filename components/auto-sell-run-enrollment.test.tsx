// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { profileProject, savedProfile } from '@/test/auto-sell-profile-fixture';
import { webcrypto } from 'node:crypto';
const state = vi.hoisted(() => ({
  owner: 'owner' as string | null,
  pending: false,
  reminder: null as unknown,
  load: vi.fn(),
  review: vi.fn(),
  record: vi.fn(),
  recover: vi.fn(),
  capability: vi.fn(),
  stop: vi.fn(),
  recoverStop: vi.fn(),
}));
vi.mock('better-auth/react', () => ({
  createAuthClient: () => ({
    useSession: () => ({
      data: state.owner ? { user: { id: state.owner } } : null,
      isPending: state.pending,
    }),
  }),
}));
vi.mock('@/lib/auto-sell-run-enrollment-client', () => ({
  autoSellRunEnrollmentScope: async (owner: string) =>
    owner === 'owner' ? 'a'.repeat(64) : 'b'.repeat(64),
  loadAutoSellRunEnrollmentReminder: (...args: unknown[]) => {
    state.load(...args);
    return state.reminder;
  },
  reviewAutoSellRunEnrollmentProfile: (...args: unknown[]) =>
    state.review(...args),
  recordAutoSellRunEnrollment: (...args: unknown[]) => state.record(...args),
  recoverAutoSellRunEnrollment: (...args: unknown[]) => state.recover(...args),
}));
vi.mock('@/lib/auto-sell-run-record-stop-client', () => ({
  loadAutoSellRunRecordStopCapability: (...args: unknown[]) =>
    state.capability(...args),
  stopAutoSellRunRecord: (...args: unknown[]) => state.stop(...args),
  recoverAutoSellRunRecordStop: (...args: unknown[]) =>
    state.recoverStop(...args),
  AutoSellRunRecordStopNotFoundError: class extends Error {},
}));
import { AutoSellRunRecordStopNotFoundError } from '@/lib/auto-sell-run-record-stop-client';
import { AutoSellRunEnrollment } from './auto-sell-run-enrollment';
let host: HTMLDivElement,
  root: Root,
  props: Parameters<typeof AutoSellRunEnrollment>[0];
let profile: Awaited<ReturnType<typeof savedProfile>>;
const runId = '30000000-0000-4000-8000-000000000001';
function marker() {
  return {
    format: 'auto-sell-run-enrollment-v1',
    ownerScope: 'a'.repeat(64),
    projectId: profileProject.id,
    runId,
    profileSaveId: profile.id,
    profileSha256: profile.sha256,
  };
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('crypto', webcrypto);
  state.owner = 'owner';
  state.pending = false;
  state.reminder = null;
  for (const fn of [
    state.load,
    state.review,
    state.record,
    state.recover,
    state.capability,
    state.stop,
    state.recoverStop,
  ])
    fn.mockReset();
  profile = await savedProfile();
  state.review.mockResolvedValue(profile);
  state.capability.mockResolvedValue(undefined);
  state.recoverStop.mockRejectedValue(new AutoSellRunRecordStopNotFoundError());
  state.record.mockRejectedValue(new Error('Original request is unknown.'));
  props = {
    project: structuredClone(profileProject),
    profile,
    disabled: false,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () => root.render(<AutoSellRunEnrollment {...props} />));
}
async function open() {
  await render();
  await act(async () => {
    const d = host.querySelector('details')!;
    d.open = true;
    d.dispatchEvent(new Event('toggle', { bubbles: true }));
  });
}
function button(name: string) {
  const b = [...host.querySelectorAll('button')].find(
    (x) => x.textContent?.trim() === name,
  );
  if (!b) throw Error('Missing ' + name);
  return b;
}
async function click(name: string) {
  await act(async () => button(name).click());
}
async function approve() {
  const section = host.querySelector(
    '[aria-label="Exact journal recording review"]',
  )!;
  const check = section.querySelector<HTMLInputElement>(
    'input[type=checkbox]',
  )!;
  await act(async () => check.click());
}
it('does no identity, history or record work while collapsed', async () => {
  await render();
  expect(state.load).not.toHaveBeenCalled();
  expect(state.review).not.toHaveBeenCalled();
  expect(state.record).not.toHaveBeenCalled();
});
it('opening only loads local metadata; explicit review is required', async () => {
  await open();
  expect(state.load).toHaveBeenCalled();
  expect(state.review).not.toHaveBeenCalled();
  expect(state.record).not.toHaveBeenCalled();
  await click('Review saved configuration for journal');
  expect(state.review).toHaveBeenCalledOnce();
  expect(button('Record journal only').disabled).toBe(true);
});
it('requires separate unchecked consent and records only exact saved configuration', async () => {
  await open();
  await click('Review saved configuration for journal');
  expect(host.querySelector<HTMLInputElement>('input')!.checked).toBe(false);
  await approve();
  await click('Record journal only');
  expect(state.record).toHaveBeenCalledOnce();
  expect(state.record.mock.calls[0][0]).toMatchObject({
    profile,
    approved: true,
    mode: 'new',
    profileSaveId: profile.id,
    profileSha256: profile.sha256,
  });
  expect(host.textContent).toContain('Original request is unknown.');
});
it('keeps the original run ID across retry review and record', async () => {
  state.reminder = marker();
  await open();
  expect(button('Review saved configuration for journal').disabled).toBe(true);
  await click('Review original request for retry');
  expect(state.review.mock.calls[0][0]).toMatchObject({ runId });
  await approve();
  await click('Retry original journal record');
  expect(state.record.mock.calls[0][0]).toMatchObject({ mode: 'retry', runId });
});
it('does not replace the captured retry ID with a later local marker', async () => {
  state.reminder = marker();
  await open();
  await click('Review original request for retry');
  state.reminder = {
    ...marker(),
    runId: '30000000-0000-4000-8000-000000000002',
  };
  await approve();
  await click('Retry original journal record');
  expect(state.record.mock.calls[0][0].runId).toBe(runId);
});
it('does not use profile Restore consent as journal consent', async () => {
  await open();
  await click('Review saved configuration for journal');
  await click('Record journal only');
  expect(state.record).not.toHaveBeenCalled();
});
it('removes review and consent on project revision change', async () => {
  await open();
  await click('Review saved configuration for journal');
  await approve();
  props = { ...props, project: { ...props.project, revision: 2 } };
  await render();
  expect(host.querySelector('input')).toBeNull();
  expect(button('Review saved configuration for journal').disabled).toBe(true);
});
it('removes review and consent on identity uncertainty', async () => {
  await open();
  await click('Review saved configuration for journal');
  await approve();
  state.pending = true;
  await render();
  expect(host.querySelector('input')).toBeNull();
  expect(host.textContent).toContain('Checking sign-in');
});
it('does not show the prior owner reminder after account change', async () => {
  state.reminder = marker();
  await open();
  state.reminder = null;
  state.owner = 'other';
  await render();
  expect(host.textContent).not.toContain(runId);
  expect(state.load.mock.calls.at(-1)?.[0]).toBe('b'.repeat(64));
});
it('aborts a pending review on disclosure close and ignores a late result', async () => {
  let resolve!: (p: typeof profile) => void;
  state.review.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  await open();
  await click('Review saved configuration for journal');
  const signal = state.review.mock.calls[0][1] as AbortSignal;
  await act(async () => {
    const d = host.querySelector('details')!;
    d.open = false;
    d.dispatchEvent(new Event('toggle', { bubbles: true }));
  });
  expect(signal.aborted).toBe(true);
  await act(async () => resolve(profile));
  expect(host.querySelector('input')).toBeNull();
});
it('stops waiting without clearing or retrying the original request', async () => {
  state.reminder = marker();
  state.recover.mockImplementation(() => new Promise(() => {}));
  await open();
  await click('Check original journal record');
  const signal = state.recover.mock.calls[0][1] as AbortSignal;
  await click('Stop waiting');
  expect(signal.aborted).toBe(true);
  expect(host.textContent).toContain(runId);
  expect(state.record).not.toHaveBeenCalled();
});
it('allows original read recovery while archived but blocks write retries', async () => {
  props.project.archived = true;
  state.reminder = marker();
  state.recover.mockRejectedValue(new Error('Not found; retain original ID.'));
  await open();
  expect(button('Review original request for retry').disabled).toBe(true);
  await click('Check original journal record');
  expect(state.recover).toHaveBeenCalledOnce();
  expect(host.textContent).toContain(runId);
});
it('blocks writes on damaged browser metadata while keeping safe history guidance', async () => {
  state.load.mockImplementation(() => {
    throw Error('bad storage');
  });
  await open();
  expect(button('Review saved configuration for journal').disabled).toBe(true);
  expect(host.textContent).toContain(
    'Browser recovery storage is unavailable or damaged',
  );
  expect(state.record).not.toHaveBeenCalled();
});
it('shows sign-in without requesting a profile or record', async () => {
  state.owner = null;
  await open();
  expect(host.querySelector('a')?.getAttribute('href')).toBe('/sign-in');
  expect(state.review).not.toHaveBeenCalled();
  expect(state.record).not.toHaveBeenCalled();
});
it('checks server fence readiness before any create request', async () => {
  state.capability.mockRejectedValue(
    new Error('Record recovery schema unavailable.'),
  );
  await open();
  await click('Review saved configuration for journal');
  await approve();
  await click('Record journal only');
  expect(state.capability).toHaveBeenCalledOnce();
  expect(state.record).not.toHaveBeenCalled();
  expect(host.textContent).toContain('Record recovery schema unavailable.');
});
it('requires separate stop consent and does not reuse record approval', async () => {
  state.reminder = marker();
  state.stop.mockRejectedValue(new Error('Stop result unknown.'));
  await open();
  expect(button('Stop original recording request').disabled).toBe(true);
  await click('Stop original recording request');
  expect(state.stop).not.toHaveBeenCalled();
  const check = host.querySelector<HTMLInputElement>(
    '[aria-label="Original journal request recovery"] input',
  )!;
  await act(async () => check.click());
  await click('Stop original recording request');
  expect(state.stop.mock.calls[0][0]).toEqual({
    reminder: marker(),
    approved: true,
  });
  expect(host.textContent).toContain(runId);
  expect(check.checked).toBe(false);
  expect(state.record).not.toHaveBeenCalled();
});
it('never falls back from an ambiguous stop read or clears its original reminder', async () => {
  state.reminder = marker();
  state.recoverStop.mockRejectedValue(
    new Error('Unverified terminal receipt.'),
  );
  await open();
  await click('Check original journal record');
  expect(state.recover).not.toHaveBeenCalled();
  expect(host.textContent).toContain(runId);
  expect(host.textContent).toContain('Unverified terminal receipt.');
});
it('shows a confirmed fence while preserving any existing run and original request identity', async () => {
  state.reminder = marker();
  state.recoverStop.mockImplementation(async () => {
    state.reminder = null;
    return {
      reminder: marker(),
      reminderRetained: false,
      run: null,
      stop: {
        status: 'creation-fenced',
        runId,
        createdAt: '2026-10-25T00:00:00.000Z',
        requestSha256: 'c'.repeat(64),
      },
    };
  });
  await open();
  await click('Check original journal record');
  expect(state.recover).not.toHaveBeenCalled();
  expect(host.textContent).toContain(
    'A delayed creation request for this ID is now refused.',
  );
  expect(host.textContent).toContain(runId);
  expect(button('Review saved configuration for journal').disabled).toBe(false);
  expect(state.record).not.toHaveBeenCalled();
});
