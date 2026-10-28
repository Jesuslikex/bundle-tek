import type { JitoChainObservation } from '@/lib/jito-chain-observation';

const label: Record<JitoChainObservation['packets'][number]['status'], string> =
  {
    'not-registered': 'No signed packet is registered',
    'not-found': 'Not found by this provider',
    unavailable: 'Status unavailable or unrecognized',
    'processed-success': 'Processed, success reported',
    'processed-failure': 'Processed, failure reported',
    'confirmed-success': 'Confirmed, success reported',
    'confirmed-failure': 'Confirmed, failure reported',
    'finalized-success': 'Finalized, success reported',
    'finalized-failure': 'Finalized, failure reported',
  };

/** These statuses are read-only RPC reports, not transaction receipts. */
export function JitoChainObservationView({
  observation,
  swapCount,
}: {
  observation: JitoChainObservation;
  swapCount: number;
}) {
  return (
    <section
      aria-label="Provider-reported packet outcomes"
      className="space-y-2 rounded-md border p-3"
    >
      <h6>Provider-reported packet outcomes</h6>
      <p>
        These are RPC observations, not verified settlement receipts or proof of
        bundle atomicity. A missing result does not prove a packet never landed.
        Do not resend based on this report.
      </p>
      <p>
        Checked{' '}
        <time dateTime={observation.observedAt}>{observation.observedAt}</time>.
      </p>
      <ol>
        {observation.packets.map((packet) => (
          <li key={packet.packet}>
            {packet.packet === swapCount ? 'Tip' : `Swap ${packet.packet + 1}`}:{' '}
            {label[packet.status]}
            {packet.slot !== null ? ` (slot ${packet.slot})` : ''}.
          </li>
        ))}
      </ol>
    </section>
  );
}
