import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function loadResolver() {
  const filename = path.join(root, 'src', 'lib', 'browser-runtime.ts');
  const source = await readFile(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', '__filename', '__dirname', compiled)(
    module.exports,
    module,
    require,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

async function loadCaptchaDeadline() {
  const filename = path.join(root, 'src', 'lib', 'captcha-deadline.ts');
  const source = await readFile(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', '__filename', '__dirname', compiled)(
    module.exports,
    module,
    require,
    filename,
    path.dirname(filename),
  );
  return module.exports;
}

test('packaged browser resolver pins Playwright to the bundled chrome.exe', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'suno-browser-runtime-'));
  try {
    const browserRoot = path.join(directory, 'browsers');
    const executable = path.join(
      browserRoot,
      'chromium-1148',
      'chrome-win',
      'chrome.exe',
    );
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, 'fixture');
    const resolver = await loadResolver();

    const options = resolver.packagedChromiumLaunchOptions({
      SUNO_STUDIO_PACKAGED_RUNTIME: '1',
      SUNO_STUDIO_REQUIRE_PACKAGED_BROWSER: '1',
      SUNO_STUDIO_CHROMIUM_EXECUTABLE: executable,
      PLAYWRIGHT_BROWSERS_PATH: browserRoot,
      BROWSER: 'chromium',
    });

    assert.equal(options.executablePath, executable);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('packaged browser resolver fails closed when the executable is missing', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'suno-browser-missing-'));
  try {
    const resolver = await loadResolver();
    const browserRoot = path.join(directory, 'browsers');
    assert.throws(
      () => resolver.packagedChromiumLaunchOptions({
        SUNO_STUDIO_PACKAGED_RUNTIME: '1',
        SUNO_STUDIO_REQUIRE_PACKAGED_BROWSER: '1',
        SUNO_STUDIO_CHROMIUM_EXECUTABLE: path.join(
          browserRoot,
          'chromium-1148',
          'chrome-win',
          'chrome.exe',
        ),
        PLAYWRIGHT_BROWSERS_PATH: browserRoot,
        BROWSER: 'chromium',
      }),
      /packaged Chromium executable is missing/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('generation routes bind live challenge acquisition and reporting to their Suno POST', async () => {
  const api = await readFile(path.join(root, 'src', 'lib', 'SunoApi.ts'), 'utf8');
  const compat = await readFile(
    path.join(root, 'src', 'lib', 'compat-route-error.ts'),
    'utf8',
  );
  const browserSession = await readFile(
    path.join(root, 'src', 'lib', 'captcha-browser-session.ts'),
    'utf8',
  );

  assert.match(api, /\.\.\.browserOptions/);
  assert.match(api, /captureCaptchaChallenge/);
  assert.match(api, /buildSunoBrowserCookies/);
  assert.match(browserSession, /name\.startsWith\('__session_'\)/);
  assert.match(api, /textarea\[maxlength="3000"\]/);
  assert.match(api, /body: JSON\.stringify\(\{ required: true, captcha_version: 1 \}\)/);
  assert.match(api, /captchaChallengeFromRequest/);
  assert.match(api, /captchaChallengeFromRender/);
  assert.match(api, /lastCaptchaVersion === 1/);
  assert.match(api, /verifiedStaticCaptchaChallenge/);
  assert.match(api, /CAPTCHA_FORCE_LIVE_CHALLENGE/);
  assert.match(api, /getCaptchaCoordinator/);
  assert.match(api, /session\.report\(proof, 'good'\)/);
  assert.match(api, /session\.report\(proof, 'bad'\)/);
  assert.match(api, /'User-Agent': proof\.userAgent/);
  assert.match(api, /runWithCaptchaAcquisitionDeadline/);
  assert.equal((api.match(/await this\.submitGenerationRequest\(/g) || []).length, 3);
  const routeInstalledAt = api.indexOf("page.route('**/api/generate/**'");
  const syntheticClickAt = api.indexOf("await button.click({ force: true", routeInstalledAt);
  assert.ok(routeInstalledAt >= 0 && syntheticClickAt > routeInstalledAt);
  assert.match(api, /suno_captcha_browser_unavailable/);
  assert.match(api, /submissionState: 'not_submitted'/);
  assert.doesNotMatch(api, /payload:\s*payload\s*\}/);
  assert.match(compat, /submissionState|submission_state/);
  assert.match(compat, /isSunoPublicErrorLike/);
  assert.match(compat, /code\.startsWith\('suno_captcha_'/);
  assert.match(compat, /retryable: error\.retryable/);
});

test('CAPTCHA acquisition deadline aborts before the Runtime request timeout', async () => {
  const deadline = await loadCaptchaDeadline();

  assert.equal(deadline.DEFAULT_CAPTCHA_ACQUISITION_TIMEOUT_MS, 220_000);
  assert.equal(deadline.captchaAcquisitionTimeoutMs('999999'), 225_000);
  assert.equal(deadline.captchaAcquisitionTimeoutMs('invalid'), 220_000);

  let aborted = false;
  await assert.rejects(
    deadline.runWithCaptchaAcquisitionDeadline(
      (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('cancelled'));
        }, { once: true });
      }),
      10,
    ),
    /deadline|cancelled/i,
  );
  assert.equal(aborted, true);
});

test('CAPTCHA dashboard status is local-only and provider connectivity is explicit', async () => {
  const statusSource = await readFile(path.join(root, 'src', 'lib', 'yescaptcha.ts'), 'utf8');
  const statusBody = statusSource.slice(
    statusSource.indexOf('export async function getCaptchaStatus'),
    statusSource.indexOf('function normalizeCoordinates'),
  );
  const probe = await readFile(
    path.join(root, 'src', 'app', 'api', 'admin', 'captcha', 'probe', 'route.ts'),
    'utf8',
  );
  const generate = await readFile(path.join(root, 'src', 'app', 'api', 'generate', 'route.ts'), 'utf8');

  assert.doesNotMatch(statusBody, /getYesCaptchaBalance\(/);
  assert.match(statusBody, /captcha-status\/v2/);
  assert.match(probe, /provider\.health\(controller\.signal\)/);
  assert.match(probe, /9_000/);
  assert.match(generate, /compatRouteError\('generate'/);
  assert.doesNotMatch(generate, /JSON\.stringify\(error\.response\.data\)/);
});
