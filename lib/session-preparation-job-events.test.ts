import { it, expect } from 'vitest';
import {
  decodeSessionJobEvent,
  decodeSessionJobEventPage,
} from './session-preparation-job-events';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const event = {
  id: 'a'.repeat(32),
  sequence: 2,
  projectId: id(1),
  sessionId: id(2),
  jobId: id(3),
  createdAt: '2026-10-11T12:00:00.000Z',
  document: {
    id: id(3),
    entry: 1,
    state: 'queued',
    attempts: 0,
    preparationId: null,
    error: null,
  },
};
it('validates captured job transitions without reconstructing current terms', () => {
  expect(decodeSessionJobEvent(event)).toEqual(event);
  expect(
    decodeSessionJobEvent({
      ...event,
      document: {
        ...event.document,
        state: 'prepared',
        attempts: 1,
        preparationId: id(4),
      },
    }).document.state,
  ).toBe('prepared');
  for (const patch of [
    { id: id(4) },
    { entry: 26 },
    { state: 'signed' },
    { attempts: 4 },
    { state: 'running' },
    { preparationId: id(4) },
    { error: 'provider secret' },
    { extra: true },
  ])
    expect(() =>
      decodeSessionJobEvent({
        ...event,
        document: { ...event.document, ...patch },
      }),
    ).toThrow();
  expect(() => decodeSessionJobEvent({ ...event, jobId: id(4) })).toThrow();
});
it('rejects cross-scope, duplicate, reordered and unanchored cursor pages', () => {
  expect(
    decodeSessionJobEventPage(
      { events: [event], nextCursor: event.id },
      id(1),
      id(2),
      3,
    ).events,
  ).toHaveLength(1);
  for (const page of [
    { events: [event, event], nextCursor: null },
    { events: [event], nextCursor: 'b'.repeat(32) },
    { events: [event], nextCursor: undefined },
    { events: Array(51).fill(event), nextCursor: null },
  ])
    expect(() => decodeSessionJobEventPage(page)).toThrow();
  expect(() =>
    decodeSessionJobEventPage({ events: [event], nextCursor: null }, id(9)),
  ).toThrow();
  expect(() =>
    decodeSessionJobEventPage(
      { events: [event], nextCursor: null },
      id(1),
      id(9),
    ),
  ).toThrow();
  expect(() =>
    decodeSessionJobEventPage(
      { events: [event], nextCursor: null },
      id(1),
      id(2),
      2,
    ),
  ).toThrow();
});
