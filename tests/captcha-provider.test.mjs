import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const realRequire = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function loadProvider(settings = {}) {
  const filename = path.join(root, 'src', 'lib', 'captcha-provider.ts');
  const source = await readFile(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === '@/lib/captcha-settings') {
      return { getCaptchaSettingsSync: () => ({
        provider: 'auto',
        yescaptchaKey: '',
        twocaptchaKey: '',
        yescaptchaBaseUrl: 'https://api.yescaptcha.test',
        ...settings,
      }) };
    }
    return realRequire(specifier);
  };
  new Function('exports', 'module', 'require', '__filename', '__dirname', compiled)(
    module.exports, module, localRequire, filename, path.dirname(filename),
  );
  return module.exports;
}

const context = {
  schemaVersion: 'suno-hcaptcha-challenge/v1',
  websiteURL: 'https://suno.com/create?wid=live',
  websiteKey: 'live-site-key',
  rqdata: 'live-rqdata',
  enterprisePayload: { rqdata: 'live-rqdata', sentry: true },
  userAgent: 'Matching-Browser-UA',
  invisible: true,
  source: 'network',
};

test('YesCaptcha receives the live challenge, provider-recommended UA, and report task id', async () => {
  const providerModule = await loadProvider();
  const requests = [];
  const transport = async (request) => {
    requests.push(request);
    if (request.url.endsWith('/useragent')) {
      return {
        status: 200,
        data: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
          + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
      };
    }
    if (request.url.endsWith('/createTask')) {
      return { status: 200, data: { status: 'ready', taskId: 'yes-42', solution: { gRecaptchaResponse: 'yes-token', userAgent: 'Provider-Confirmed-UA' } } };
    }
    if (request.url.endsWith('/reportCorrect')) return { status: 200, data: { errorId: 0 } };
    throw new Error(`unexpected ${request.url}`);
  };
  const provider = new providerModule.YesCaptchaProviderAdapter({
    clientKey: 'yes-secret',
    baseURL: 'https://api.yescaptcha.test',
    transport,
  });
  const proof = await provider.solve(context, {
    signal: new AbortController().signal,
    timeoutMs: 1_000,
  });
  await provider.report(proof, 'good');

  const task = requests[1].data.task;
  assert.equal(task.type, 'HCaptchaTaskProxyless');
  assert.equal(task.websiteURL, context.websiteURL);
  assert.equal(task.websiteKey, context.websiteKey);
  assert.equal(task.rqdata, context.rqdata);
  assert.match(task.userAgent, /Chrome\/150\.0\.0\.0/);
  assert.equal(task.enterprisePayload, undefined);
  assert.equal(proof.taskId, 'yes-42');
  assert.equal(proof.token, 'yes-token');
  assert.equal(proof.userAgent, 'Provider-Confirmed-UA');
  assert.equal(requests[2].data.taskId, 'yes-42');
});

test('YesCaptcha falls back to the browser-matched UA when its recommendation endpoint fails', async () => {
  const providerModule = await loadProvider();
  const requests = [];
  const transport = async (request) => {
    requests.push(request);
    if (request.url.endsWith('/useragent')) return { status: 503, data: 'unavailable' };
    if (request.url.endsWith('/createTask')) {
      return {
        status: 200,
        data: {
          status: 'ready',
          taskId: 'yes-fallback',
          solution: { gRecaptchaResponse: 'yes-token' },
        },
      };
    }
    throw new Error(`unexpected ${request.url}`);
  };
  const provider = new providerModule.YesCaptchaProviderAdapter({
    clientKey: 'yes-secret',
    baseURL: 'https://api-fallback.yescaptcha.test',
    transport,
  });
  const proof = await provider.solve(context, {
    signal: new AbortController().signal,
    timeoutMs: 1_000,
  });

  assert.equal(requests[1].data.task.userAgent, context.userAgent);
  assert.equal(proof.userAgent, context.userAgent);
});

test('2Captcha direct HTTP payload carries rqdata and UA and supports Bad Report', async () => {
  const previousPoll = process.env.CAPTCHA_PROVIDER_POLL_MS;
  process.env.CAPTCHA_PROVIDER_POLL_MS = '10';
  try {
    const providerModule = await loadProvider();
    const requests = [];
    const transport = async (request) => {
      requests.push(request);
      if (request.url.endsWith('/in.php')) return { status: 200, data: { status: 1, request: 'two-77' } };
      if (request.params?.action === 'get') return { status: 200, data: { status: 1, request: 'two-token' } };
      if (request.params?.action === 'reportbad') return { status: 200, data: { status: 1, request: 'OK_REPORT_RECORDED' } };
      throw new Error(`unexpected ${request.url}`);
    };
    const provider = new providerModule.TwoCaptchaProviderAdapter({
      clientKey: 'two-secret',
      baseURL: 'https://2captcha.test',
      transport,
    });
    const proof = await provider.solve(context, {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    });
    await provider.report(proof, 'bad');

    const form = new URLSearchParams(requests[0].data);
    assert.equal(form.get('pageurl'), context.websiteURL);
    assert.equal(form.get('sitekey'), context.websiteKey);
    assert.equal(form.get('data'), context.rqdata);
    assert.equal(form.get('userAgent'), context.userAgent);
    assert.equal(form.get('proxy'), null);
    assert.equal(proof.taskId, 'two-77');
    assert.equal(requests[2].params.action, 'reportbad');
  } finally {
    if (previousPoll === undefined) delete process.env.CAPTCHA_PROVIDER_POLL_MS;
    else process.env.CAPTCHA_PROVIDER_POLL_MS = previousPoll;
  }
});

test('remote workers reject loopback and private proxies while API proxy remains separate', async () => {
  const providerModule = await loadProvider();
  for (const value of [
    'http://127.0.0.1:10090',
    'http://localhost:8080',
    'http://10.0.0.2:3128',
    'socks5://192.168.1.8:1080',
    'http://[::1]:8080',
  ]) {
    assert.throws(
      () => providerModule.resolveCaptchaWorkerProxy(value),
      /externally reachable|loopback|private/i,
    );
  }
  assert.deepEqual(providerModule.resolveCaptchaWorkerProxy('https://worker.example.com:8443'), {
    protocol: 'https', host: 'worker.example.com', port: 8443,
  });
});

test('abortable provider polling clears its timer immediately on cancellation', async () => {
  const providerModule = await loadProvider();
  const controller = new AbortController();
  const started = Date.now();
  const waiting = providerModule.abortableCaptchaDelay(30_000, controller.signal);
  controller.abort(new Error('cancel-test'));
  await assert.rejects(waiting, /cancel-test/);
  assert.ok(Date.now() - started < 500);
});
