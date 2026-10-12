// Only exact application-authored messages are translated. Provider text and URLs never leave this boundary.
export function poolTradeMovementError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (
    [
      'Balance provider unavailable.',
      'Invalid balance provider response.',
      'Empty balance provider response.',
      'Confirmed transaction is unavailable from the configured RPC.',
    ].includes(message)
  )
    return {
      reason: 'provider-unavailable',
      error:
        'The configured RPC could not provide this confirmed transaction. Its provider trade label remains unverified. Try again later.',
    };
  if (
    [
      'Balance response too large.',
      'RPC integer precision unavailable.',
    ].includes(message)
  )
    return {
      reason: 'response-bound',
      error:
        'The RPC response exceeds supported size or integer precision bounds. Its provider trade label remains unverified.',
    };
  if (['Transaction provider network mismatch.'].includes(message))
    return {
      reason: 'network-mismatch',
      error:
        'The configured RPC returned a different network. Provider trade labels remain unverified.',
    };
  if (
    [
      'Transaction identity differs from the saved trade.',
      'Transaction identity or version mismatch.',
      'Transaction mint precision differs.',
      'On-chain movement context differs.',
      'On-chain classification evidence differs.',
      'On-chain token change differs.',
    ].includes(message)
  )
    return {
      reason: 'context-mismatch',
      error:
        'The transaction identity, precision or review context differs from the saved trade. Its provider label remains unverified.',
    };
  if (
    [
      'Program missing from transaction accounts.',
      'Instruction account missing from transaction keys.',
      'Parsed instruction account missing from transaction keys.',
      'Invalid transaction account keys.',
      'Invalid token balance account keys.',
      'Enter a public wallet address.',
      'Enter a valid Solana public address.',
      'Token account index mismatch.',
      'Balance account mismatch.',
      'Transaction does not include the tracked wallet.',
      'Invalid account flags.',
    ].includes(message)
  )
    return {
      reason: 'account-mismatch',
      error:
        'Transaction account references could not be reconciled. Its provider label remains unverified.',
    };
  if (
    [
      'Incomplete transaction data.',
      'Incomplete token balance data.',
      'Invalid token balance integer.',
      'Invalid transaction integer.',
      'Invalid token balance data.',
      'Invalid transaction data.',
      'Invalid inner instruction index.',
    ].includes(message)
  )
    return {
      reason: 'incomplete-metadata',
      error:
        'The transaction metadata is incomplete or outside the supported decoder. Its provider label remains unverified.',
    };
  return {
    reason: 'unavailable',
    error:
      'On-chain transaction unavailable or its evidence is inconsistent. Provider trade labels remain unverified.',
  };
}
