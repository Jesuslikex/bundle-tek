import {
  readOwnedLaunchLayerPlan,
  LaunchLayerError,
} from './launch-layer-service';
import {
  layerRoleMembers,
  layerNativeComparison,
  savedLayerSolObservation,
  type LayerNativeEvidence,
} from './launch-layer-native-coverage';

/** Owned retained observations only. No RPC, packet, funding or signing permission. */
export async function readOwnedLayerNativeEvidence(
  db: D1Database,
  owner: string,
  projectId: string,
  recordId: string,
  now = Date.now,
) {
  const plan = await readOwnedLaunchLayerPlan(db, owner, projectId, recordId);
  if (!plan || !plan.current)
    throw new LaunchLayerError(
      'Current project and wallet references are required for this comparison. The saved plan remains readable as history.',
    );
  const addresses = layerRoleMembers(plan.envelope).map(
    (row) => row.member.wallet.address,
  );
  const result = await db
    .prepare(
      "SELECT address,document,block_number FROM wallet_balance_snapshots WHERE owner_id=? AND chain='Solana' AND address IN (SELECT value FROM json_each(?))",
    )
    .bind(owner, JSON.stringify(addresses))
    .all<{ address: string; document: string; block_number: number }>();
  if (
    new Set(result.results.map((row) => row.address)).size !==
      result.results.length ||
    result.results.some((row) => !addresses.includes(row.address))
  )
    throw new LaunchLayerError(
      'Saved observation storage is inconsistent.',
      503,
    );
  const current = await readOwnedLaunchLayerPlan(
    db,
    owner,
    projectId,
    recordId,
  );
  if (!current || !current.current || current.sha256 !== plan.sha256)
    throw new LaunchLayerError(
      'Planning references changed while loading observations. Reload the saved plan.',
    );
  const checkedAt = new Date(now()).toISOString();
  const rows = addresses.map((address) => {
    const stored = result.results.find((row) => row.address === address);
    if (!stored)
      return { address, observation: null, issue: 'missing' as const };
    let observation = null;
    try {
      observation = savedLayerSolObservation(
        JSON.parse(stored.document),
        address,
        stored.block_number,
        checkedAt,
      );
    } catch {
      /* Retain an explicit unavailable row rather than inventing a zero balance. */
    }
    return {
      address,
      observation,
      issue: observation ? null : ('invalid' as const),
    };
  });
  const evidence: LayerNativeEvidence = {
    planId: plan.id,
    sha256: plan.sha256,
    termsSha256: plan.envelope.sha256,
    checkedAt,
    rows,
    fundingAllowed: false,
    signingAllowed: false,
    executionAllowed: false,
  };
  layerNativeComparison(evidence, plan, plan.envelope);
  return evidence;
}
