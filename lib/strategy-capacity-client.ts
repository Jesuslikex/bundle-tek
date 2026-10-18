import type { SavedStrategyDraft } from './strategy-session-drafts';
import {
  capacityDigest,
  capacityKeys,
  reviewCapacityTotals,
  type ReviewCapacity,
} from './strategy-review-capacity';
export type StrategyCapacityView = {
  draftId: string;
  projectId: string;
  planSha256: string;
  revision: number;
  state: ReviewCapacity;
  summary: ReturnType<typeof reviewCapacityTotals>;
  planningOnly: true;
  fundingAllowed: false;
  signingAllowed: false;
  executionAllowed: false;
};
export async function readStrategyCapacityView(
  value: unknown,
  draft: SavedStrategyDraft,
): Promise<StrategyCapacityView> {
  capacityKeys(
    value,
    'draftId,executionAllowed,fundingAllowed,planSha256,planningOnly,projectId,revision,signingAllowed,state,summary',
  );
  const view = value as StrategyCapacityView;
  const summary = reviewCapacityTotals(draft.plan, view.state);
  if (
    view.draftId !== draft.id ||
    view.projectId !== draft.plan.input.projectId ||
    view.planSha256 !== (await capacityDigest(draft.plan)) ||
    !Number.isSafeInteger(view.revision) ||
    view.revision < 0 ||
    view.revision !==
      view.state.holds.length +
        view.state.holds.filter((h) => h.state === 'released').length ||
    JSON.stringify(summary) !== JSON.stringify(view.summary) ||
    view.planningOnly !== true ||
    view.fundingAllowed !== false ||
    view.signingAllowed !== false ||
    view.executionAllowed !== false
  )
    throw Error('Strategy capacity response differs. Reload review slots.');
  return structuredClone(view);
}
