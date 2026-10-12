import type { ImportedSwapSimulation } from '@/lib/imported-swap-simulation';
import { signedBalanceAmount } from '@/lib/wallet-balance-format';
export function SimulatedSwapTokenBalances({
  simulation,
}: {
  simulation: ImportedSwapSimulation;
}) {
  return (
    <section aria-label="Simulated token balance checks">
      <h5>Simulated token balances</h5>
      {(simulation.inputAmountMatches === false ||
        simulation.minimumOutputCovered === false) && (
        <p role="alert">
          Simulated token balances do not match this swap request. This order
          cannot proceed.
        </p>
      )}
      {!simulation.tokensComplete ? (
        <p>
          Token comparisons unavailable. The provider did not return complete
          token ownership metadata.
        </p>
      ) : (
        <>
          <p>
            Token input:{' '}
            {simulation.inputAmountMatches === null
              ? 'Comparison unavailable for native SOL.'
              : simulation.inputAmountMatches
                ? 'Net token debit matches the requested input.'
                : 'Net token debit does not match the requested input.'}
          </p>
          <p>
            Token output:{' '}
            {simulation.minimumOutputCovered === null
              ? 'Comparison unavailable for native SOL.'
              : simulation.minimumOutputCovered
                ? 'Net token increase covers the quoted minimum.'
                : 'Net token increase falls below the quoted minimum.'}
          </p>
          {simulation.tokenChanges.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Mint / program</th>
                  <th>Wallet token change</th>
                </tr>
              </thead>
              <tbody>
                {simulation.tokenChanges.map((change) => (
                  <tr key={`${change.program}/${change.mint}`}>
                    <td className="warmup-address">
                      <code>{change.mint}</code>
                      <br />
                      <small>{change.program}</small>
                    </td>
                    <td>
                      {signedBalanceAmount(change.changeRaw, change.decimals)}
                      <br />
                      <small>Raw change: {change.changeRaw}</small>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No wallet-attributed token balances returned.</p>
          )}
        </>
      )}
      <p>
        These comparisons do not verify instruction semantics or permit signing.
      </p>
    </section>
  );
}
