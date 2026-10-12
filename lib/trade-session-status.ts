import {
  decodeTradeSession,
  validatedTradeSessionControls,
  validatedTradeSessionActivity,
  type TradeSession,
  type TradeSessionControl,
  type TradeSessionActivity,
} from './imported-trade-session';
export function decodeTradeSessionStatus(value: unknown, projectId: string) {
  const v = value as {
    projectId: string;
    executionAllowed: boolean;
    sessions: unknown[];
    controls: unknown;
    activity: unknown;
  };
  if (
    !v ||
    v.projectId !== projectId ||
    v.executionAllowed !== false ||
    !Array.isArray(v.sessions) ||
    v.sessions.length > 100
  )
    throw new Error('Session status context differs.');
  const sessions = v.sessions.map(decodeTradeSession);
  if (
    new Set(sessions.map((s) => s.id)).size !== sessions.length ||
    sessions.some((s) => s.terms.projectId !== projectId)
  )
    throw new Error('Session status scope differs.');
  return {
    sessions,
    controls: validatedTradeSessionControls(v.controls, sessions),
    activity: validatedTradeSessionActivity(v.activity, sessions),
  };
}
export function requireCurrentSessionStatus(
  next: ReturnType<typeof decodeTradeSessionStatus>,
  sessions: TradeSession[],
  controls: TradeSessionControl[],
  activity: TradeSessionActivity[] = [],
) {
  for (const old of sessions) {
    const incoming = next.sessions.find((s) => s.id === old.id);
    if (
      !incoming ||
      incoming.revision < old.revision ||
      JSON.stringify(incoming.terms) !== JSON.stringify(old.terms) ||
      incoming.createdAt !== old.createdAt ||
      Date.parse(incoming.updatedAt) < Date.parse(old.updatedAt) ||
      (incoming.revision === old.revision &&
        JSON.stringify(incoming) !== JSON.stringify(old))
    )
      throw new Error(
        'Saved session status moved backwards. Reload to reconcile.',
      );
  }
  for (const old of controls) {
    const incoming = next.controls.find((c) => c.sessionId === old.sessionId);
    if (
      !incoming ||
      incoming.revision < old.revision ||
      incoming.createdAt !== old.createdAt ||
      Date.parse(incoming.updatedAt) < Date.parse(old.updatedAt) ||
      (incoming.revision === old.revision &&
        JSON.stringify(incoming) !== JSON.stringify(old))
    )
      throw new Error(
        'Saved session control moved backwards. Reload to reconcile.',
      );
  }
  const rank: Record<string, number> = {
    awaiting_signature: 0,
    signed: 1,
    submitted: 2,
    failed: 3,
    cancelled: 3,
    finalized: 3,
  };
  for (const old of activity) {
    const incoming = next.activity.find((a) => a.intentId === old.intentId);
    if (
      !incoming ||
      incoming.sessionId !== old.sessionId ||
      incoming.entry !== old.entry ||
      rank[incoming.state] < rank[old.state] ||
      (rank[old.state] === 3 &&
        JSON.stringify(incoming) !== JSON.stringify(old)) ||
      (old.signature !== null && incoming.signature !== old.signature)
    )
      throw new Error(
        'Saved session approval status moved backwards. Reload to reconcile.',
      );
  }
}
