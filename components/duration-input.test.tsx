// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DurationInput } from './duration-input';
import { splitDurationSeconds, type DurationParts } from '@/lib/duration-parts';
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function Controlled() {
  const [value, setValue] = useState(() => splitDurationSeconds(60));
  return (
    <DurationInput
      label="Interval"
      value={value}
      onChange={setValue}
      maximumSeconds={86400}
    />
  );
}
async function enter(unit: string, value: string) {
  const input = Array.from(container.getElementsByTagName('input')).find(
    (input) => input.getAttribute('aria-label') === `Interval: ${unit}`,
  )!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  return input;
}
it('labels every unit and keeps an invalid raw edit visible until corrected', async () => {
  await act(async () => root.render(<Controlled />));
  expect(container.querySelector('output')?.textContent).toBe(
    '60 seconds total',
  );
  await enter('hours', '1');
  await enter('minutes', '2');
  await enter('seconds', '3');
  expect(container.querySelector('output')?.textContent).toBe(
    '3,723 seconds total',
  );
  const input = await enter('minutes', '60');
  expect(input.value).toBe('60');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(container.querySelector('[role=alert]')?.textContent).toContain(
    '0 to 59',
  );
  await enter('minutes', '2');
  expect(container.querySelector('[role=alert]')).toBeNull();
  expect(container.querySelector('output')?.textContent).toBe(
    '3,723 seconds total',
  );
});
it('reflects an external reset without retaining previous hidden unit drafts', async () => {
  const onChange = vi.fn();
  await act(async () =>
    root.render(
      <DurationInput
        label="Interval"
        value={splitDurationSeconds(3723)}
        onChange={onChange}
      />,
    ),
  );
  const empty: DurationParts = { hours: '', minutes: '', seconds: '' };
  await act(async () =>
    root.render(
      <DurationInput label="Interval" value={empty} onChange={onChange} />,
    ),
  );
  expect(
    Array.from(container.getElementsByTagName('input')).map((i) => i.value),
  ).toEqual(['', '', '']);
  expect(container.querySelector('[role=alert]')).toBeNull();
  expect(onChange).not.toHaveBeenCalled();
});
it('inherits native disabled state for every time input', async () => {
  await act(async () =>
    root.render(
      <DurationInput
        label="Interval"
        value={splitDurationSeconds(60)}
        onChange={() => {}}
        disabled
      />,
    ),
  );
  expect(
    Array.from(container.getElementsByTagName('input')).every((input) =>
      input.matches(':disabled'),
    ),
  ).toBe(true);
});
