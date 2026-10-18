/** Display-only: describes this caller's submission path, never grants authority. */
export function TransactionDeliveryNotice({
  transport,
}: {
  transport: 'rpc' | 'jito-bundle';
}) {
  return (
    <aside
      aria-label="Transaction delivery"
      className="min-w-0 space-y-1 rounded-md border p-3 text-sm break-words"
    >
      <p>
        <strong>
          Delivery:{' '}
          {transport === 'rpc' ? 'configured Solana RPC' : 'Jito bundle'}
        </strong>
      </p>
      {transport === 'rpc' ? (
        <p>
          Trades are submitted individually. Bundle does not request dedicated
          sandwich protection on this path. Minimum output limits execution
          price; it does not prevent transaction reordering.
        </p>
      ) : (
        <p>
          Jito bundle delivery does not guarantee protection from front-running
          or sandwiching. Dedicated sandwich protection has not been verified
          for this flow.
        </p>
      )}
      {transport === 'jito-bundle' && (
        <a
          href="https://docs.jito.wtf/lowlatencytxnsend/#sandwich-mitigation"
          target="_blank"
          rel="noopener noreferrer"
          className="underline"
        >
          Jito protection and its limits
        </a>
      )}
    </aside>
  );
}
