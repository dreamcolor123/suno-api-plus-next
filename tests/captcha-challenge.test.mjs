import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function loadModule(name) {
  const filename = path.join(root, 'src', 'lib', name);
  const source = await readFile(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  new Function('exports', 'module', 'require', '__filename', '__dirname', compiled)(
    module.exports, module, require, filename, path.dirname(filename),
  );
  return module.exports;
}

test('render challenge keeps dynamic rqdata, enterprise payload, URL, and matching UA', async () => {
  const challenge = await loadModule('captcha-challenge.ts');
  const context = challenge.captchaChallengeFromRender({
    sitekey: 'dynamic-site-key',
    rqdata: 'dynamic-rqdata',
    enterprisePayload: { rqdata: 'dynamic-rqdata', sentry: true, token: 'must-not-survive' },
    invisible: true,
  }, 'https://suno.com/create?wid=abc', 'Browser-UA');

  assert.equal(context.schemaVersion, 'suno-hcaptcha-challenge/v1');
  assert.equal(context.websiteKey, 'dynamic-site-key');
  assert.equal(context.rqdata, 'dynamic-rqdata');
  assert.equal(context.userAgent, 'Browser-UA');
  assert.equal(context.websiteURL, 'https://suno.com/create?wid=abc');
  assert.deepEqual(context.enterprisePayload, { rqdata: 'dynamic-rqdata', sentry: true });
});

test('network challenge wins while retaining render-only enterprise data', async () => {
  const challenge = await loadModule('captcha-challenge.ts');
  const render = challenge.captchaChallengeFromRender({
    sitekey: 'render-key',
    enterprisePayload: { sentry: 'safe' },
  }, 'https://suno.com/create', 'Browser-UA');
  const network = challenge.captchaChallengeFromRequest(
    'https://api.hcaptcha.com/getcaptcha/network-key',
    'rqdata=live-request-data&invisible=1',
    'https://suno.com/create',
    'Browser-UA',
  );
  const merged = challenge.mergeCaptchaChallenges(render, network);

  assert.equal(merged.source, 'network');
  assert.equal(merged.websiteKey, 'network-key');
  assert.equal(merged.rqdata, 'live-request-data');
  assert.deepEqual(merged.enterprisePayload, { rqdata: 'live-request-data' });
  assert.deepEqual(challenge.captchaChallengeSummary(merged), {
    schemaVersion: 'suno-hcaptcha-challenge/v1',
    source: 'network',
    hasRqdata: true,
    hasEnterprisePayload: true,
    invisible: true,
  });
});

test('non-hcaptcha traffic and non-Suno website URLs are rejected or normalized', async () => {
  const challenge = await loadModule('captcha-challenge.ts');
  assert.equal(challenge.captchaChallengeFromRequest(
    'https://example.com/getcaptcha/fake',
    'rqdata=nope',
    'https://suno.com/create',
    'UA',
  ), null);
  const fallback = challenge.staticCaptchaChallenge('fixed', 'https://evil.example/path', 'UA');
  assert.equal(fallback.websiteURL, 'https://suno.com/create');
  assert.equal(fallback.source, 'static_fallback');
});

test('verified Suno v1 contract remains distinguishable from blind fallback', async () => {
  const challenge = await loadModule('captcha-challenge.ts');
  const context = challenge.verifiedStaticCaptchaChallenge(
    'fixed-site-key',
    'https://suno.com/create',
    'Chrome-UA',
  );
  assert.equal(context.source, 'verified_static');
  assert.equal(context.websiteKey, 'fixed-site-key');
  assert.equal(context.rqdata, undefined);
  assert.equal(context.enterprisePayload, undefined);
});

test('challenge cache is account scoped and reads do not slide expiry', async () => {
  const challenge = await loadModule('captcha-challenge.ts');
  let now = 1_000;
  const cache = new challenge.CaptchaChallengeCache(10_000, () => now);
  const context = challenge.captchaChallengeFromRender({
    sitekey: 'account-a-key',
    invisible: true,
  }, 'https://suno.com/create', 'Account-A-UA');

  cache.set('account-a', context);
  assert.equal(cache.get('account-b'), null);
  assert.equal(cache.get('account-a').ageMs, 0);

  now = 9_000;
  const nearExpiry = cache.get('account-a');
  assert.equal(nearExpiry.ageMs, 8_000);
  assert.equal(nearExpiry.expiresAt, 11_000);

  // A read at 9 seconds must not renew the fixed 10-second lifetime.
  now = 11_001;
  assert.equal(cache.get('account-a'), null);
});

test('challenge cache invalidation removes only the failed account context', async () => {
  const challenge = await loadModule('captcha-challenge.ts');
  const cache = new challenge.CaptchaChallengeCache(10_000, () => 1_000);
  const first = challenge.staticCaptchaChallenge('first', 'https://suno.com/create', 'UA-A');
  const second = challenge.staticCaptchaChallenge('second', 'https://suno.com/create', 'UA-B');
  cache.set('account-a', first);
  cache.set('account-b', second);

  cache.delete('account-a');
  assert.equal(cache.get('account-a'), null);
  assert.equal(cache.get('account-b').context.websiteKey, 'second');
});
