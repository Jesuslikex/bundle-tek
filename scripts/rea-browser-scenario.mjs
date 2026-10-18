// Bounded, invocation-only adapter for the installed REA 6.4.0 WSL runtime.
// It neither edits the installed package nor changes the default REA launcher.
import { registerHooks } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const runtime = '/opt/rea/cli/node_modules/rea-agents/dist/';
const browserModule = pathToFileURL(
  runtime + 'browser/PlaywrightScenarioBrowser.js',
).href;
const expectedHash =
  'f08cc802b6de547394145d75c6c473778433dddb6d754be190ff7fa6f4389f2d';
const localeCall = `    await session.send("Emulation.setLocaleOverride", {
        locale: environment.locale,
    });`;
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== browserModule) return loaded;
    const source =
      typeof loaded.source === 'string'
        ? loaded.source
        : Buffer.from(loaded.source).toString('utf8');
    if (
      createHash('sha256').update(source).digest('hex') !== expectedHash ||
      source.split(localeCall).length !== 2
    )
      throw new Error(
        'REA browser runtime changed. Review the locale adapter before use.',
      );
    return {
      ...loaded,
      source:
        `let retainedLocale = false;\nexport const didRetainExistingLocale = () => retainedLocale;\n` +
        source.replace(
          localeCall,
          `    try {
${localeCall}
    } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("Another locale override is already in effect")) throw error;
        retainedLocale = true;
    }`,
        ),
    };
  },
});

const { browserScenarioSchema } = await import(
  pathToFileURL(runtime + 'domain/browserScenario.js').href
);
const { createBrowserScenarioProvider } = await import(
  pathToFileURL(runtime + 'composition/browserScenario.js').href
);
const { captureBrowserScenario } = await import(
  pathToFileURL(runtime + 'application/BrowserScenarioCaptureService.js').href
);
const { projectAnalysisError } = await import(
  pathToFileURL(runtime + 'domain/analysisErrorProjection.js').href
);
const scenario = browserScenarioSchema.parse(
  JSON.parse(await readFile(process.argv[2], 'utf8')),
);
if (
  scenario.browser.mode !== 'connect' ||
  scenario.browser.cdp_endpoint !== 'http://127.0.0.1:9223' ||
  new URL(scenario.start_url.url).origin !== 'https://app.proxima.tools' ||
  scenario.secrets.length ||
  scenario.storage.cookies.length ||
  scenario.storage.local_storage.length ||
  scenario.storage.session_storage.length ||
  scenario.capture.after_each_step.includes('storage') ||
  scenario.capture.at_end.includes('storage') ||
  scenario.capture.network.request_body ||
  scenario.capture.network.response_body ||
  scenario.capture.network.header_values ||
  scenario.actions.some((action) => !['click', 'press'].includes(action.action))
)
  throw new Error(
    'This local inspection adapter only admits the existing Proxima browser with no secrets or storage seeds.',
  );
const provider = createBrowserScenarioProvider(process.env);
const observedProvider = {
  identity: () => provider.identity(),
  async captureScenario(input, options) {
    const captured = await provider.captureScenario(input, options);
    const browser = await import(browserModule);
    if (captured.ok && browser.didRetainExistingLocale())
      captured.value.limitations.push(
        'The existing browser locale override was retained. The requested locale was not applied or independently verified.',
      );
    return captured;
  },
};
const result = await captureBrowserScenario(observedProvider, scenario, {
  signal: AbortSignal.timeout(45000),
});
if (!result.ok) {
  console.error(
    JSON.stringify({
      ok: false,
      name: result.error.name,
      message: result.error.message,
      error: projectAnalysisError(result.error),
    }),
  );
  await provider.close();
  process.exitCode = 1;
} else {
  await writeFile(process.argv[3], JSON.stringify(result.value), {
    flag: 'wx',
  });
  await provider.close();
  console.log(
    JSON.stringify({
      ok: true,
      evidence_id: result.value.evidence_id,
      steps: result.value.normalized_result.steps.map((s) => ({
        id: s.step_id,
        status: s.status,
        error: s.error,
      })),
      limitations: result.value.normalized_result.limitations,
    }),
  );
}
