import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_LAUNCH_PLAN } from './launch-plan';
import {
  DEFAULT_VENUE_OPTIONS,
  EMPTY_IDENTITY,
  validateProjectDocument,
} from './workspace-project';
import { PANEL_JSON_RESPONSE_BYTES } from './read-bounded-panel-json';
import {
  OwnedProjectReadError,
  readOwnedProjectResponse,
  validateOwnedProjectResponse,
} from './owned-project-read';

const project = () => ({
  id: 'old-project',
  archived: false,
  updatedAt: '2026-10-01T00:00:00.000Z',
  plan: { ...DEFAULT_LAUNCH_PLAN },
  identity: { ...EMPTY_IDENTITY },
  options: { ...DEFAULT_VENUE_OPTIONS },
});
const signal = () => new AbortController().signal;
afterEach(() => vi.restoreAllMocks());
it('returns the canonical current document and admits archived projects without restoring them', () => {
  const p = { ...project(), archived: true };
  expect(validateOwnedProjectResponse({ project: p }, p.id)).toEqual({
    ...validateProjectDocument(p),
    id: p.id,
    archived: true,
    updatedAt: p.updatedAt,
  });
});
it.each([
  null,
  [],
  {},
  { project: null },
  { project: [] },
  { project: project(), owner: 'bob' },
  { project: { ...project(), owner_id: 'bob' } },
  { project: { ...project(), id: 'another-project' } },
  { project: { ...project(), id: '../wrong' } },
  { project: { ...project(), archived: 1 } },
  { project: { ...project(), updatedAt: '2026-10-01T00:00:00Z' } },
  { project: { ...project(), updatedAt: '2026-02-30T00:00:00.000Z' } },
  { project: { ...project(), updatedAt: 'garbage' } },
  {
    project: {
      ...project(),
      options: { ...DEFAULT_VENUE_OPTIONS, totalSupply: 'SECRET_BAD_VALUE' },
    },
  },
  { project: { ...project(), identity: { website: 'file:///SECRET_PATH' } } },
])(
  'rejects wrong shape, binding or corrupt data without exposing parser text %#',
  (value) => {
    expect(() => validateOwnedProjectResponse(value, 'old-project')).toThrow(
      OwnedProjectReadError,
    );
    expect(() => validateOwnedProjectResponse(value, 'old-project')).toThrow(
      'Saved project is unavailable. Refresh and try again.',
    );
  },
);
it('requires an exact envelope and does not accept hidden symbol additions', () => {
  const value = { project: project(), [Symbol('authority')]: true };
  expect(() => validateOwnedProjectResponse(value, 'old-project')).toThrow(
    OwnedProjectReadError,
  );
});
it('refuses malformed expected IDs', () => {
  expect(() =>
    validateOwnedProjectResponse({ project: project() }, '../bad'),
  ).toThrow('Invalid saved project request.');
});
it('does not grant extra stored nested fields authority', () => {
  const p = {
    ...project(),
    identity: { ...EMPTY_IDENTITY, secret: 'discard' },
    options: { ...DEFAULT_VENUE_OPTIONS, signingAllowed: true },
  };
  expect(
    JSON.stringify(validateOwnedProjectResponse({ project: p }, p.id)),
  ).not.toMatch(/discard|signingAllowed/);
});
it('rejects non-enumerable additions to the exact envelope and project', () => {
  const envelope = Object.defineProperty({ project: project() }, 'hidden', {
    value: true,
  });
  const p = Object.defineProperty(project(), 'hidden', { value: true });
  expect(() => validateOwnedProjectResponse(envelope, 'old-project')).toThrow(
    OwnedProjectReadError,
  );
  expect(() =>
    validateOwnedProjectResponse({ project: p }, 'old-project'),
  ).toThrow(OwnedProjectReadError);
});
it('rejects accessor envelope/project fields without invoking them', () => {
  const getter = vi.fn(() => project());
  const envelope = Object.defineProperty({}, 'project', {
    get: getter,
    enumerable: true,
  });
  const p = Object.defineProperty(project(), 'id', {
    get: getter,
    enumerable: true,
  });
  expect(() => validateOwnedProjectResponse(envelope, 'old-project')).toThrow(
    OwnedProjectReadError,
  );
  expect(() =>
    validateOwnedProjectResponse({ project: p }, 'old-project'),
  ).toThrow(OwnedProjectReadError);
  expect(getter).not.toHaveBeenCalled();
});
it('rejects inherited or class envelopes/projects and hidden required fields', () => {
  const envelope = Object.create({ project: project() });
  const inherited = Object.assign(
    Object.create({ unexpected: true }),
    project(),
  );
  const hidden = Object.defineProperty(project(), 'id', {
    value: 'old-project',
    enumerable: false,
  });
  for (const value of [envelope, { project: inherited }, { project: hidden }])
    expect(() => validateOwnedProjectResponse(value, 'old-project')).toThrow(
      OwnedProjectReadError,
    );
});
it('admits null-prototype data envelopes and projects', () => {
  const p = Object.assign(Object.create(null), project());
  const envelope = Object.assign(Object.create(null), { project: p });
  expect(validateOwnedProjectResponse(envelope, 'old-project')).toEqual(
    validateOwnedProjectResponse({ project: project() }, 'old-project'),
  );
});
it('reads a bounded JSON success with the exact requested identity', async () => {
  expect(
    await readOwnedProjectResponse(
      Response.json({ project: project() }),
      'old-project',
      signal(),
    ),
  ).toEqual(
    validateOwnedProjectResponse({ project: project() }, 'old-project'),
  );
});
it.each([401, 404, 409, 429, 500, 503])(
  'cancels HTTP %s without parsing or echoing its body',
  async (status) => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      status,
      headers: { 'content-type': 'text/html' },
    });
    const json = vi.spyOn(response, 'json');
    const promise = readOwnedProjectResponse(response, 'old-project', signal());
    await expect(promise).rejects.toMatchObject({ status });
    await expect(promise).rejects.toThrow(
      status === 401
        ? 'Sign in to open this saved project.'
        : status === 404
          ? 'Saved project not found.'
          : 'Saved project is unavailable. Refresh and try again.',
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(json).not.toHaveBeenCalled();
  },
);
it('handles a rejected error-body cancellation without delaying the error', async () => {
  const response = new Response(
    new ReadableStream({ cancel: () => Promise.reject(Error('SECRET')) }),
    { status: 401 },
  );
  await expect(
    readOwnedProjectResponse(response, 'old-project', signal()),
  ).rejects.toMatchObject({ status: 401 });
  await Promise.resolve();
});
it.each([200, 401, 404])(
  'abort wins over a late HTTP %s and cancels the body',
  async (status) => {
    const c = new AbortController(),
      reason = Error('stopped'),
      cancel = vi.fn();
    c.abort(reason);
    await expect(
      readOwnedProjectResponse(
        new Response(new ReadableStream({ cancel }), { status }),
        'old-project',
        c.signal,
      ),
    ).rejects.toBe(reason);
    expect(cancel).toHaveBeenCalledOnce();
  },
);
it('cancels an in-flight JSON read on abort', async () => {
  const c = new AbortController(),
    reason = Error('stopped'),
    cancel = vi.fn();
  const response = new Response(new ReadableStream({ cancel }), {
    headers: { 'content-type': 'application/json' },
  });
  const pending = readOwnedProjectResponse(response, 'old-project', c.signal);
  c.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(cancel).toHaveBeenCalledOnce();
});
it.each([
  new Response('<html>SECRET</html>', {
    headers: { 'content-type': 'text/html' },
  }),
  new Response('SECRET_NOT_JSON', {
    headers: { 'content-type': 'application/json' },
  }),
  Response.json({ project: { ...project(), id: 'other' } }),
])('sanitizes success-body/parser failures %#', async (response) => {
  await expect(
    readOwnedProjectResponse(response, 'old-project', signal()),
  ).rejects.toThrow('Saved project is unavailable. Refresh and try again.');
});
it('refuses an oversized transport even when the unknown field would be discarded', async () => {
  const value = {
    project: {
      ...project(),
      options: {
        ...DEFAULT_VENUE_OPTIONS,
        ignored: 'x'.repeat(PANEL_JSON_RESPONSE_BYTES),
      },
    },
  };
  await expect(
    readOwnedProjectResponse(Response.json(value), 'old-project', signal()),
  ).rejects.toBeInstanceOf(OwnedProjectReadError);
  expect(() => validateOwnedProjectResponse(value, 'old-project')).toThrow(
    OwnedProjectReadError,
  );
});
