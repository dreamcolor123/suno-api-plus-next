import fs from 'node:fs';
import path from 'node:path';

export const PACKAGED_CHROMIUM_REVISION = '1148';

export type BrowserRuntimeEnvironment = Record<string, string | undefined>;

function environmentFlag(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function packagedEnvironment(environment: BrowserRuntimeEnvironment): boolean {
  return (
    environmentFlag(environment.SUNO_STUDIO_PACKAGED_RUNTIME)
    || environmentFlag(environment.SUNO_STUDIO_REQUIRE_PACKAGED_BROWSER)
    || Boolean(environment.SUNO_STUDIO_CHROMIUM_EXECUTABLE)
  );
}

function isContained(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === ''
    || (
      relative !== '..'
      && !relative.startsWith(`..${path.sep}`)
      && !path.isAbsolute(relative)
    )
  );
}

function assertRegularFile(candidate: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch {
    throw new Error('The packaged Chromium executable is missing.');
  }
  if (!stat.isFile()) {
    throw new Error('The packaged Chromium executable is not a regular file.');
  }
}

/** Resolve the desktop-bundled Chromium without falling back to Playwright's cache. */
export function resolvePackagedChromiumExecutable(
  environment: BrowserRuntimeEnvironment = process.env,
  options: { cwd?: string } = {},
): string | undefined {
  const browser = (environment.BROWSER || 'chromium').trim().toLowerCase();
  const packaged = packagedEnvironment(environment);
  if (browser !== 'chromium') {
    if (packaged) {
      throw new Error('The packaged runtime supports Chromium only.');
    }
    return undefined;
  }

  const explicitExecutable = String(
    environment.SUNO_STUDIO_CHROMIUM_EXECUTABLE || '',
  ).trim();
  const configuredRoot = String(
    environment.PLAYWRIGHT_BROWSERS_PATH || '',
  ).trim();
  const required = environmentFlag(
    environment.SUNO_STUDIO_REQUIRE_PACKAGED_BROWSER,
  );
  if (!explicitExecutable && (!configuredRoot || configuredRoot === '0')) {
    if (required || packaged) {
      throw new Error('The packaged Chromium runtime is not configured.');
    }
    return undefined;
  }

  const cwd = options.cwd || environment.INIT_CWD || process.cwd();
  if (packaged && configuredRoot && !path.isAbsolute(configuredRoot)) {
    throw new Error('The packaged Chromium root must be absolute.');
  }
  const root = configuredRoot && configuredRoot !== '0'
    ? path.isAbsolute(configuredRoot)
      ? path.normalize(configuredRoot)
      : path.resolve(cwd, configuredRoot)
    : undefined;
  const executable = explicitExecutable
    ? path.isAbsolute(explicitExecutable)
      ? path.normalize(explicitExecutable)
      : path.resolve(cwd, explicitExecutable)
    : path.join(
      root as string,
      `chromium-${PACKAGED_CHROMIUM_REVISION}`,
      'chrome-win',
      'chrome.exe',
    );

  if (root && !isContained(executable, root)) {
    throw new Error('The packaged Chromium executable is outside its runtime root.');
  }
  if (required && !root) {
    throw new Error('The packaged Chromium browser root is missing.');
  }
  if (packaged && (!root || !isContained(executable, root))) {
    throw new Error('The packaged Chromium executable is not trusted.');
  }
  assertRegularFile(executable);
  return executable;
}

export function packagedChromiumLaunchOptions(
  environment: BrowserRuntimeEnvironment = process.env,
): { executablePath?: string } {
  const executablePath = resolvePackagedChromiumExecutable(environment);
  return executablePath ? { executablePath } : {};
}
