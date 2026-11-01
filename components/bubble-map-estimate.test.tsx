// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BubbleMapEstimate } from './bubble-map-estimate';

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const render = (props: Parameters<typeof BubbleMapEstimate>[0]) =>
  act(async () => {
    root.render(<BubbleMapEstimate {...props} />);
  });

const labels = () =>
  [...host.querySelectorAll('.bubble-map-label')].map((n) => n.textContent);

it('renders the four captured cards in order', async () => {
  await render({});
  expect(labels()).toEqual([
    'Bubble Maps',
    'Supply Cost',
    'Detection Mode',
    'Cleanup Time',
  ]);
});

it('hides detection mode when asked', async () => {
  await render({ showDetectionMode: false });
  expect(labels()).toEqual(['Bubble Maps', 'Supply Cost', 'Cleanup Time']);
});

it('shows cleanliness from the buy delay', async () => {
  await render({ buyDelayMs: 20_000 });
  expect(host.textContent).toContain('Likely clean');
  expect(host.textContent).toContain('Uncertain');
});

it('fills only the first half when uncertain', async () => {
  await render({ buyDelayMs: 0 });
  const halves = [...host.querySelectorAll('.bubble-map-half')];
  expect(halves[0].classList.contains('is-filled')).toBe(true);
  expect(halves[1].classList.contains('is-filled')).toBe(false);
});

it('fills both halves when likely clean', async () => {
  await render({ buyDelayMs: 16_000 });
  const halves = [...host.querySelectorAll('.bubble-map-half')];
  expect(halves.every((h) => h.classList.contains('is-filled'))).toBe(true);
});

it('exposes each meter position as a percentage', async () => {
  await render({ mevSlider: 1 });
  const meter = host.querySelector('[aria-label="Detection Mode"]')!;
  expect(meter.getAttribute('aria-valuenow')).toBe('50');
});

it('gives detection mode no numeric value but a real valuetext', async () => {
  await render({ mevSlider: 1.6 });
  const meter = host.querySelector('[aria-label="Detection Mode"]')!;
  expect(meter.getAttribute('aria-valuenow')).toBe('100');
  expect(host.textContent).not.toContain('100%');
  expect(meter.getAttribute('aria-valuetext')).toBe('Detection Mode');
});

it('renders the captured axis labels', async () => {
  await render({});
  expect(host.textContent).toContain('Less Sniper');
  expect(host.textContent).toContain('Less Top Traders');
  expect(host.textContent).toContain('Fastest');
  expect(host.textContent).toContain('Longest');
});

it('announces cleanliness for screen readers', async () => {
  await render({ buyDelayMs: 20_000 });
  expect(host.querySelector('.bubble-map-sr')?.textContent).toContain(
    'Likely clean',
  );
});
