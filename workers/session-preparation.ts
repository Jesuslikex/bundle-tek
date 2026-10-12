import { runSessionPreparationJobs } from '../lib/session-preparation-jobs';
import { prepareOwnedImportedSwap } from '../lib/prepare-owned-imported-swap';
const sessionPreparationWorker = {
  async fetch() {
    return new Response(
      'Scheduled unsigned preparation worker. No public execution endpoint.',
      { status: 404 },
    );
  },
  async scheduled(
    _event: ScheduledController,
    bindings: { DB: D1Database; SESSION_PREPARATION_ENABLED?: string },
    context: ExecutionContext,
  ) {
    if (bindings.SESSION_PREPARATION_ENABLED !== 'true') return;
    context.waitUntil(
      runSessionPreparationJobs(bindings.DB, prepareOwnedImportedSwap).then(
        () => undefined,
      ),
    );
  },
};
export default sessionPreparationWorker;
