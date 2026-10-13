import { runConditionalMonitors } from '../lib/conditional-monitor-server';
const conditionalMonitorWorker = {
  async fetch() {
    return new Response(
      'Scheduled read-only conditional monitoring. No public execution endpoint.',
      { status: 404 },
    );
  },
  async scheduled(
    _event: ScheduledController,
    bindings: { DB: D1Database; CONDITIONAL_MONITOR_ENABLED?: string },
    context: ExecutionContext,
  ) {
    if (bindings.CONDITIONAL_MONITOR_ENABLED !== 'true') return;
    context.waitUntil(
      runConditionalMonitors(bindings.DB).then(() => undefined),
    );
  },
};
export default conditionalMonitorWorker;
